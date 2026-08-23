const WebSocket = require('ws');
const express = require('express');
const http = require('http');

// ==================== تنظیمات کلی ====================
const PORT = process.env.PORT || 7000;
const MAX_PLAYERS = 5;
const TICK_RATE = 30;                       // تعداد تیک سرور در ثانیه
const PING_INTERVAL = 5000;                 // فاصله پینگ/heartbeat سرور (ms)
const STATE_BROADCAST_EVERY_N_TICKS = 15;   // پخش وضعیت کامل برای هماهنگی (~هر نیم ثانیه)

// نقشه نامحدود است — هیچ محدودیتی برای x/y وجود ندارد.
// بازیکنان و سکه‌ها همیشه نسبت به بازیکنان فعلی (نه یک جعبه‌ی ثابت) موقعیت‌دهی می‌شوند.

// تنظیمات سکه‌ها
const MAX_COINS = 10;
const COIN_MIN_SPAWN_MS = 1200;
const COIN_MAX_SPAWN_MS = 2800;
const COIN_NEAR_MIN_DIST = 120;             // حداقل فاصله‌ی سکه از بازیکن مرجع
const COIN_NEAR_MAX_DIST = 320;             // حداکثر فاصله (فاصله‌ی نسبتاً زیاد طبق درخواست)
const COIN_BONUS_CHANCE = 0.15;
const COIN_NORMAL_VALUE = 1;
const COIN_BONUS_VALUE = 5;
const COLLECT_TOLERANCE = 50;               // شعاع مجاز جمع‌آوری سکه در سرور (px)

// تنظیمات اسپاون بازیکن (بازیکنان نزدیک هم ظاهر می‌شوند)
const PLAYER_SPAWN_NEAR_MIN_DIST = 70;
const PLAYER_SPAWN_NEAR_MAX_DIST = 160;

// تنظیمات سلامتی و ضربه
const MAX_HEALTH = 100;
const ATTACK_DAMAGE = 20;
const ATTACK_RANGE = 75;                    // شعاع مؤثر ضربه (باید با اندازه AttackArea کلاینت هم‌خوان باشد)
const ATTACK_COOLDOWN_MS = 600;

// ==================== وضعیت بازی ====================
const gameState = {
    players: new Map(),   // playerId -> Player
    coins: new Map(),     // coinId   -> {id,x,y,value}
    nextPlayerId: 1,
    nextCoinId: 1,
    tickCount: 0
};

// ==================== کلاس بازیکن ====================
class Player {
    constructor(id, ws, name, spawnPos) {
        this.id = id;
        this.ws = ws;
        this.name = (name || `Player${id}`).toString().trim().slice(0, 20) || `Player${id}`;
        this.x = spawnPos.x;
        this.y = spawnPos.y;
        this.score = 0;
        this.health = MAX_HEALTH;
        this.lastAttackTime = 0;
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
            score: this.score,
            health: this.health,
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

    updatePosition(x, y) {
        if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) {
            return false;
        }
        this.x = x;
        this.y = y;
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

// ==================== موقعیت‌دهی نسبی به بازیکنان فعلی (چون نقشه نامحدود است) ====================
function pickRandomExistingPlayer() {
    if (gameState.players.size === 0) return null;
    const arr = Array.from(gameState.players.values());
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomOffset(minDist, maxDist) {
    const angle = Math.random() * Math.PI * 2;
    const dist = minDist + Math.random() * (maxDist - minDist);
    return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
}

function spawnPositionForNewPlayer() {
    const ref = pickRandomExistingPlayer();
    if (!ref) return { x: 0, y: 0 }; // اولین بازیکن، مبدأ دنیای بازی
    const off = randomOffset(PLAYER_SPAWN_NEAR_MIN_DIST, PLAYER_SPAWN_NEAR_MAX_DIST);
    return { x: ref.x + off.x, y: ref.y + off.y };
}

function spawnPositionForCoin() {
    const ref = pickRandomExistingPlayer();
    if (!ref) return { x: 0, y: 0 };
    const off = randomOffset(COIN_NEAR_MIN_DIST, COIN_NEAR_MAX_DIST);
    return { x: ref.x + off.x, y: ref.y + off.y };
}

// ==================== مدیریت سکه‌ها ====================
function spawnCoin() {
    if (gameState.coins.size >= MAX_COINS) return;
    if (gameState.players.size === 0) return; // بدون بازیکن، سکه لازم نیست ظاهر شود

    const pos = spawnPositionForCoin();
    const isBonus = Math.random() < COIN_BONUS_CHANCE;
    const coin = {
        id: gameState.nextCoinId++,
        x: Math.round(pos.x * 100) / 100,
        y: Math.round(pos.y * 100) / 100,
        value: isBonus ? COIN_BONUS_VALUE : COIN_NORMAL_VALUE
    };

    gameState.coins.set(coin.id, coin);
    broadcast({ type: 'COIN_SPAWNED', coin });
}

function scheduleCoinSpawn() {
    const delay = COIN_MIN_SPAWN_MS + Math.random() * (COIN_MAX_SPAWN_MS - COIN_MIN_SPAWN_MS);
    setTimeout(() => {
        spawnCoin();
        scheduleCoinSpawn();
    }, delay);
}

function tryCollectCoin(player, coinId) {
    const coin = gameState.coins.get(coinId);
    if (!coin) return;

    const dx = player.x - coin.x;
    const dy = player.y - coin.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > COLLECT_TOLERANCE) return;

    gameState.coins.delete(coinId);
    player.score += coin.value;

    broadcast({
        type: 'COIN_COLLECTED',
        coinId: coin.id,
        playerId: player.id,
        playerName: player.name,
        value: coin.value,
        score: player.score
    });
}

// ==================== سیستم ضربه و سلامتی ====================
function tryAttack(attacker) {
    const now = Date.now();
    if (now - attacker.lastAttackTime < ATTACK_COOLDOWN_MS) return;
    attacker.lastAttackTime = now;

    let target = null;
    let bestDist = Infinity;

    gameState.players.forEach((p) => {
        if (p.id === attacker.id) return;
        const dx = p.x - attacker.x;
        const dy = p.y - attacker.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= ATTACK_RANGE && dist < bestDist) {
            bestDist = dist;
            target = p;
        }
    });

    if (!target) {
        // ضربه به هوا خورده؛ فقط انیمیشن حمله برای بقیه پخش شود
        broadcast({
            type: 'PLAYER_ATTACKED',
            attackerId: attacker.id,
            targetId: null,
            attackerX: attacker.x,
            attackerY: attacker.y
        });
        return;
    }

    target.health = Math.max(0, target.health - ATTACK_DAMAGE);

    broadcast({
        type: 'PLAYER_ATTACKED',
        attackerId: attacker.id,
        targetId: target.id,
        targetHealth: target.health,
        attackerX: attacker.x,
        attackerY: attacker.y,
        targetX: target.x,
        targetY: target.y
    });

    if (target.health <= 0) {
        defeatPlayer(target);
    }
}

function defeatPlayer(player) {
    gameState.players.delete(player.id);

    // به بقیه اطلاع بده که این بازیکن از بازی حذف شد (بدون ارسال به خود بازیکن باخته)
    broadcast({ type: 'PLAYER_DEFEATED', playerId: player.id }, player.id);

    // به خود بازیکن باخته پیام اختصاصی بده
    player.send({ type: 'YOU_LOST', message: 'شما باختید! حریف شما را شکست داد.' });

    // کمی مهلت برای رسیدن پیام، سپس اتصال را تمیز ببند تا کلاینت وارد چرخه‌ی «بازی دوباره» شود
    setTimeout(() => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ws.close(1000, 'defeated');
        }
    }, 400);
}

