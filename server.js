const WebSocket = require('ws');
const express = require('express');
const http = require('http');

// ==================== تنظیمات کلی ====================
const PORT = process.env.PORT || 7000;
const MAX_PLAYERS = 2;                      // مبارزه‌ی رودررو، برای سرعت و روانی بیشتر
const TICK_RATE = 30;                       // تعداد تیک سرور در ثانیه
const PING_INTERVAL = 5000;                 // فاصله پینگ/heartbeat سرور (ms)
const STATE_BROADCAST_EVERY_N_TICKS = 15;   // پخش وضعیت کامل برای هماهنگی (~هر نیم ثانیه)

// نقشه نامحدود است — بازیکنان همیشه نسبت به بازیکن زنده‌ی دیگر (نه یک جعبه‌ی ثابت) موقعیت می‌گیرند.
const PLAYER_SPAWN_NEAR_MIN_DIST = 120;
const PLAYER_SPAWN_NEAR_MAX_DIST = 220;

// تنظیمات سلامتی، ترمیم و بازگشت به بازی
const MAX_HEALTH = 100;
const ATTACK_COOLDOWN_MS = 500;             // باید با attack_cooldown اسکریپت کلاینت (0.5s) هماهنگ باشد
const HEALTH_REGEN_DELAY_MS = 5000;         // بعد از این مدت بدون آسیب دیدن، ترمیم آرام شروع می‌شود
const HEALTH_REGEN_PER_SECOND = 15;         // سرعت ترمیم تدریجی سلامتی (نه یکباره)
const RESPAWN_DELAY_MS = 5000;              // بعد از باخت، این مدت بعد به‌طور خودکار به بازی برمی‌گردد

// دمیج هر ضربه دیگر اینجا تعریف نمی‌شود — طبق درخواست، کاملاً از مقداری که خودِ کلاینت
// (از متغیرهای قابل‌تنظیم در Player.gd) می‌فرستد استفاده می‌شود؛ سرور فقط عدد را معتبر
// (مثبت، محدود به حداکثر سلامتی) می‌کند تا خطا/کرش ایجاد نشود — این اعتبارسنجی، ضدتقلب نیست.
const MAX_SINGLE_HIT_DAMAGE = MAX_HEALTH;

// ==================== تنظیمات دور بازی ====================
const ROUND_DURATION_MS = 2 * 60 * 1000;    // ۲ دقیقه

// ==================== وضعیت بازی ====================
const gameState = {
    players: new Map(),   // playerId -> Player
    nextPlayerId: 1,
    tickCount: 0,
    roundActive: true,
    roundEndsAt: Date.now() + ROUND_DURATION_MS
};

// ==================== کلاس بازیکن ====================
class Player {
    constructor(id, ws, name, spawnPos) {
        this.id = id;
        this.ws = ws;
        this.name = (name || `Player${id}`).toString().trim().slice(0, 20) || `Player${id}`;
        this.x = spawnPos.x;
        this.y = spawnPos.y;
        this.health = MAX_HEALTH;           // به‌صورت داخلی float نگه داشته می‌شود تا ترمیم کاملاً نرم باشد
        this.isDead = false;
        this.deadUntil = 0;
        this.armRotation = 0;               // فقط جنبه‌ی نمایشی (چرخش بازوها) — بدون اثر در منطق بازی
        this.isSliding = false;             // فقط جنبه‌ی نمایشی (افکت ذرات اسلاید) — بدون اثر در منطق بازی
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
            isDead: this.isDead,
            armRotation: Math.round(this.armRotation * 1000) / 1000,
            sliding: this.isSliding,
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

    updatePosition(x, y, armRotation, sliding) {
        if (this.isDead) return false;
        if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) {
            return false;
        }
        this.x = x;
        this.y = y;
        if (typeof armRotation === 'number' && isFinite(armRotation)) {
            this.armRotation = armRotation;
        }
        this.isSliding = !!sliding;
        this.lastUpdate = Date.now();
        return true;
    }
}

// ==================== پخش پیام ====================
function broadcast(data, excludeId = null) {
    const message = JSON.stringify(data);
    gameState.players.forEach((player, id) => {
        if (id !== excludeId && player.ws && player.ws.readyState === WebSocket.OPEN) {
            try { player.ws.send(message); } catch (err) { /* نادیده گرفته می‌شود */ }
        }
    });
}

