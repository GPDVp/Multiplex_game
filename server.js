const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const TURN_MS = 30000;
const MATCH_WAIT_MS = 5000;
const CARD_SHOOT = 0;
const CARD_SHIELD = 1;
const CARD_BLEED = 2;
const CARD_MIRROR = 3;
const CARD_LIGHTNING = 4;
const CARD_DEATH = 5;
const AI_LEVELS = ['weak', 'medium', 'strong', 'expert'];
function randomAiLevel() { return AI_LEVELS[Math.floor(Math.random() * AI_LEVELS.length)]; }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('card-duel-server-online');
});
const wss = new WebSocket.Server({ server });

let nextId = 1;
function genId() { return 'p' + (nextId++) + '_' + Date.now().toString(36); }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function makeCards() {
  const order = shuffle([0, 1, 2, 3, 4, 5]);
  const realFlags = shuffle([true, true, true, false, false, false]);
  return order.map((cardId, i) => ({
    cardId,
    isReal: realFlags[i],
    disabledForOwnTurns: 0,
    lockedForOwnTurns: 0
  }));
}

function createPlayerState(ws, isAI, aiLevel) {
  return {
    ws,
    id: genId(),
    isAI: !!isAI,
    aiLevel: aiLevel || 'weak',
    connected: true,
    cards: makeCards(),
    score: 0,
    hearts: 3,
    ownTurnCount: 0,
    lastUsedCard: null,
    shieldActive: false,
    mirrorWatch: false,
    pendingMirrorCardId: null,
    bleedTurnsRemaining: 0,
    revealed: [null, null, null, null, null, null],
    shotsUsed: 0
  };
}

const rooms = new Map();
const waitingQueue = [];

function otherSide(side) { return side === 'A' ? 'B' : 'A'; }

function createRoom(wsA, wsAAiLevel, isAI, aiLevel) {
  const roomId = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 10000);
  const room = {
    id: roomId,
    players: {
      A: createPlayerState(wsA, false, null),
      B: isAI ? createPlayerState(null, true, aiLevel) : null
    },
    currentTurnPlayer: Math.random() < 0.5 ? 'A' : 'B',
    firstTurnEver: true,
    turnPhase: 'guess',
    turnNumber: 0,
    turnDeadline: 0,
    turnTimerHandle: null,
    gameOver: false,
    winner: null
  };
  rooms.set(roomId, room);
  wsA.roomId = roomId;
  wsA.side = 'A';
  return room;
}

function attachSecondPlayer(room, wsB) {
  room.players.B = createPlayerState(wsB, false, null);
  wsB.roomId = room.id;
  wsB.side = 'B';
}

function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) {}
}

function cardPublic(p, i, isSelf) {
  const c = p.cards[i];
  const o = { slot: i, cardId: c.cardId, disabled: c.disabledForOwnTurns > 0, locked: c.lockedForOwnTurns > 0 };
  if (isSelf) o.isReal = c.isReal;
  else if (p.revealed[i] !== null) o.revealedReal = p.revealed[i];
  return o;
}

function buildState(room, side) {
  const self = room.players[side];
  const opp = room.players[otherSide(side)];
  const selfCards = self.cards.map((c, i) => cardPublic(self, i, true));
  const oppCards = opp.cards.map((c, i) => cardPublic(opp, i, false));
  return {
    type: 'state',
    you: { cards: selfCards, score: self.score, hearts: self.hearts, tableSlot: self.lastUsedCard ? self.lastUsedCard.slot : null },
    opponent: { cards: oppCards, score: opp.score, hearts: opp.hearts, isAI: opp.isAI, aiLevel: opp.isAI ? opp.aiLevel : null, tableSlot: opp.lastUsedCard ? opp.lastUsedCard.slot : null },
    turn: room.currentTurnPlayer === side ? 'you' : 'opponent',
    phase: room.turnPhase,
    turnNumber: room.turnNumber,
    timeLeftMs: room.turnDeadline ? Math.max(0, room.turnDeadline - Date.now()) : 0,
    gameOver: room.gameOver,
    winner: room.gameOver ? (room.winner === side ? 'you' : 'opponent') : null
  };
}

function broadcastState(room) {
  if (!room.players.A.isAI) send(room.players.A.ws, buildState(room, 'A'));
  if (!room.players.B.isAI) send(room.players.B.ws, buildState(room, 'B'));
}

function clearTurnTimer(room) {
  if (room.turnTimerHandle) { clearTimeout(room.turnTimerHandle); room.turnTimerHandle = null; }
}

function endGame(room, winnerSide, reason) {
  if (room.gameOver) return;
  room.gameOver = true;
  room.winner = winnerSide;
  clearTurnTimer(room);
  if (!room.players.A.isAI) send(room.players.A.ws, Object.assign(buildState(room, 'A'), { type: 'game_over', reason }));
  if (!room.players.B.isAI) send(room.players.B.ws, Object.assign(buildState(room, 'B'), { type: 'game_over', reason }));
  setTimeout(() => { rooms.delete(room.id); }, 5000);
}

