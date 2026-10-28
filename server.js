const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');
const { pickMove } = require('./engine');
const startBot = require('./bot');

const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ENTRY_FEE = 1; // TON
const HOUSE_CUT = 0.05;
const START_BALANCE = 10; // demo TON balance
const MATCH_WAIT_MS = 40000;
const CLOCK_MS = 5 * 60 * 1000;
const DATA_FILE = path.join(__dirname, 'data.json');

const round4 = (n) => Math.round(n * 1e4) / 1e4;
const fakeHash = () => '0x' + crypto.randomBytes(32).toString('hex');

// ---- persistence (users only; games are in-memory) ----
let users = {};
try { users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* first run */ }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(users, null, 2), () => {}), 200);
}
function getUser(id, name) {
  if (!users[id]) {
    users[id] = { id, name, balance: START_BALANCE, games: 0, wins: 0, losses: 0, draws: 0, totalWon: 0, totalFees: 0, totalReturned: 0, wallet: null, history: [] };
  }
  if (name) users[id].name = name;
  return users[id];
}
const publicProfile = (u) => ({
  id: u.id, name: u.name, wallet: u.wallet || null, balance: round4(u.balance), games: u.games, wins: u.wins,
  losses: u.losses, draws: u.draws, totalWon: round4(u.totalWon),
  totalFees: round4(u.totalFees || 0), totalReturned: round4(u.totalReturned || 0),
  net: round4((u.totalReturned || 0) - (u.totalFees || 0)), history: u.history,
});

// ---- telegram initData verification ----
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (calc !== hash) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

// ---- connections ----
const sockets = new Map(); // uid -> ws
const send = (uid, msg) => {
  const ws = sockets.get(uid);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};

// ---- matchmaking ----
let waiting = null; // { uid, endsAt, timer }
const games = new Map();
const userGame = new Map(); // uid -> gameId

function joinQueue(uid) {
  const u = users[uid];
  if (userGame.has(uid)) return send(uid, { t: 'error', msg: 'Game already in progress' });
  if (waiting && waiting.uid === uid) return;
  if (!u.wallet) return send(uid, { t: 'error', msg: 'Connect your TON wallet first' });
  if (u.balance < ENTRY_FEE) return send(uid, { t: 'error', msg: 'Insufficient balance' });

  u.balance = round4(u.balance - ENTRY_FEE);
  u.totalFees = round4((u.totalFees || 0) + ENTRY_FEE);
  save();
  send(uid, { t: 'paid', txHash: fakeHash(), amount: ENTRY_FEE, profile: publicProfile(u) });

  if (waiting) {
    const opp = waiting;
    clearTimeout(opp.timer);
    waiting = null;
    startGame(opp.uid, uid);
  } else {
    const entry = { uid, endsAt: Date.now() + MATCH_WAIT_MS, timer: null };
    entry.timer = setTimeout(() => {
      if (waiting === entry) { waiting = null; startGame(uid, 'bot'); }
    }, MATCH_WAIT_MS);
    waiting = entry;
    send(uid, { t: 'queue', endsAt: entry.endsAt });
  }
}

function cancelQueue(uid) {
  if (!waiting || waiting.uid !== uid) return;
  clearTimeout(waiting.timer);
  waiting = null;
  const u = users[uid];
  u.balance = round4(u.balance + ENTRY_FEE);
  u.totalFees = round4((u.totalFees || 0) - ENTRY_FEE);
  save();
  send(uid, { t: 'cancelled', profile: publicProfile(u) });
}

// ---- game ----
function startGame(a, b) {
  const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
  const g = {
    id: crypto.randomBytes(6).toString('hex'),
    chess: new Chess(),
    white, black,
    pot: round4(ENTRY_FEE * 2),
    clocks: { w: CLOCK_MS, b: CLOCK_MS },
    lastTick: Date.now(),
    lastMove: null,
    over: null,
    claims: {},
  };
  games.set(g.id, g);
  for (const uid of [white, black]) if (uid !== 'bot') userGame.set(uid, g.id);
  broadcast(g);
  scheduleBot(g);
}

