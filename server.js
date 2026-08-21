// ============================================================
//  server.js - سرور Node.js کامل با پایداری بالا
// ============================================================

const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ===== تنظیمات =====
const PORT = process.env.PORT || 7000;
const MAX_PLAYERS = 50;
const COINS_COUNT = 30;
const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;
const TICK_RATE = 30; // 30 بار در ثانیه
const PING_INTERVAL = 5000; // 5 ثانیه
const CONNECTION_TIMEOUT = 10000; // 10 ثانیه

// ===== وضعیت بازی =====
const gameState = {
    players: new Map(),
    coins: [],
    gameStarted: false,
    nextPlayerId: 1,
    startTime: 0,
    tickCount: 0
};

// ===== ابزارهای کمکی =====
function log(type, message, data = null) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${type}]`;
    if (data) {
        console.log(`${prefix} ${message}`, data);
    } else {
        console.log(`${prefix} ${message}`);
    }
}

function generateId() {
    return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

// ===== ایجاد سکه‌ها =====
function createCoins() {
    gameState.coins = [];
    for (let i = 0; i < COINS_COUNT; i++) {
        gameState.coins.push({
            id: generateId(),
            x: 30 + Math.random() * (MAP_WIDTH - 60),
            y: 30 + Math.random() * (MAP_HEIGHT - 60),
            collected: false,
            respawnTimer: 0
        });
    }
    log('INFO', `🪙 ${COINS_COUNT} coins created`);
}
createCoins();

// ===== کلاس بازیکن =====
class Player {
    constructor(id, ws, name) {
        this.id = id;
        this.ws = ws;
        this.name = name || `Player${id}`;
        this.x = 100 + Math.random() * (MAP_WIDTH - 200);
        this.y = 100 + Math.random() * (MAP_HEIGHT - 200);
        this.score = 0;
        this.ready = false;
        this.isAlive = true;
        this.lastUpdate = Date.now();
        this.lastPing = Date.now();
        this.ping = 0;
        this.connected = true;
        this.messageQueue = [];
        this.room = 'main';
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            x: this.x,
            y: this.y,
            score: this.score,
            ready: this.ready,
            isAlive: this.isAlive,
            ping: this.ping
        };
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(data));
                return true;
            } catch (error) {
                log('ERROR', `Send error to player ${this.id}:`, error.message);
                return false;
            }
        }
        return false;
    }

    updatePosition(x, y) {
        if (x >= 0 && x <= MAP_WIDTH && y >= 0 && y <= MAP_HEIGHT) {
            this.x = x;
            this.y = y;
            this.lastUpdate = Date.now();
            return true;
        }
        return false;
    }
}

// ===== مدیریت پیام‌ها =====
function broadcast(data, excludeId = null) {
    const message = JSON.stringify(data);
    let sentCount = 0;
    gameState.players.forEach((player, id) => {
        if (id !== excludeId && player.ws && player.ws.readyState === WebSocket.OPEN) {
            try {
                player.ws.send(message);
                sentCount++;
            } catch (error) {
                log('ERROR', `Broadcast error to ${id}:`, error.message);
            }
        }
    });
    return sentCount;
}

function sendToPlayer(playerId, data) {
    const player = gameState.players.get(playerId);
    if (player) {
        return player.send(data);
    }
    return false;
}

// ===== به‌روزرسانی وضعیت =====
function updateGameState() {
    const playersData = Array.from(gameState.players.values()).map(p => p.toJSON());
    const coinsData = gameState.coins
        .filter(c => !c.collected)
        .map(c => ({ id: c.id, x: c.x, y: c.y }));

    const state = {
        type: 'GAME_STATE',
        players: playersData,
        coins: coinsData,
        gameStarted: gameState.gameStarted,
        timestamp: Date.now()
    };

    const sent = broadcast(state);
    log('DEBUG', `📊 Game state sent to ${sent} players`);
}

// ===== بررسی شروع بازی =====
function checkGameStart() {
    const players = Array.from(gameState.players.values());
    const readyPlayers = players.filter(p => p.ready && p.isAlive);
    
    if (readyPlayers.length >= 2 && !gameState.gameStarted) {
        gameState.gameStarted = true;
        gameState.startTime = Date.now();
        broadcast({
            type: 'GAME_START',
            timestamp: Date.now(),
            players: readyPlayers.length
        });
        log('GAME', '🎮 Game started!');
        updateGameState();
        return true;
    }
    return false;
}

// ===== جمع‌آوری سکه =====
function collectCoin(playerId, coinId) {
    const player = gameState.players.get(playerId);
    if (!player || !player.isAlive) return false;

    const coin = gameState.coins.find(c => c.id === coinId && !c.collected);
    if (!coin) return false;

    coin.collected = true;
    player.score += 1;

    // ریسپاون سکه بعد از ۳ ثانیه
    setTimeout(() => {
        coin.collected = false;
        coin.x = 30 + Math.random() * (MAP_WIDTH - 60);
        coin.y = 30 + Math.random() * (MAP_HEIGHT - 60);
        broadcast({
            type: 'COIN_RESPAWN',
            coin: { id: coin.id, x: coin.x, y: coin.y }
        });
        updateGameState();
    }, 3000);

    broadcast({
        type: 'COIN_COLLECTED',
        playerId: playerId,
        coinId: coinId,
        newScore: player.score,
        playerName: player.name
    });

    log('GAME', `🪙 Coin ${coinId} collected by ${player.name} (${player.score})`);
    return true;
}

// ===== Tick سیستم =====
function gameTick() {
    gameState.tickCount++;
    
    // به‌روزرسانی Ping
    const now = Date.now();
    gameState.players.forEach((player, id) => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            if (now - player.lastPing > PING_INTERVAL) {
                player.lastPing = now;
                player.send({ type: 'PING', timestamp: now });
            }
        }
    });

    // برسی بازیکنان غیرفعال
    gameState.players.forEach((player, id) => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ping = Math.min(player.ping + 1, 1000);
        }
    });

    // به‌روزرسانی وضعیت هر ۱۰ تیک
    if (gameState.tickCount % 10 === 0) {
        updateGameState();
    }
}

// ===== شروع سرور =====
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: {
        zlibDeflateOptions: {
            chunkSize: 1024,
            memLevel: 7,
            level: 3
        },
        zlibInflateOptions: {
            chunkSize: 10 * 1024
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 1024
    },
    clientTracking: true,
    maxPayload: 1024 * 1024 // 1MB
});

// ===== Express Routes =====
app.use(express.json());
app.use(express.static('public'));

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        players: gameState.players.size,
        coins: gameState.coins.filter(c => !c.collected).length,
        gameStarted: gameState.gameStarted,
        uptime: process.uptime(),
        timestamp: Date.now()
    });
});

app.get('/status', (req, res) => {
    const playersData = Array.from(gameState.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        score: p.score,
        ready: p.ready,
        isAlive: p.isAlive,
        ping: p.ping,
        position: { x: Math.round(p.x), y: Math.round(p.y) }
    }));
    res.json({
        players: playersData,
        totalPlayers: gameState.players.size,
        coins: gameState.coins.filter(c => !c.collected).length,
        gameStarted: gameState.gameStarted,
        tick: gameState.tickCount
    });
});

app.get('/debug', (req, res) => {
    res.json({
        memory: process.memoryUsage(),
        uptime: process.uptime(),
        connections: wss.clients.size,
        players: gameState.players.size,
        gameState: {
            started: gameState.gameStarted,
            coins: gameState.coins.length,
            tick: gameState.tickCount
        }
    });
});

// ===== WebSocket Connection Handler =====
wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    log('CONNECTION', `🔗 New connection from ${ip}`);
    
    let playerId = null;
    let playerName = '';
    let isAuthenticated = false;
    let connectionTimeout = setTimeout(() => {
        if (!isAuthenticated) {
            ws.close(1008, 'Connection timeout');
            log('WARNING', `⏰ Connection timeout from ${ip}`);
        }
    }, CONNECTION_TIMEOUT);

    // ===== Heartbeat =====
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
        if (playerId !== null && gameState.players.has(playerId)) {
            const player = gameState.players.get(playerId);
            player.ping = Math.min(Date.now() - player.lastPing, 1000);
            player.lastPing = Date.now();
        }
    });

    // ===== دریافت پیام =====
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            log('RECEIVED', `📨 ${data.type} from ${playerId || 'new'}`);
            
            switch(data.type) {
                // ===== JOIN =====
                case 'JOIN':
                    if (gameState.players.size >= MAX_PLAYERS) {
                        ws.send(JSON.stringify({
                            type: 'ERROR',
                            message: 'Server is full!'
                        }));
                        ws.close(1008, 'Server full');
                        return;
                    }

                    playerId = gameState.nextPlayerId++;
                    playerName = data.name || `Player${playerId}`;
                    
                    const newPlayer = new Player(playerId, ws, playerName);
                    gameState.players.set(playerId, newPlayer);
                    isAuthenticated = true;
                    clearTimeout(connectionTimeout);

                    // ارسال وضعیت فعلی
                    ws.send(JSON.stringify({
                        type: 'JOIN_ACCEPTED',
                        playerId: playerId,
                        gameState: {
                            players: Array.from(gameState.players.values()).map(p => p.toJSON()),
                            coins: gameState.coins.filter(c => !c.collected).map(c => ({ id: c.id, x: c.x, y: c.y })),
                            gameStarted: gameState.gameStarted
                        }
                    }));

                    broadcast({
                        type: 'PLAYER_JOINED',
                        player: newPlayer.toJSON()
                    }, playerId);

                    log('GAME', `👤 Player ${playerId} (${playerName}) joined`);
                    updateGameState();
                    break;

                // ===== PLAYER_READY =====
                case 'PLAYER_READY':
                    if (playerId !== null && gameState.players.has(playerId)) {
                        const player = gameState.players.get(playerId);
                        player.ready = data.ready || true;
                        broadcast({
                            type: 'PLAYER_READY_UPDATE',
                            playerId: playerId,
                            ready: player.ready,
                            playerName: player.name
                        });
                        log('GAME', `✅ ${player.name} is ${player.ready ? 'ready' : 'not ready'}`);
                        checkGameStart();
                        updateGameState();
                    }
                    break;

                // ===== PLAYER_MOVE =====
                case 'PLAYER_MOVE':
                    if (playerId !== null && gameState.gameStarted && gameState.players.has(playerId)) {
                        const player = gameState.players.get(playerId);
                        if (player.updatePosition(data.x, data.y)) {
                            broadcast({
                                type: 'PLAYER_MOVED',
                                playerId: playerId,
                                x: player.x,
                                y: player.y,
                                playerName: player.name
                            }, playerId);
                        }
                    }
                    break;

                // ===== COLLECT_COIN =====
                case 'COLLECT_COIN':
                    if (playerId !== null && gameState.gameStarted) {
                        collectCoin(playerId, data.coinId);
                    }
                    break;

                // ===== GET_PLAYERS =====
                case 'GET_PLAYERS':
                    if (playerId !== null) {
                        sendToPlayer(playerId, {
                            type: 'PLAYER_LIST',
                            players: Array.from(gameState.players.values()).map(p => p.toJSON())
                        });
                    }
                    break;

                // ===== GET_GAME_STATE =====
                case 'GET_GAME_STATE':
                    if (playerId !== null && gameState.players.has(playerId)) {
                        const player = gameState.players.get(playerId);
                        sendToPlayer(playerId, {
                            type: 'GAME_STATE',
                            players: Array.from(gameState.players.values()).map(p => p.toJSON()),
                            coins: gameState.coins.filter(c => !c.collected).map(c => ({ id: c.id, x: c.x, y: c.y })),
                            gameStarted: gameState.gameStarted,
                            timestamp: Date.now()
                        });
                    }
                    break;

                // ===== REQUEST_START =====
                case 'REQUEST_START':
                    if (playerId !== null) {
                        checkGameStart();
                    }
                    break;

                // ===== PING =====
                case 'PING':
                    if (playerId !== null && gameState.players.has(playerId)) {
                        const player = gameState.players.get(playerId);
                        player.ping = Math.min(Date.now() - (data.timestamp || player.lastPing), 1000);
                        player.send({
                            type: 'PONG',
                            timestamp: Date.now(),
                            ping: player.ping
                        });
                    }
                    break;

                // ===== CHANGE_MODE =====
                case 'CHANGE_MODE':
                    // پشتیبانی از حالت‌های مختلف
                    log('INFO', `Mode change requested by ${playerId}: ${data.mode}`);
                    break;

                default:
                    log('WARNING', `⚠️ Unknown message type: ${data.type}`);
            }
        } catch (error) {
            log('ERROR', `Error processing message:`, error.message);
        }
    });

    // ===== قطع اتصال =====
    ws.on('close', (code, reason) => {
        clearTimeout(connectionTimeout);
        if (playerId !== null && gameState.players.has(playerId)) {
            const player = gameState.players.get(playerId);
            log('CONNECTION', `❌ Player ${playerId} (${player.name}) disconnected: ${code} - ${reason}`);
            gameState.players.delete(playerId);
            
            broadcast({
                type: 'PLAYER_LEFT',
                playerId: playerId,
                playerName: player.name
            });

            if (gameState.gameStarted && gameState.players.size < 2) {
                gameState.gameStarted = false;
                broadcast({
                    type: 'GAME_ENDED',
                    reason: 'Not enough players',
                    players: Array.from(gameState.players.values()).map(p => p.toJSON())
                });
                log('GAME', '⏹️ Game ended - not enough players');
            }

            updateGameState();
        }
        ws.isAlive = false;
    });

    // ===== خطا =====
    ws.on('error', (error) => {
        log('ERROR', `WebSocket error:`, error.message);
    });
});

// ===== Ping/Connection check =====
const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            log('WARNING', '🔴 Client disconnected (no pong)');
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, PING_INTERVAL);

// ===== Game tick =====
const tickInterval = setInterval(() => {
    gameTick();
}, 1000 / TICK_RATE);

// ===== Cleanup =====
process.on('SIGINT', () => {
    log('SYSTEM', '🛑 Shutting down gracefully...');
    clearInterval(pingInterval);
    clearInterval(tickInterval);
    
    // اطلاع به همه بازیکنان
    broadcast({
        type: 'SERVER_SHUTDOWN',
        message: 'Server is shutting down'
    });
    
    // بستن همه اتصالات
    wss.clients.forEach((client) => {
        client.close(1000, 'Server shutting down');
    });
    
    server.close(() => {
        log('SYSTEM', '✅ Server closed');
        process.exit(0);
    });
});

process.on('uncaughtException', (error) => {
    log('ERROR', '💥 Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    log('ERROR', '💥 Unhandled Rejection:', reason);
});

// ===== استارت سرور =====
server.listen(PORT, () => {
    log('SYSTEM', `🚀 Server running on port ${PORT}`);
    log('SYSTEM', `📊 Max Players: ${MAX_PLAYERS}`);
    log('SYSTEM', `🪙 Coins: ${COINS_COUNT}`);
    log('SYSTEM', `⏱️ Tick Rate: ${TICK_RATE}Hz`);
    log('SYSTEM', `🌐 WebSocket: ws://localhost:${PORT}`);
    log('SYSTEM', `📡 Health check: http://localhost:${PORT}/health`);
});

// ============================================================
//  package.json
// ============================================================
/*
{
  "name": "game-server",
  "version": "1.0.0",
  "description": "High-performance multiplayer game server",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "ws": "^8.14.2",
    "express": "^4.18.2"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}
*/