function checkHearts(room) {
  if (room.players.A.hearts <= 0) { endGame(room, 'B', 'hearts'); return true; }
  if (room.players.B.hearts <= 0) { endGame(room, 'A', 'hearts'); return true; }
  return false;
}

function addScore(room, side, delta) {
  const p = room.players[side];
  p.score = Math.max(0, Math.min(50, p.score + delta));
  if (p.score >= 50) {
    p.score = 0;
    p.shotsUsed += 1;
    const opp = room.players[otherSide(side)];
    opp.hearts = Math.max(0, opp.hearts - 1);
    checkHearts(room);
  }
}

function applyBleedTick(room, side) {
  const p = room.players[side];
  if (p.bleedTurnsRemaining > 0) {
    p.hearts = Math.max(0, p.hearts - 0.5);
    p.bleedTurnsRemaining -= 1;
    checkHearts(room);
  }
}

function resolveEffect(room, sourceSide, victimSide, card, guessOutcome) {
  const source = room.players[sourceSide];
  const victim = room.players[victimSide];
  if (!card.isReal) return;
  if (guessOutcome === 'nullified') return;
  const shieldWasActive = victim.shieldActive;
  switch (card.cardId) {
    case CARD_SHOOT: {
      if (shieldWasActive) { victim.shieldActive = false; break; }
      if (typeof card.targetSlot === 'number' && card.targetSlot >= 0 && card.targetSlot < 6) {
        victim.cards[card.targetSlot].disabledForOwnTurns = Math.max(victim.cards[card.targetSlot].disabledForOwnTurns, 1);
      }
      break;
    }
    case CARD_SHIELD: {
      source.shieldActive = true;
      break;
    }
    case CARD_BLEED: {
      if (shieldWasActive) { victim.shieldActive = false; break; }
      victim.bleedTurnsRemaining = 2;
      break;
    }
    case CARD_MIRROR: {
      source.mirrorWatch = true;
      break;
    }
    case CARD_LIGHTNING: {
      if (shieldWasActive) { victim.shieldActive = false; break; }
      const available = victim.cards.map((c, i) => i).filter(i => victim.cards[i].lockedForOwnTurns <= 0);
      if (available.length > 0) {
        const pick = available[Math.floor(Math.random() * available.length)];
        victim.cards[pick].lockedForOwnTurns = 2;
      }
      break;
    }
    case CARD_DEATH: {
      if (shieldWasActive) {
        victim.shieldActive = false;
        source.hearts = Math.max(0, source.hearts - 1);
      } else {
        victim.hearts = Math.max(0, victim.hearts - 1);
      }
      checkHearts(room);
      break;
    }
  }
}

function applyMirrorCopyIfAny(room, side) {
  const p = room.players[side];
  if (p.pendingMirrorCardId === null || p.pendingMirrorCardId === undefined) return;
  const cardId = p.pendingMirrorCardId;
  p.pendingMirrorCardId = null;
  const fakeCard = { cardId, isReal: true };
  resolveEffect(room, side, otherSide(side), fakeCard, 'applied');
  checkHearts(room);
}

function startTurn(room) {
  if (room.gameOver) return;
  const side = room.currentTurnPlayer;
  const p = room.players[side];
  p.ownTurnCount += 1;
  applyBleedTick(room, side);
  if (checkHearts(room)) return;
  p.cards.forEach(c => { });
  room.turnNumber += 1;
  const opp = room.players[otherSide(side)];
  room.turnPhase = (opp.lastUsedCard && !room.firstTurnEver) ? 'guess' : 'use';
  if (!opp.lastUsedCard) room.turnPhase = 'use';
  room.firstTurnEver = false;
  applyMirrorCopyIfAny(room, side);
  if (checkHearts(room)) return;
  room.turnDeadline = Date.now() + TURN_MS;
  clearTurnTimer(room);
  room.turnTimerHandle = setTimeout(() => onTurnTimeout(room), TURN_MS);
  broadcastState(room);
  if (p.isAI) aiTakeTurn(room, side);
}

function onTurnTimeout(room) {
  if (room.gameOver) return;
  const side = room.currentTurnPlayer;
  endGame(room, otherSide(side), 'timeout');
}

function advanceTurn(room) {
  if (room.gameOver) return;
  room.currentTurnPlayer = otherSide(room.currentTurnPlayer);
  startTurn(room);
}

