const WebSocket = require('ws');

const PORT = process.env.PORT || 7000;
const MAX_PLAYERS = 50;
const COINS_COUNT = 20;
const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;

const gameState = {
    players: new Map(),
    coins: [],
    gameStarted: false,
    nextPlayerId: 1
};

function createCoins() {
    gameState.coins = [];
    for (let i = 0; i < COINS_COUNT; i++) {
        gameState.coins.push({
            id: i,
            x: Math.random() * (MAP_WIDTH - 100) + 50,
            y: Math.random() * (MAP_HEIGHT - 100) + 50,
            collected: false
        });
    }
}
createCoins();

class Player {
    constructor(id, ws, name) {
        this.id = id;
        this.ws = ws;
        this.name = name || `Player${id}`;
        this.x = Math.random() * (MAP_WIDTH - 100) + 50;
        this.y = Math.random() * (MAP_HEIGHT - 100) + 50;
        this.score = 0;
        this.ready = false;
        this.isAlive = true;
    }
    toJSON() {
        return {
            id: this.id,
            name: this.name,
            x: this.x,
            y: this.y,
            score: this.score,
            ready: this.ready,
            isAlive: this.isAlive
        };
    }
}

function broadcast(data, excludeId = null) {
    const message = JSON.stringify(data);
    gameState.players.forEach((player, id) => {
        if (id !== excludeId && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(message);
        }
    });
}

function sendToPlayer(playerId, data) {
    const player = gameState.players.get(playerId);
    if (player && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(data));
    }
}

function updateGameState() {
    const playersData = Array.from(gameState.players.values()).map(p => p.toJSON());
    const coinsData = gameState.coins
        .filter(c => !c.collected)
        .map(c => ({ id: c.id, x: c.x, y: c.y }));

    broadcast({
        type: 'GAME_STATE',
        players: playersData,
        coins: coinsData,
        gameStarted: gameState.gameStarted
    });
}

function checkGameStart() {
    const readyPlayers = Array.from(gameState.players.values()).filter(p => p.ready);
    if (readyPlayers.length >= 2 && !gameState.gameStarted) {
        gameState.gameStarted = true;
        broadcast({ type: 'GAME_START' });
        updateGameState();
    }
}

function collectCoin(playerId, coinId) {
    const player = gameState.players.get(playerId);
    if (!player) return false;

    const coin = gameState.coins.find(c => c.id === coinId && !c.collected);
    if (!coin) return false;

    coin.collected = true;
    player.score += 1;

    setTimeout(() => {
        coin.collected = false;
        coin.x = Math.random() * (MAP_WIDTH - 100) + 50;
        coin.y = Math.random() * (MAP_HEIGHT - 100) + 50;
        broadcast({ type: 'COIN_RESPAWN', coin: { id: coin.id, x: coin.x, y: coin.y } });
        updateGameState();
    }, 3000);

    broadcast({
        type: 'COIN_COLLECTED',
        playerId: playerId,
        coinId: coinId,
        newScore: player.score
    });

    return true;
}

const wss = new WebSocket.Server({ port: PORT });
console.log(`Server running on port ${PORT}`);

wss.on('connection', (ws, req) => {
    let playerId = null;

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch(data.type) {
                case 'JOIN':
                    if (gameState.players.size >= MAX_PLAYERS) {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Server is full!' }));
                        ws.close();
                        return;
                    }

                    playerId = gameState.nextPlayerId++;
                    const newPlayer = new Player(playerId, ws, data.name);
                    gameState.players.set(playerId, newPlayer);

                    ws.send(JSON.stringify({
                        type: 'JOIN_ACCEPTED',
                        playerId: playerId,
                        gameState: {
                            players: Array.from(gameState.players.values()).map(p => p.toJSON()),
                            coins: gameState.coins.filter(c => !c.collected).map(c => ({ id: c.id, x: c.x, y: c.y })),
                            gameStarted: gameState.gameStarted
                        }
                    }));

                    broadcast({ type: 'PLAYER_JOINED', player: newPlayer.toJSON() }, playerId);
                    updateGameState();
                    break;

                case 'PLAYER_READY':
                    if (playerId !== null) {
                        const player = gameState.players.get(playerId);
                        if (player) {
                            player.ready = data.ready || true;
                            broadcast({ type: 'PLAYER_READY_UPDATE', playerId: playerId, ready: player.ready });
                            checkGameStart();
                            updateGameState();
                        }
                    }
                    break;

                case 'PLAYER_MOVE':
                    if (playerId !== null && gameState.gameStarted) {
                        const player = gameState.players.get(playerId);
                        if (player) {
                            player.x = data.x;
                            player.y = data.y;
                            broadcast({ type: 'PLAYER_MOVED', playerId: playerId, x: player.x, y: player.y }, playerId);
                        }
                    }
                    break;

                case 'COLLECT_COIN':
                    if (playerId !== null && gameState.gameStarted) {
                        collectCoin(playerId, data.coinId);
                    }
                    break;

                case 'GET_PLAYERS':
                    if (playerId !== null) {
                        sendToPlayer(playerId, {
                            type: 'PLAYER_LIST',
                            players: Array.from(gameState.players.values()).map(p => p.toJSON())
                        });
                    }
                    break;

                case 'GET_GAME_STATE':
                    if (playerId !== null) {
                        sendToPlayer(playerId, {
                            type: 'GAME_STATE',
                            players: Array.from(gameState.players.values()).map(p => p.toJSON()),
                            coins: gameState.coins.filter(c => !c.collected).map(c => ({ id: c.id, x: c.x, y: c.y })),
                            gameStarted: gameState.gameStarted
                        });
                    }
                    break;
            }
        } catch (error) {
            console.error('Error:', error);
        }
    });

    ws.on('close', () => {
        if (playerId !== null) {
            gameState.players.delete(playerId);
            broadcast({ type: 'PLAYER_LEFT', playerId: playerId });

            if (gameState.gameStarted && gameState.players.size < 2) {
                gameState.gameStarted = false;
                broadcast({ type: 'GAME_ENDED', reason: 'Not enough players' });
            }
            updateGameState();
        }
    });

    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        } else {
            clearInterval(pingInterval);
        }
    }, 30000);
});

process.on('SIGINT', () => {
    wss.clients.forEach(client => client.close());
    process.exit(0);
});