// ==================== موقعیت‌دهی نسبی به بازیکنان زنده‌ی فعلی ====================
function pickRandomExistingPlayer(excludeId) {
    const arr = Array.from(gameState.players.values()).filter(p => p.id !== excludeId && !p.isDead);
    if (arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomOffset(minDist, maxDist) {
    const angle = Math.random() * Math.PI * 2;
    const dist = minDist + Math.random() * (maxDist - minDist);
    return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
}

function computeSpawnPosition(excludeId, minDist, maxDist) {
    const ref = pickRandomExistingPlayer(excludeId);
    if (!ref) return { x: 0, y: 0 };
    const off = randomOffset(minDist, maxDist);
    return { x: ref.x + off.x, y: ref.y + off.y };
}

// ==================== سیستم ضربه ====================
// طبق درخواست صریح شما: هیچ اعتبارسنجی فاصله‌ی پیکسلی و هیچ جدول دمیج ثابتی روی سرور
// وجود ندارد — تشخیص هدف کاملاً بر عهده‌ی AttackArea‌ای است که خودتان در ادیتور روی
// صحنه‌ی بازیکن تنظیم کرده‌اید، و مقدار دمیج هم دقیقاً همانی است که از متغیرهای
// قابل‌تنظیم در خودِ Player.gd شما ارسال می‌شود. سرور فقط این دو کار پایه (نه ضدتقلب) را
// انجام می‌دهد: (۱) هدف واقعاً وجود دارد/زنده است/خودِ حمله‌کننده نیست، (۲) عدد دمیج
// معتبر است (مثبت و محدود) تا از کرش/NaN جلوگیری شود.
function tryAttack(attacker, requestedTargetId, attackType, rawDamage) {
    if (!gameState.roundActive) return;
    if (attacker.isDead) return;

    const now = Date.now();
    if (now - attacker.lastAttackTime < ATTACK_COOLDOWN_MS) return;
    attacker.lastAttackTime = now;

    if (requestedTargetId === null || requestedTargetId === undefined) {
        // ضربه به هوا خورده (کسی داخل AttackArea نبوده)؛ فقط انیمیشن برای بقیه پخش شود
        broadcast({
            type: 'PLAYER_ATTACKED',
            attackerId: attacker.id,
            targetId: null,
            attackType,
            attackerX: attacker.x,
            attackerY: attacker.y
        });
        return;
    }

    const target = gameState.players.get(requestedTargetId);
    if (!target || target.id === attacker.id || target.isDead) {
        return;
    }

    let damage = Number(rawDamage);
    if (!Number.isFinite(damage) || damage <= 0) damage = 0;
    damage = Math.min(damage, MAX_SINGLE_HIT_DAMAGE);

    target.health = Math.max(0, target.health - damage);
    target.lastDamageTime = now;

    broadcast({
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
        killPlayer(target);
    }
}

function killPlayer(player) {
    player.isDead = true;
    player.health = 0;
    player.deadUntil = Date.now() + RESPAWN_DELAY_MS;
    broadcast({ type: 'PLAYER_DIED', playerId: player.id, respawnInMs: RESPAWN_DELAY_MS });
}

// ==================== ترمیم تدریجی سلامتی + بازگشت خودکار بعد از باخت ====================
function processHealthAndRespawn() {
    const now = Date.now();

    gameState.players.forEach((p) => {
        if (p.isDead) {
            if (now >= p.deadUntil) {
                p.isDead = false;
                p.health = MAX_HEALTH;
                p.lastDamageTime = now;
                const pos = computeSpawnPosition(p.id, PLAYER_SPAWN_NEAR_MIN_DIST, PLAYER_SPAWN_NEAR_MAX_DIST);
                p.x = pos.x;
                p.y = pos.y;
                broadcast({
                    type: 'PLAYER_RESPAWNED',
                    playerId: p.id,
                    x: p.x,
                    y: p.y,
                    health: p.health
                });
            }
            return;
        }

        if (p.health < MAX_HEALTH && now - p.lastDamageTime >= HEALTH_REGEN_DELAY_MS) {
            const regenAmount = HEALTH_REGEN_PER_SECOND / TICK_RATE;
            p.health = Math.min(MAX_HEALTH, p.health + regenAmount);
        }
    });
}

// ==================== دور بازی (۲ دقیقه‌ای) ====================
function getRoundTimeRemainingSeconds() {
    if (!gameState.roundActive) return 0;
    return Math.max(0, (gameState.roundEndsAt - Date.now()) / 1000);
}

function startNewRound() {
    gameState.roundActive = true;
    gameState.roundEndsAt = Date.now() + ROUND_DURATION_MS;

    const playersArr = Array.from(gameState.players.values());
    playersArr.forEach((p) => {
        p.isDead = false;
        p.health = MAX_HEALTH;
        p.lastDamageTime = Date.now();
    });
    playersArr.forEach((p) => {
        const pos = computeSpawnPosition(p.id, PLAYER_SPAWN_NEAR_MIN_DIST, PLAYER_SPAWN_NEAR_MAX_DIST);
        p.x = pos.x;
        p.y = pos.y;
    });

    broadcast({
        type: 'ROUND_STARTED',
        durationMs: ROUND_DURATION_MS,
        players: playersArr.map(p => p.toJSON())
    });
}

function endRound() {
    gameState.roundActive = false;
    broadcast({ type: 'ROUND_ENDED' });
}

function checkRoundEnd() {
    if (gameState.roundActive && Date.now() >= gameState.roundEndsAt) {
        endRound();
    }
}

// ==================== وضعیت کامل بازی (برای هماهنگ‌سازی/اصلاح انحراف) ====================
function broadcastGameState() {
    broadcast({
        type: 'GAME_STATE',
        players: Array.from(gameState.players.values()).map(p => p.toJSON()),
        roundActive: gameState.roundActive,
        roundTimeRemaining: getRoundTimeRemainingSeconds(),
        timestamp: Date.now()
    });
}

// ==================== تیک اصلی سرور ====================
function gameTick() {
    gameState.tickCount++;
    const now = Date.now();

    processHealthAndRespawn();
    checkRoundEnd();

    gameState.players.forEach((player) => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            if (now - player.lastPing > PING_INTERVAL) {
                player.lastPing = now;
                player.send({ type: 'PING', timestamp: now });
            }
        }
    });

    if (gameState.tickCount % STATE_BROADCAST_EVERY_N_TICKS === 0) {
        broadcastGameState();
    }
}

// ==================== سرور HTTP و WebSocket ====================
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        players: gameState.players.size,
        maxPlayers: MAX_PLAYERS,
        roundActive: gameState.roundActive,
        roundTimeRemaining: getRoundTimeRemainingSeconds(),
        uptime: process.uptime()
    });
});