function handleGuess(room, side, value) {
  if (room.gameOver) return;
  if (room.currentTurnPlayer !== side) return;
  if (room.turnPhase !== 'guess') return;
  const opp = room.players[otherSide(side)];
  const last = opp.lastUsedCard;
  if (!last) { room.turnPhase = 'use'; broadcastState(room); return; }
  opp.revealed[last.slot] = last.isReal;
  let outcome = 'applied';
  if (value === 'unknown') {
    outcome = 'applied';
  } else {
    const guessedReal = value === 'real';
    const correct = guessedReal === last.isReal;
    if (correct) {
      addScore(room, side, 25);
      outcome = 'nullified';
    } else {
      addScore(room, side, -25);
      outcome = 'applied';
    }
  }
  resolveEffect(room, otherSide(side), side, last, outcome);
  opp.lastUsedCard = null;
  if (checkHearts(room)) return;
  room.turnPhase = 'use';
  broadcastState(room);
  if (room.players[side].isAI) aiPlayCard(room, side);
}

function cardUsable(p, slot) {
  if (slot < 0 || slot > 5) return false;
  const c = p.cards[slot];
  return c.disabledForOwnTurns <= 0 && c.lockedForOwnTurns <= 0;
}

function handleUseCard(room, side, slot, targetSlot) {
  if (room.gameOver) return;
  if (room.currentTurnPlayer !== side) return;
  if (room.turnPhase !== 'use') return;
  const p = room.players[side];
  if (!cardUsable(p, slot)) return;
  const c = p.cards[slot];
  const usedCard = { slot, cardId: c.cardId, isReal: c.isReal };
  if (c.cardId === CARD_SHOOT && c.isReal) {
    usedCard.targetSlot = (typeof targetSlot === 'number' && targetSlot >= 0 && targetSlot <= 5) ? targetSlot : Math.floor(Math.random() * 6);
  }
  if (c.isReal && c.cardId !== CARD_MIRROR) {
    const opp = room.players[otherSide(side)];
    if (opp.mirrorWatch) {
      opp.mirrorWatch = false;
      opp.pendingMirrorCardId = c.cardId;
    }
  }
  p.lastUsedCard = usedCard;
  p.cards.forEach(cc => {
    if (cc.disabledForOwnTurns > 0) cc.disabledForOwnTurns -= 1;
    if (cc.lockedForOwnTurns > 0) cc.lockedForOwnTurns -= 1;
  });
  broadcastState(room);
  advanceTurn(room);
}

function aiTakeTurn(room, side) {
  if (room.gameOver) return;
  setTimeout(() => {
    if (room.gameOver || room.currentTurnPlayer !== side) return;
    if (room.turnPhase === 'guess') {
      const value = aiDecideGuess(room, side);
      handleGuess(room, side, value);
    } else {
      aiPlayCard(room, side);
    }
  }, 900 + Math.floor(Math.random() * 700));
}

function aiPlayCard(room, side) {
  if (room.gameOver) return;
  const p = room.players[side];
  setTimeout(() => {
    if (room.gameOver || room.currentTurnPlayer !== side || room.turnPhase !== 'use') return;
    const usable = p.cards.map((c, i) => i).filter(i => cardUsable(p, i));
    if (usable.length === 0) { advanceTurn(room); return; }
    const level = p.aiLevel;
    let chosen;
    if (level === 'expert' || level === 'strong') {
      const real = usable.filter(i => p.cards[i].isReal);
      chosen = real.length > 0 ? real[Math.floor(Math.random() * real.length)] : usable[Math.floor(Math.random() * usable.length)];
      const preferred = real.filter(i => p.cards[i].cardId === CARD_DEATH || p.cards[i].cardId === CARD_SHOOT);
      if (preferred.length > 0) chosen = preferred[Math.floor(Math.random() * preferred.length)];
      if (level === 'expert') {
        const opp = room.players[otherSide(side)];
        if (opp.shieldActive) {
          const nonDeath = real.filter(i => p.cards[i].cardId !== CARD_DEATH);
          if (nonDeath.length > 0) chosen = nonDeath[Math.floor(Math.random() * nonDeath.length)];
        }
      }
    } else if (level === 'medium') {
      const real = usable.filter(i => p.cards[i].isReal);
      chosen = (real.length > 0 && Math.random() < 0.7) ? real[Math.floor(Math.random() * real.length)] : usable[Math.floor(Math.random() * usable.length)];
    } else {
      chosen = usable[Math.floor(Math.random() * usable.length)];
    }
    let target = null;
    if (p.cards[chosen].cardId === CARD_SHOOT && p.cards[chosen].isReal) {
      const opp = room.players[otherSide(side)];
      if (level === 'expert' || level === 'strong') {
        const unknownSlots = opp.cards.map((c, i) => i).filter(i => opp.revealed[i] === null);
        target = unknownSlots.length > 0 ? unknownSlots[Math.floor(Math.random() * unknownSlots.length)] : Math.floor(Math.random() * 6);
      } else {
        target = Math.floor(Math.random() * 6);
      }
    }
    handleUseCard(room, side, chosen, target);
  }, 700 + Math.floor(Math.random() * 600));
}

