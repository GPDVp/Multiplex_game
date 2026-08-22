const WebSocket = require('ws');
const express = require('express');
const http = require('http');

// ==================== تنظیمات کلی ====================
const PORT = process.env.PORT || 7000;
const MAX_PLAYERS = 5;
const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;
const TICK_RATE = 30;                       // تعداد تیک سرور در ثانیه
const PING_INTERVAL = 5000;                 // فاصله پینگ/heartbeat سرور (ms)
const STATE_BROADCAST_EVERY_N_TICKS = 15;   // پخش وضعیت کامل برای هماهنگ‌سازی (~هر نیم ثانیه)

// تنظیمات سکه‌ها
const MAX_COINS = 10;                       // حداکثر تعداد سکه هم‌زمان روی نقشه
const COIN_MIN_SPAWN_MS = 1200;             // کمترین فاصله زمانی بین ظاهر شدن سکه‌ها
const COIN_MAX_SPAWN_MS = 2800;             // بیشترین فاصله زمانی (ظاهر شدن شانسی)
const COIN_PADDING = 40;                    // فاصله از لبه نقشه تا محل سکه
const COIN_BONUS_CHANCE = 0.15;             // احتمال سکه‌ی جایزه
const COIN_NORMAL_VALUE = 1;
const COIN_BONUS_VALUE = 5;
const COLLECT_TOLERANCE = 50;               // شعاع مجاز جمع‌آوری سکه در سرور (px)

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
    constructor(id, ws, name) {
        this.id = id;
        this.ws = ws;
        this.name = (name || `Player${id}`).toString().trim().slice(0, 20) || `Player${id}`;
        this.x = MAP_WIDTH / 2 + (Math.random() * 120 - 60);
        this.y = MAP_HEIGHT / 2 + (Math.random() * 120 - 60);
        this.score = 0;
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
        this.x = Math.max(0, Math.min(MAP_WIDTH, x));
        this.y = Math.max(0, Math.min(MAP_HEIGHT, y));
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

// ==================== مدیریت سکه‌ها ====================
function randomCoinPosition() {
    return {
        x: COIN_PADDING + Math.random() * (MAP_WIDTH - COIN_PADDING * 2),
        y: COIN_PADDING + Math.random() * (MAP_HEIGHT - COIN_PADDING * 2)
    };
}

function spawnCoin() {
    if (gameState.coins.size >= MAX_COINS) return;

    const pos = randomCoinPosition();
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

// ظاهر شدن سکه‌ها با فاصله‌ی زمانی شانسی (نه ثابت) تا حس طبیعی‌تری داشته باشد
function scheduleCoinSpawn() {
    const delay = COIN_MIN_SPAWN_MS + Math.random() * (COIN_MAX_SPAWN_MS - COIN_MIN_SPAWN_MS);
    setTimeout(() => {
        spawnCoin();
        scheduleCoinSpawn();
    }, delay);
}

function tryCollectCoin(player, coinId) {
    const coin = gameState.coins.get(coinId);
    if (!coin) return; // یا قبلا جمع شده یا اصلا وجود ندارد

    const dx = player.x - coin.x;
    const dy = player.y - coin.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > COLLECT_TOLERANCE) return; // خیلی دور است، درخواست نامعتبر

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
                const player = new Player(playerId, ws, data.name);
                gameState.players.set(playerId, player);

                player.send({
                    type: 'JOIN_ACCEPTED',
                    playerId: player.id,
                    name: player.name,
                    x: player.x,
                    y: player.y,
                    players: Array.from(gameState.players.values()).map(p => p.toJSON()),
                    coins: Array.from(gameState.coins.values()),
                    mapWidth: MAP_WIDTH,
                    mapHeight: MAP_HEIGHT,
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
    console.log(`🚀 سرور بازی روی پورت ${PORT} اجرا شد (ظرفیت: ${MAX_PLAYERS} بازیکن)`);
    // چند سکه اولیه تا دنیای بازی از همان ابتدا خالی نباشد
    for (let i = 0; i < 4; i++) spawnCoin();
    scheduleCoinSpawn();
});
