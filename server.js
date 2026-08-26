const WebSocket = require('ws');
const express = require('express');
const http = require('http');

// ==================== تنظیمات کلی ====================
const PORT = process.env.PORT || 7000;
const MAX_PLAYERS_PER_ROOM = 2;             // هر روم دقیقاً یک مبارزه‌ی رودررو است
const TICK_RATE = 30;                       // تعداد تیک سرور در ثانیه
const PING_INTERVAL = 5000;                 // فاصله پینگ/heartbeat سرور (ms)
const STATE_BROADCAST_EVERY_N_TICKS = 15;   // پخش وضعیت کامل برای هماهنگی (~هر نیم ثانیه)

const PLAYER_SPAWN_NEAR_MIN_DIST = 120;
const PLAYER_SPAWN_NEAR_MAX_DIST = 220;

const MAX_HEALTH = 100;
const ATTACK_COOLDOWN_MS = 500;             // باید با attack_cooldown اسکریپت کلاینت (0.5s) هماهنگ باشد
const HEALTH_REGEN_DELAY_MS = 5000;         // بعد از این مدت بدون آسیب دیدن، ترمیم آرام شروع می‌شود
const HEALTH_REGEN_PER_SECOND = 15;         // سرعت ترمیم تدریجی سلامتی (نه یکباره)
const MAX_SINGLE_HIT_DAMAGE = MAX_HEALTH;   // فقط اعتبارسنجی پایه (نه ضدتقلب) تا عدد نامعتبر کرش نکند

const ROUND_DURATION_MS = 4 * 60 * 1000;    // ۴ دقیقه

// ==================== مدیریت روم‌ها (matchmaking خودکار ۲نفره) ====================
// هر بار کسی JOIN می‌فرستد: اگر یک روم با دقیقاً ۱ بازیکن منتظر وجود داشته باشد،
// به همان اضافه می‌شود (و بلافاصله دور شروع می‌شود)؛ در غیر این صورت یک روم تازه
// برایش ساخته می‌شود و منتظر حریف بعدی می‌ماند. هر روم کاملاً مستقل است — نقشه،
// سلامتی، تایمر دور و پیام‌ها هرگز بین روم‌های مختلف مخلوط نمی‌شوند.
class Room {
    constructor(id) {
        this.id = id;
        this.players = new Map(); // playerId -> Player
        this.roundActive = false;
        this.roundEndsAt = 0;
    }
}

const rooms = new Map(); // roomId -> Room
let nextRoomId = 1;
let nextPlayerId = 1;
let serverTickCount = 0;

function findWaitingRoom() {
    for (const room of rooms.values()) {
        if (room.players.size === 1) return room;
    }
    return null;
}

function getOrCreateRoomForNewPlayer() {
    const waiting = findWaitingRoom();
    if (waiting) return waiting;
    const room = new Room(nextRoomId++);
    rooms.set(room.id, room);
    return room;
}

function getRoomTimeRemainingSeconds(room) {
    if (!room.roundActive) return 0;
    return Math.max(0, (room.roundEndsAt - Date.now()) / 1000);
}

// ==================== کلاس بازیکن ====================
class Player {
    constructor(id, ws, name, spawnPos) {
        this.id = id;
        this.ws = ws;
        this.room = null;
        this.name = (name || `Player${id}`).toString().trim().slice(0, 20) || `Player${id}`;
        this.x = spawnPos.x;
        this.y = spawnPos.y;
        this.health = MAX_HEALTH;           // به‌صورت داخلی float نگه داشته می‌شود تا ترمیم کاملاً نرم باشد
        this.armRotation = 0;               // فقط جنبه‌ی نمایشی (چرخش بازوها)
        this.isSliding = false;             // فقط جنبه‌ی نمایشی (افکت ذرات اسلاید)
        this.legAnim = 'RESET';             // فقط جنبه‌ی نمایشی (انیمیشن دقیق پا: RESET/run/jump)
        this.legSpeed = 1.0;                // فقط جنبه‌ی نمایشی (سرعت پخش انیمیشن پا)
        this.facing = 1;                    // فقط جنبه‌ی نمایشی (جهت دقیق مدل: ۱ یا -۱)
        this.lastAttackTime = 0;
        this.lastDamageTime = 0;
        this.lastUpdate = Date.now();
        this.lastPing = Date.now();
        this.ping = 0;
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            x: Math.round(this.x * 100) / 100,
            y: Math.round(this.y * 100) / 100,
            health: Math.round(this.health),
            armRotation: Math.round(this.armRotation * 1000) / 1000,
            sliding: this.isSliding,
            legAnim: this.legAnim,
            legSpeed: Math.round(this.legSpeed * 100) / 100,
            facing: this.facing,
            ping: this.ping
        };
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(data));
                return true;
            } catch (err) {
                return false;
            }
        }
        return false;
    }

    updatePosition(x, y, armRotation, sliding, legAnim, legSpeed, facing) {
        if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) {
            return false;
        }
        this.x = x;
        this.y = y;
        if (typeof armRotation === 'number' && isFinite(armRotation)) {
            this.armRotation = armRotation;
        }
        this.isSliding = !!sliding;
        if (typeof legAnim === 'string' && legAnim.length > 0 && legAnim.length <= 20) {
            this.legAnim = legAnim;
        }
        if (typeof legSpeed === 'number' && isFinite(legSpeed) && legSpeed > 0) {
            this.legSpeed = Math.min(legSpeed, 5);
        }
        if (typeof facing === 'number' && isFinite(facing) && facing !== 0) {
            this.facing = facing;
        }
        this.lastUpdate = Date.now();
        return true;
    }
}