const colorOf = (g, uid) => (g.white === uid ? 'w' : g.black === uid ? 'b' : null);
const nameOf = (uid) => (uid === 'bot' ? 'ChessBot 🤖' : users[uid]?.name || 'Player');

function snapshot(g, forUid) {
  const you = colorOf(g, forUid);
  const legal = !g.over && g.chess.turn() === you
    ? g.chess.moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to }))
    : [];
  const claim = g.claims[forUid];
  return {
    t: 'game', id: g.id, fen: g.chess.fen(), turn: g.chess.turn(), you,
    white: { id: g.white, name: nameOf(g.white) },
    black: { id: g.black, name: nameOf(g.black) },
    legal, lastMove: g.lastMove, check: g.chess.isCheck(),
    pot: g.pot, prize: round4(g.pot * (1 - HOUSE_CUT)),
    clocks: g.clocks, serverNow: Date.now(),
    history: g.chess.history(),
    over: g.over, claim: claim ? { amount: claim.amount, claimed: claim.claimed } : null,
  };
}
function broadcast(g) {
  for (const uid of [g.white, g.black]) if (uid !== 'bot') send(uid, snapshot(g, uid));
}

function tickClock(g) {
  const now = Date.now();
  g.clocks[g.chess.turn()] -= now - g.lastTick;
  g.lastTick = now;
}

function endGame(g, winner, reason) {
  if (g.over) return;
  g.over = { winner, reason };
  const prize = round4(g.pot * (1 - HOUSE_CUT));
  for (const uid of [g.white, g.black]) {
    if (uid === 'bot') continue;
    const u = users[uid];
    const c = colorOf(g, uid);
    u.games += 1;
    let outcome;
    if (winner === 'draw') { u.draws += 1; g.claims[uid] = { amount: ENTRY_FEE, claimed: false }; outcome = 'draw'; }
    else if (winner === c) { u.wins += 1; g.claims[uid] = { amount: prize, claimed: false }; outcome = 'win'; }
    else { u.losses += 1; outcome = 'loss'; }
    const net = outcome === 'win' ? round4(prize - ENTRY_FEE) : outcome === 'loss' ? -ENTRY_FEE : 0;
    u.history.unshift({ vs: nameOf(c === 'w' ? g.black : g.white), outcome, pot: g.pot, net, reason, at: Date.now() });
    u.history = u.history.slice(0, 50);
    userGame.delete(uid);
  }
  save();
  broadcast(g);
  setTimeout(() => games.delete(g.id), 10 * 60 * 1000);
}

function checkEnd(g) {
  const c = g.chess;
  if (c.isCheckmate()) return endGame(g, c.turn() === 'w' ? 'b' : 'w', 'checkmate');
  if (c.isStalemate()) return endGame(g, 'draw', 'stalemate');
  if (c.isInsufficientMaterial()) return endGame(g, 'draw', 'insufficient material');
  if (c.isThreefoldRepetition()) return endGame(g, 'draw', 'repetition');
  if (c.isDraw()) return endGame(g, 'draw', '50-move rule');
}

function applyMove(g, mv) {
  tickClock(g);
  try { g.chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion || 'q' }); } catch { return false; }
  g.lastMove = { from: mv.from, to: mv.to };
  checkEnd(g);
  broadcast(g);
  if (!g.over) scheduleBot(g);
  return true;
}

function scheduleBot(g) {
  if (g.over) return;
  const botColor = colorOf(g, 'bot');
  if (!botColor || g.chess.turn() !== botColor) return;
  setTimeout(() => {
    if (g.over) return;
    const m = pickMove(g.chess);
    if (m) applyMove(g, m);
  }, 700 + Math.random() * 900);
}

// clock flags
setInterval(() => {
  for (const g of games.values()) {
    if (g.over) continue;
    tickClock(g);
    const t = g.chess.turn();
    if (g.clocks[t] <= 0) { g.clocks[t] = 0; endGame(g, t === 'w' ? 'b' : 'w', 'timeout'); }
  }
}, 1000);