// ==================== وضعیت کامل بازی (برای هماهنگ‌سازی/اصلاح انحراف) ====================
function broadcastGameState() {
    broadcast({
        type: 'GAME_STATE',
        players: Array.from(gameState.players.values()).map(p => p.toJSON()),
        coins: Array.from(gameState.coins.values()),
        timestamp: Date.now()
    });
}

// ==================== تیک اصلی سرور ====================
function gameTick() {
    gameState.tickCount++;
    const now = Date.now();

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
        coins: gameState.coins.size,
        uptime: process.uptime()
    });
});

app.get('/status', (req, res) => {
    res.json({
        players: Array.from(gameState.players.values()).map(p => p.toJSON()),
        coins: Array.from(gameState.coins.values()),
        totalPlayers: gameState.players.size,
        maxPlayers: MAX_PLAYERS,
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
                        reason: 'ظرفیت سرور تکمیل است (حداکثر ۵ بازیکن)'
                    }));
                    ws.close(1008, 'Server full');
                    return;
                }

                playerId = gameState.nextPlayerId++;
                const spawnPos = spawnPositionForNewPlayer();
                const player = new Player(playerId, ws, data.name, spawnPos);
                gameState.players.set(playerId, player);

                player.send({
                    type: 'JOIN_ACCEPTED',
                    playerId: player.id,
                    name: player.name,
                    x: player.x,
                    y: player.y,
                    health: player.health,
                    players: Array.from(gameState.players.values()).map(p => p.toJSON()),
                    coins: Array.from(gameState.coins.values()),
                    maxPlayers: MAX_PLAYERS
                });

                broadcast({ type: 'PLAYER_JOINED', player: player.toJSON() }, playerId);
                break;
            }

            case 'MOVE': {
                if (playerId === null) return;
                const player = gameState.players.get(playerId);
                if (!player) return;
                if (player.updatePosition(data.x, data.y)) {
                    broadcast({ type: 'PLAYER_MOVED', playerId: player.id, x: player.x, y: player.y }, playerId);
                }
                break;
            }

            case 'COLLECT_COIN': {
                if (playerId === null) return;
                const player = gameState.players.get(playerId);
                if (!player) return;
                const coinId = Number(data.coinId);
                if (!Number.isFinite(coinId)) return;
                tryCollectCoin(player, coinId);
                break;
            }

            case 'ATTACK': {
                if (playerId === null) return;
                const player = gameState.players.get(playerId);
                if (!player) return;
                tryAttack(player);
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
    console.log(`🚀 سرور بازی روی پورت ${PORT} اجرا شد (ظرفیت: ${MAX_PLAYERS} بازیکن، نقشه‌ی نامحدود)`);
    scheduleCoinSpawn();
});