app.get('/status', (req, res) => {
    res.json({
        players: Array.from(gameState.players.values()).map(p => p.toJSON()),
        totalPlayers: gameState.players.size,
        maxPlayers: MAX_PLAYERS,
        roundActive: gameState.roundActive,
        roundTimeRemaining: getRoundTimeRemainingSeconds(),
        tick: gameState.tickCount
    });
});

wss.on('connection', (ws) => {
    let playerId = null;

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
                if (playerId !== null) return; // قبلا جوین شده

                if (gameState.players.size >= MAX_PLAYERS) {
                    ws.send(JSON.stringify({
                        type: 'JOIN_REJECTED',
                        reason: 'ظرفیت سرور تکمیل است (حداکثر ۲ بازیکن)'
                    }));
                    ws.close(1008, 'Server full');
                    return;
                }

                playerId = gameState.nextPlayerId++;
                const spawnPos = computeSpawnPosition(null, PLAYER_SPAWN_NEAR_MIN_DIST, PLAYER_SPAWN_NEAR_MAX_DIST);
                const player = new Player(playerId, ws, data.name, spawnPos);
                gameState.players.set(playerId, player);

                player.send({
                    type: 'JOIN_ACCEPTED',
                    playerId: player.id,
                    name: player.name,
                    x: player.x,
                    y: player.y,
                    health: player.health,
                    roundActive: gameState.roundActive,
                    roundTimeRemaining: getRoundTimeRemainingSeconds(),
                    players: Array.from(gameState.players.values()).map(p => p.toJSON()),
                    maxPlayers: MAX_PLAYERS
                });

                broadcast({ type: 'PLAYER_JOINED', player: player.toJSON() }, playerId);
                break;
            }

            case 'MOVE': {
                if (playerId === null) return;
                if (!gameState.roundActive) return;
                const player = gameState.players.get(playerId);
                if (!player) return;
                if (player.updatePosition(data.x, data.y, data.armRotation, data.sliding)) {
                    broadcast({
                        type: 'PLAYER_MOVED',
                        playerId: player.id,
                        x: player.x,
                        y: player.y,
                        armRotation: player.armRotation,
                        sliding: player.isSliding
                    }, playerId);
                }
                break;
            }

            case 'ATTACK': {
                if (playerId === null) return;
                const player = gameState.players.get(playerId);
                if (!player) return;
                const targetIdRaw = data.targetId;
                const targetId = (targetIdRaw !== undefined && targetIdRaw !== null) ? Number(targetIdRaw) : null;
                const attackType = typeof data.attackType === 'string' ? data.attackType.slice(0, 20) : 'front';
                tryAttack(player, Number.isFinite(targetId) ? targetId : null, attackType, data.damage);
                break;
            }

            case 'RESTART_ROUND': {
                if (playerId === null) return;
                if (gameState.roundActive) return; // دوری در حال اجراست، نیازی به شروع مجدد نیست
                startNewRound();
                break;
            }

            case 'PING': {
                if (playerId === null) return;
                const player = gameState.players.get(playerId);
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
        if (playerId !== null && gameState.players.has(playerId)) {
            const player = gameState.players.get(playerId);
            gameState.players.delete(playerId);
            broadcast({ type: 'PLAYER_LEFT', playerId: player.id });
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
    broadcast({ type: 'SERVER_SHUTDOWN', message: 'سرور در حال خاموش شدن است' });
    wss.clients.forEach((client) => client.close(1000, 'Server shutting down'));
    server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

server.listen(PORT, () => {
    console.log(`🚀 سرور بازی روی پورت ${PORT} اجرا شد (ظرفیت: ${MAX_PLAYERS} بازیکن، دور ${ROUND_DURATION_MS / 60000} دقیقه‌ای)`);
});