// ---- http + ws ----
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// TON Connect manifest, built from the request host so it follows the tunnel URL.
app.get('/tonconnect-manifest.json', (req, res) => {
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const origin = `${proto}://${host}`;
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ url: origin, name: 'Chess Arena', iconUrl: `${origin}/ton-icon.png` });
});
app.get('/health', (_req, res) => res.json({ ok: true }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let uid = null;
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'hello') {
      const tgUser = verifyInitData(m.initData);
      // Only Telegram sessions are accepted. Set ALLOW_GUESTS=1 to test in a plain browser.
      if (!tgUser && process.env.ALLOW_GUESTS !== '1') return ws.send(JSON.stringify({ t: 'blocked' }));
      const id = tgUser ? `tg${tgUser.id}` : `guest${String(m.guestId || '').replace(/\W/g, '').slice(0, 16) || 'x'}`;
      const name = tgUser ? (tgUser.first_name || tgUser.username || 'Player') : `Guest ${id.slice(-4)}`;
      uid = id;
      sockets.set(uid, ws);
      const u = getUser(uid, name);
      send(uid, { t: 'profile', profile: publicProfile(u), entryFee: ENTRY_FEE, houseCut: HOUSE_CUT, waitMs: MATCH_WAIT_MS });
      const gid = userGame.get(uid);
      if (gid && games.get(gid)) send(uid, snapshot(games.get(gid), uid));
      else if (waiting && waiting.uid === uid) send(uid, { t: 'queue', endsAt: waiting.endsAt });
      return;
    }
    if (!uid) return;

    if (m.t === 'wallet') {
      const addr = typeof m.address === 'string' && /^[A-Za-z0-9_:\-]{10,80}$/.test(m.address) ? m.address : null;
      users[uid].wallet = addr;
      save();
      return send(uid, { t: 'profile', profile: publicProfile(users[uid]), entryFee: ENTRY_FEE, houseCut: HOUSE_CUT, waitMs: MATCH_WAIT_MS });
    }
    if (m.t === 'join') return joinQueue(uid);
    if (m.t === 'cancel') return cancelQueue(uid);

    if (m.t === 'move') {
      const g = games.get(userGame.get(uid));
      if (!g || g.over || colorOf(g, uid) !== g.chess.turn()) return;
      applyMove(g, m);
    } else if (m.t === 'resign') {
      const g = games.get(userGame.get(uid));
      if (g && !g.over) endGame(g, colorOf(g, uid) === 'w' ? 'b' : 'w', 'resignation');
    } else if (m.t === 'claim') {
      const g = games.get(m.gameId);
      const c = g && g.claims[uid];
      if (!c || c.claimed) return;
      c.claimed = true;
      const u = users[uid];
      u.balance = round4(u.balance + c.amount);
      u.totalReturned = round4((u.totalReturned || 0) + c.amount);
      if (g.over.winner !== 'draw') u.totalWon = round4(u.totalWon + c.amount);
      save();
      send(uid, { t: 'claimed', txHash: fakeHash(), amount: c.amount, profile: publicProfile(u) });
    } else if (m.t === 'faucet') {
      users[uid].balance = round4(users[uid].balance + START_BALANCE);
      save();
      send(uid, { t: 'profile', profile: publicProfile(users[uid]), entryFee: ENTRY_FEE, houseCut: HOUSE_CUT, waitMs: MATCH_WAIT_MS });
    } else if (m.t === 'profile') {
      send(uid, { t: 'profile', profile: publicProfile(users[uid]), entryFee: ENTRY_FEE, houseCut: HOUSE_CUT, waitMs: MATCH_WAIT_MS });
    }
  });
  ws.on('close', () => { if (uid && sockets.get(uid) === ws) sockets.delete(uid); });
});

server.listen(PORT, () => {
  console.log(`TG Chess on http://localhost:${PORT}`);
  startBot();
});