function aiDecideGuess(room, side) {
  const p = room.players[side];
  const opp = room.players[otherSide(side)];
  const last = opp.lastUsedCard;
  if (!last) return 'unknown';
  const level = p.aiLevel;
  if (level === 'expert') {
    if (opp.revealed[last.slot] !== null) {
      return opp.revealed[last.slot] ? 'real' : 'fake';
    }
    const revealedRealCount = opp.revealed.filter(v => v === true).length;
    const revealedFakeCount = opp.revealed.filter(v => v === false).length;
    if (revealedRealCount >= 3) return 'fake';
    if (revealedFakeCount >= 3) return 'real';
    const r = Math.random();
    if (r < 0.07) return 'unknown';
    return r < 0.62 ? 'real' : 'fake';
  } else if (level === 'strong') {
    if (opp.revealed[last.slot] !== null) {
      return opp.revealed[last.slot] ? 'real' : 'fake';
    }
    const revealedRealCount = opp.revealed.filter(v => v === true).length;
    const revealedFakeCount = opp.revealed.filter(v => v === false).length;
    if (revealedRealCount >= 3) return 'fake';
    if (revealedFakeCount >= 3) return 'real';
    const r = Math.random();
    if (r < 0.15) return 'unknown';
    return r < 0.575 ? 'real' : 'fake';
  } else if (level === 'medium') {
    if (opp.revealed[last.slot] !== null && Math.random() < 0.6) {
      return opp.revealed[last.slot] ? 'real' : 'fake';
    }
    const r = Math.random();
    if (r < 0.25) return 'unknown';
    return r < 0.62 ? 'real' : 'fake';
  } else {
    const r = Math.random();
    if (r < 0.34) return 'real';
    if (r < 0.68) return 'fake';
    return 'unknown';
  }
}

function tryMatch() {
  while (waitingQueue.length >= 2) {
    const a = waitingQueue.shift();
    const b = waitingQueue.shift();
    if (a.ws.readyState !== WebSocket.OPEN) { if (b.ws.readyState === WebSocket.OPEN) waitingQueue.unshift(b); continue; }
    if (b.ws.readyState !== WebSocket.OPEN) { waitingQueue.unshift(a); continue; }
    clearTimeout(a.timeoutHandle);
    clearTimeout(b.timeoutHandle);
    const room = createRoom(a.ws);
    attachSecondPlayer(room, b.ws);
    send(a.ws, { type: 'match_found', side: 'A', opponentIsAI: false });
    send(b.ws, { type: 'match_found', side: 'B', opponentIsAI: false });
    startTurn(room);
  }
}

function queueForMatch(ws) {
  const entry = { ws, timeoutHandle: null };
  entry.timeoutHandle = setTimeout(() => {
    const idx = waitingQueue.indexOf(entry);
    if (idx === -1) return;
    waitingQueue.splice(idx, 1);
    if (ws.readyState !== WebSocket.OPEN) return;
    const level = randomAiLevel();
    const room = createRoom(ws);
    room.players.B = createPlayerState(null, true, level);
    send(ws, { type: 'match_found', side: 'A', opponentIsAI: true, aiLevel: level });
    startTurn(room);
  }, MATCH_WAIT_MS);
  waitingQueue.push(entry);
  tryMatch();
}

wss.on('connection', (ws) => {
  ws.isAliveConn = true;
  ws.on('pong', () => { ws.isAliveConn = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'find_match') {
      queueForMatch(ws);
      return;
    }
    const roomId = ws.roomId;
    const side = ws.side;
    if (!roomId || !side) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (msg.type === 'guess') {
      if (msg.value === 'real' || msg.value === 'fake' || msg.value === 'unknown') {
        handleGuess(room, side, msg.value);
      }
    } else if (msg.type === 'use_card') {
      const slot = parseInt(msg.slot, 10);
      const target = (msg.target === null || msg.target === undefined) ? null : parseInt(msg.target, 10);
      if (!isNaN(slot)) handleUseCard(room, side, slot, target);
    }
  });
  ws.on('close', () => {
    const roomId = ws.roomId;
    const side = ws.side;
    if (!roomId || !side) {
      const idx = waitingQueue.findIndex(e => e.ws === ws);
      if (idx !== -1) { clearTimeout(waitingQueue[idx].timeoutHandle); waitingQueue.splice(idx, 1); }
      return;
    }
    const room = rooms.get(roomId);
    if (!room || room.gameOver) return;
    endGame(room, otherSide(side), 'disconnect');
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAliveConn === false) { ws.terminate(); return; }
    ws.isAliveConn = false;
    try { ws.ping(); } catch (e) {}
  });
}, 5000);

server.listen(PORT, () => {
  console.log('server listening on ' + PORT);
});