// ==================== پخش پیام (فقط داخل همان روم) ====================
function broadcast(room, data, excludeId = null) {
    const message = JSON.stringify(data);
    room.players.forEach((player, id) => {
        if (id !== excludeId && player.ws && player.ws.readyState === WebSocket.OPEN) {
            try { player.ws.send(message); } catch (err) { /* نادیده گرفته می‌شود */ }
        }
    });
}

// ==================== موقعیت‌دهی نسبی به بازیکنِ دیگرِ همان روم ====================
function pickOtherPlayerInRoom(room, excludeId) {
    const arr = Array.from(room.players.values()).filter(p => p.id !== excludeId);
    if (arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomOffset(minDist, maxDist) {
    const angle = Math.random() * Math.PI * 2;
    const dist = minDist + Math.random() * (maxDist - minDist);
    return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
}

function computeSpawnPosition(room, excludeId, minDist, maxDist) {
    const ref = pickOtherPlayerInRoom(room, excludeId);
    if (!ref) return { x: 0, y: 0 };
    const off = randomOffset(minDist, maxDist);
    return { x: ref.x + off.x, y: ref.y + off.y };
}

// ==================== سیستم ضربه ====================
// طبق درخواست صریح شما: هیچ اعتبارسنجی فاصله‌ی پیکسلی و هیچ جدول دمیج ثابتی روی سرور
// وجود ندارد — تشخیص هدف کاملاً بر عهده‌ی AttackArea‌ای است که خودتان در ادیتور روی
// صحنه‌ی بازیکن تنظیم کرده‌اید، و مقدار دمیج هم دقیقاً همانی است که از متغیرهای
// قابل‌تنظیم در خودِ Player.gd شما ارسال می‌شود.
function tryAttack(room, attacker, requestedTargetId, attackType, rawDamage) {
    if (!room.roundActive) return;

    const now = Date.now();
    if (now - attacker.lastAttackTime < ATTACK_COOLDOWN_MS) return;
    attacker.lastAttackTime = now;

    if (requestedTargetId === null || requestedTargetId === undefined) {
        // ضربه به هوا خورده (کسی داخل AttackArea نبوده)؛ فقط انیمیشن برای حریف پخش شود
        broadcast(room, {
            type: 'PLAYER_ATTACKED',
            attackerId: attacker.id,
            targetId: null,
            attackType,
            attackerX: attacker.x,
            attackerY: attacker.y
        });
        return;
    }

    // هدف باید دقیقاً در همین روم باشد — room.players فقط همین ۲ نفر را دارد،
    // پس جست‌وجو در روم‌های دیگر اصلاً امکان‌پذیر نیست (ایزوله‌سازی خودکار).
    const target = room.players.get(requestedTargetId);
    if (!target || target.id === attacker.id) return;

    let damage = Number(rawDamage);
    if (!Number.isFinite(damage) || damage <= 0) damage = 0;
    damage = Math.min(damage, MAX_SINGLE_HIT_DAMAGE);

    target.health = Math.max(0, target.health - damage);
    target.lastDamageTime = now;

    broadcast(room, {
        type: 'PLAYER_ATTACKED',
        attackerId: attacker.id,
        targetId: target.id,
        attackType,
        damage,
        targetHealth: Math.round(target.health),
        attackerX: attacker.x,
        attackerY: attacker.y,
        targetX: target.x,
        targetY: target.y
    });

    if (target.health <= 0) {
        endRoundWithWinner(room, attacker, target);
    }
}

// ==================== پایان دور با برنده/بازنده مشخص ====================
function endRoundWithWinner(room, winner, loser) {
    room.roundActive = false;
    broadcast(room, {
        type: 'ROUND_ENDED',
        reason: 'defeat',
        winnerId: winner.id,
        loserId: loser.id
    });
}

function endRoundByTimeout(room) {
    room.roundActive = false;
    broadcast(room, { type: 'ROUND_ENDED', reason: 'timeout' });
}

function checkRoundEnd(room) {
    if (room.roundActive && Date.now() >= room.roundEndsAt) {
        endRoundByTimeout(room);
    }
}

function startNewRound(room) {
    if (room.players.size < MAX_PLAYERS_PER_ROOM) return; // بدون حریف نمی‌توان دوباره شروع کرد

    room.roundActive = true;
    room.roundEndsAt = Date.now() + ROUND_DURATION_MS;

    const arr = Array.from(room.players.values());
    arr.forEach((p) => {
        p.health = MAX_HEALTH;
        p.lastDamageTime = Date.now();
    });
    arr.forEach((p) => {
        const pos = computeSpawnPosition(room, p.id, PLAYER_SPAWN_NEAR_MIN_DIST, PLAYER_SPAWN_NEAR_MAX_DIST);
        p.x = pos.x;
        p.y = pos.y;
    });

    broadcast(room, {
        type: 'ROUND_STARTED',
        durationMs: ROUND_DURATION_MS,
        players: arr.map(p => p.toJSON())
    });
}

// ==================== ترمیم تدریجی سلامتی (فقط در دور فعال) ====================
function processHealthRegen(room) {
    if (!room.roundActive) return;
    const now = Date.now();
    room.players.forEach((p) => {
        if (p.health < MAX_HEALTH && now - p.lastDamageTime >= HEALTH_REGEN_DELAY_MS) {
            const regenAmount = HEALTH_REGEN_PER_SECOND / TICK_RATE;
            p.health = Math.min(MAX_HEALTH, p.health + regenAmount);
        }
    });
}

// ==================== وضعیت کامل یک روم (برای هماهنگ‌سازی/اصلاح انحراف) ====================
function broadcastGameState(room) {
    broadcast(room, {
        type: 'GAME_STATE',
        players: Array.from(room.players.values()).map(p => p.toJSON()),
        roundActive: room.roundActive,
        roundTimeRemaining: getRoomTimeRemainingSeconds(room),
        timestamp: Date.now()
    });
}

// ==================== تیک اصلی سرور (روی همه‌ی روم‌ها) ====================
function gameTick() {
    serverTickCount++;
    const now = Date.now();

    rooms.forEach((room) => {
        processHealthRegen(room);
        checkRoundEnd(room);

        room.players.forEach((player) => {
            if (player.ws && player.ws.readyState === WebSocket.OPEN) {
                if (now - player.lastPing > PING_INTERVAL) {
                    player.lastPing = now;
                    player.send({ type: 'PING', timestamp: now });
                }
            }
        });
    });

    if (serverTickCount % STATE_BROADCAST_EVERY_N_TICKS === 0) {
        rooms.forEach((room) => {
            if (room.players.size > 0) {
                broadcastGameState(room);
            }
        });
    }
}

// ==================== سرور HTTP و WebSocket ====================
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

app.use(express.json());

app.get('/health', (req, res) => {
    let totalPlayers = 0;
    let activeMatches = 0;
    rooms.forEach((r) => {
        totalPlayers += r.players.size;
        if (r.players.size === MAX_PLAYERS_PER_ROOM) activeMatches++;
    });
    res.json({
        status: 'OK',
        totalPlayers,
        totalRooms: rooms.size,
        activeMatches,
        uptime: process.uptime()
    });
});

app.get('/status', (req, res) => {
    const roomsInfo = Array.from(rooms.values()).map((r) => ({
        id: r.id,
        players: Array.from(r.players.values()).map(p => p.toJSON()),
        roundActive: r.roundActive,
        roundTimeRemaining: getRoomTimeRemainingSeconds(r)
    }));
    res.json({ rooms: roomsInfo, totalRooms: rooms.size, tick: serverTickCount });
});

wss.on('connection', (ws) => {
    let player = null; // نمونه‌ی واقعی Player این اتصال (نه فقط شناسه) برای دسترسی مستقیم به room

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            return; // پیام نامعتبر، نادیده گرفته می‌شود
        }
        if (!data || typeof data.type !== 'string') return;

        switch (data.type) {

            case 'JOIN': {
                if (player !== null) return; // قبلا جوین شده

                const room = getOrCreateRoomForNewPlayer();
                const newId = nextPlayerId++;
                const spawnPos = computeSpawnPosition(room, null, PLAYER_SPAWN_NEAR_MIN_DIST, PLAYER_SPAWN_NEAR_MAX_DIST);

                player = new Player(newId, ws, data.name, spawnPos);
                player.room = room;
                room.players.set(newId, player);

                const roomFull = room.players.size === MAX_PLAYERS_PER_ROOM;
                if (roomFull) {
                    room.roundActive = true;
                    room.roundEndsAt = Date.now() + ROUND_DURATION_MS;
                }

                player.send({
                    type: 'JOIN_ACCEPTED',
                    playerId: player.id,
                    name: player.name,
                    x: player.x,
                    y: player.y,
                    health: player.health,
                    waitingForOpponent: !roomFull,
                    roundActive: room.roundActive,
                    roundTimeRemaining: getRoomTimeRemainingSeconds(room),
                    players: Array.from(room.players.values()).map(p => p.toJSON()),
                    maxPlayers: MAX_PLAYERS_PER_ROOM
                });

                if (roomFull) {
                    // بازیکنی که قبلاً منتظر بود، الان هم صاحب حریف تازه شده هم دورش شروع می‌شود
                    const other = Array.from(room.players.values()).find(p => p.id !== player.id);
                    if (other) {
                        other.send({ type: 'PLAYER_JOINED', player: player.toJSON() });
                        other.send({
                            type: 'ROUND_STARTED',
                            durationMs: ROUND_DURATION_MS,
                            players: Array.from(room.players.values()).map(p => p.toJSON())
                        });
                    }
                }
                break;
            }

            case 'MOVE': {
                if (!player) return;
                const room = player.room;
                if (!room || !room.roundActive) return;
                if (player.updatePosition(data.x, data.y, data.armRotation, data.sliding, data.legAnim, data.legSpeed, data.facing)) {
                    broadcast(room, {
                        type: 'PLAYER_MOVED',
                        playerId: player.id,
                        x: player.x,
                        y: player.y,
                        armRotation: player.armRotation,
                        sliding: player.isSliding,
                        legAnim: player.legAnim,
                        legSpeed: player.legSpeed,
                        facing: player.facing
                    }, player.id);
                }
                break;
            }

            case 'ATTACK': {
                if (!player) return;
                const room = player.room;
                if (!room) return;
                const targetIdRaw = data.targetId;
                const targetId = (targetIdRaw !== undefined && targetIdRaw !== null) ? Number(targetIdRaw) : null;
                const attackType = typeof data.attackType === 'string' ? data.attackType.slice(0, 20) : 'front';
                tryAttack(room, player, Number.isFinite(targetId) ? targetId : null, attackType, data.damage);
                break;
            }

            case 'RESTART_ROUND': {
                if (!player) return;
                const room = player.room;
                if (!room || room.roundActive) return;
                startNewRound(room);
                break;
            }

            case 'PING': {
                if (!player) return;
                const now = Date.now();
                const ts = typeof data.timestamp === 'number' ? data.timestamp : now;
                player.ping = Math.max(0, Math.min(999, Math.round(now - ts)));
                player.send({ type: 'PONG', timestamp: now, ping: player.ping });
                break;
            }

            default:
                break;
        }
    });

    ws.on('close', () => {
        ws.isAlive = false;
        if (player) {
            const room = player.room;
            if (room && room.players.has(player.id)) {
                room.players.delete(player.id);
                broadcast(room, { type: 'PLAYER_LEFT', playerId: player.id });

                if (room.players.size === 0) {
                    rooms.delete(room.id);
                } else {
                    // حریف باقی‌مانده باید صبر کند تا بازیکن تازه‌ای به همین روم اضافه شود
                    room.roundActive = false;
                    broadcast(room, { type: 'WAITING_FOR_OPPONENT' });
                }
            }
        }
    });

    ws.on('error', () => { /* نادیده گرفته می‌شود، close رخ خواهد داد */ });
});

// بررسی دوره‌ای سلامت اتصالات (heartbeat) - قطع خودکار سوکت‌های مرده
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, PING_INTERVAL);

const tickInterval = setInterval(gameTick, 1000 / TICK_RATE);

process.on('SIGINT', () => {
    clearInterval(heartbeatInterval);
    clearInterval(tickInterval);
    rooms.forEach((room) => broadcast(room, { type: 'SERVER_SHUTDOWN', message: 'سرور در حال خاموش شدن است' }));
    wss.clients.forEach((client) => client.close(1000, 'Server shutting down'));
    server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

server.listen(PORT, () => {
    console.log(`🚀 سرور بازی روی پورت ${PORT} اجرا شد (روم‌بندی خودکار ۲نفره، دور ${ROUND_DURATION_MS / 60000} دقیقه‌ای)`);
});
