const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const PORT = process.env.PORT || 7000;
const MAX_PLAYERS = 50;
const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;
const TICK_RATE = 30;
const PING_INTERVAL = 5000;

const gameState = {
    players: new Map(),
    gameStarted: false,
    nextPlayerId: 1,
    tickCount: 0
};

class Player {
    constructor(id, ws, name) {
        this.id = id;
        this.ws = ws;
        this.name = name || `Player${id}`;
        this.x = 350 + Math.random() * 100;
        this.y = 250 + Math.random() * 100;
        this.ready = false;
        this.isAlive = true;
        this.lastUpdate = Date.now();
        this.lastPing = Date.now();
        this.ping = 0;
        this.connected = true;
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            x: this.x,
            y: this.y,
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

function broadcast(data, excludeId = null) {
    const message = JSON.stringify(data);
    let sentCount = 0;
    gameState.players.forEach((player, id) => {
        if (id !== excludeId && player.ws && player.ws.readyState === WebSocket.OPEN) {
            try {
                player.ws.send(message);
                sentCount++;
            } catch (error) {}
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

function broadcastGameState() {
    const playersData = Array.from(gameState.players.values()).map(p => p.toJSON());
    const state = {
        type: 'GAME_STATE',
        players: playersData,
        gameStarted: gameState.gameStarted,
        timestamp: Date.now()
    };
    broadcast(state);
}

function checkGameStart() {
    const players = Array.from(gameState.players.values());
    const readyPlayers = players.filter(p => p.ready && p.isAlive);
    if (readyPlayers.length >= 2 && !gameState.gameStarted) {
        gameState.gameStarted = true;
        broadcast({
            type: 'GAME_START',
            timestamp: Date.now(),
            players: readyPlayers.length
        });
        broadcastGameState();
        return true;
    }
    return false;
}

function gameTick() {
    gameState.tickCount++;
    const now = Date.now();
    gameState.players.forEach((player, id) => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            if (now - player.lastPing > PING_INTERVAL) {
                player.lastPing = now;
                player.send({ type: 'PING', timestamp: now });
            }
        }
    });
    if (gameState.tickCount % 10 === 0) {
        broadcastGameState();
    }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: false
});

app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        players: gameState.players.size,
        gameStarted: gameState.gameStarted,
        uptime: process.uptime()
    });
});

app.get('/status', (req, res) => {
    const playersData = Array.from(gameState.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        ready: p.ready,
        isAlive: p.isAlive,
        ping: p.ping,
        position: { x: Math.round(p.x), y: Math.round(p.y) }
    }));
    res.json({
        players: playersData,
        totalPlayers: gameState.players.size,
        gameStarted: gameState.gameStarted,
        tick: gameState.tickCount
    });
});

wss.on('connection', (ws, req) => {
    let playerId = null;
    let playerName = '';

    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
        if (playerId !== null && gameState.players.has(playerId)) {
            const player = gameState.players.get(playerId);
            player.ping = Math.min(Date.now() - player.lastPing, 1000);
            player.lastPing = Date.now();
        }
    });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            
            switch(data.type) {
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

                    const currentPlayers = Array.from(gameState.players.values()).map(p => p.toJSON());
                    ws.send(JSON.stringify({
                        type: 'JOIN_ACCEPTED',
                        playerId: playerId,
                        gameState: {
                            players: currentPlayers,
                            gameStarted: gameState.gameStarted
                        }
                    }));

                    broadcast({
                        type: 'PLAYER_JOINED',
                        player: newPlayer.toJSON()
                    }, playerId);

                    broadcastGameState();
                    break;

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
                        checkGameStart();
                        broadcastGameState();
                    }
                    break;

                case 'PLAYER_MOVE':
                    if (playerId !== null && gameState.players.has(playerId)) {
                        const player = gameState.players.get(playerId);
                        if (player.updatePosition(data.x, data.y)) {
                            broadcast({
                                type: 'PLAYER_MOVED',
                                playerId: playerId,
                                x: player.x,
                                y: player.y,
                                playerName: player.name
                            });
                        }
                    }
                    break;

                case 'GET_PLAYERS':
                    if (playerId !== null) {
                        const playersData = Array.from(gameState.players.values()).map(p => p.toJSON());
                        sendToPlayer(playerId, {
                            type: 'PLAYER_LIST',
                            players: playersData
                        });
                    }
                    break;

                case 'REQUEST_START':
                    if (playerId !== null) {
                        checkGameStart();
                    }
                    break;

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

                default:
                    break;
            }
        } catch (error) {}
    });

    ws.on('close', (code, reason) => {
        if (playerId !== null && gameState.players.has(playerId)) {
            const player = gameState.players.get(playerId);
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
                    reason: 'Not enough players'
                });
            }

            broadcastGameState();
        }
        ws.isAlive = false;
    });

    ws.on('error', (error) => {});
});

const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, PING_INTERVAL);

const tickInterval = setInterval(() => {
    gameTick();
}, 1000 / TICK_RATE);

process.on('SIGINT', () => {
    clearInterval(pingInterval);
    clearInterval(tickInterval);
    broadcast({
        type: 'SERVER_SHUTDOWN',
        message: 'Server is shutting down'
    });
    wss.clients.forEach((client) => {
        client.close(1000, 'Server shutting down');
    });
    server.close(() => {
        process.exit(0);
    });
});

process.on('uncaughtException', (error) => {});
process.on('unhandledRejection', (reason, promise) => {});

server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});