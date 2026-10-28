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
const STAKES = [0.5, 1, 5]; // selectable entry fees (TON)
const DEFAULT_STAKE = 1;
const LEVELS = ['easy', 'medium', 'hard'];
const BOT_USERNAME = process.env.BOT_USERNAME || 'ytgchess_bot';
const REF_BONUS = 2; // TON for both sides of a referral
const CHALLENGE_WAIT_MS = 10 * 60 * 1000;
const REMATCH_WAIT_MS = 30000;
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
const today = () => Math.floor(Date.now() / 864e5);
function getUser(id, name) {
  const isNew = !users[id];
  if (isNew) {
    users[id] = { id, name, balance: START_BALANCE, games: 0, wins: 0, losses: 0, draws: 0, totalWon: 0, totalFees: 0, totalReturned: 0, wallet: null, history: [], streak: 0, lastDay: 0, referrals: 0 };
  }
  if (name) users[id].name = name;
  return { u: users[id], isNew };
}
const publicProfile = (u) => ({
  dailyReady: u.lastDay !== today(), streak: u.lastDay >= today() - 1 ? u.streak || 0 : 0, referrals: u.referrals || 0,
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
  try { return { user: JSON.parse(params.get('user')), startParam: params.get('start_param') || '' }; } catch { return null; }
}

// ---- connections ----
const sockets = new Map(); // uid -> ws
const send = (uid, msg) => {
  const ws = sockets.get(uid);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};

let notifier = null; // set once the Telegram bot is running
const online = (uid) => !!sockets.get(uid) && sockets.get(uid).readyState === 1;
function notify(uid, text) { // Telegram message for players who have closed the app
  if (notifier && uid.startsWith('tg') && !online(uid)) notifier(uid.slice(2), text);
}
const cfg = () => ({ stakes: STAKES, levels: LEVELS, defaultStake: DEFAULT_STAKE, houseCut: HOUSE_CUT, waitMs: MATCH_WAIT_MS, bot: BOT_USERNAME });
const sendProfile = (uid) => send(uid, { t: 'profile', profile: publicProfile(users[uid]), ...cfg() });

function leaderboard(uid) {
  const all = Object.values(users).filter((u) => u.games > 0).sort((a, b) => (b.totalWon - a.totalWon) || (b.wins - a.wins));
  return {
    t: 'lb',
    rows: all.slice(0, 10).map((u) => ({ id: u.id, name: u.name, wins: u.wins, games: u.games, totalWon: round4(u.totalWon) })),
    rank: all.findIndex((u) => u.id === uid) + 1, total: all.length,
  };
}

// ---- matchmaking ----
const queues = new Map(); // stake -> { uid, stake, level, endsAt, timer } (public queue, one waiter per stake)
const challenges = new Map(); // host uid -> { uid, stake, level, endsAt, timer } (private, waits for a friend)
const games = new Map();
const userGame = new Map(); // uid -> gameId

const isBusy = (uid) => userGame.has(uid) || challenges.has(uid) || [...queues.values()].some((e) => e.uid === uid);
function charge(u, stake) { u.balance = round4(u.balance - stake); u.totalFees = round4((u.totalFees || 0) + stake); }
function refund(u, stake) { u.balance = round4(u.balance + stake); u.totalFees = round4((u.totalFees || 0) - stake); }
function precheck(uid, stake) {
  const u = users[uid];
  if (isBusy(uid)) return 'Game already in progress';
  if (!u.wallet) return 'Connect your TON wallet first';
  if (u.balance < stake) return 'Insufficient balance';
  return null;
}

function joinQueue(uid, stake, level, invite) {
  if (!STAKES.includes(stake)) stake = DEFAULT_STAKE;
  if (!LEVELS.includes(level)) level = 'medium';
  const err = precheck(uid, stake);
  if (err) return send(uid, { t: 'error', msg: err });
  const u = users[uid];
  charge(u, stake);
  save();
  send(uid, { t: 'paid', txHash: fakeHash(), amount: stake, profile: publicProfile(u) });

  if (invite) {
    const entry = { uid, stake, level, endsAt: Date.now() + CHALLENGE_WAIT_MS, timer: null };
    entry.timer = setTimeout(() => {
      if (challenges.get(uid) !== entry) return;
      challenges.delete(uid); refund(u, stake); save();
      send(uid, { t: 'cancelled', profile: publicProfile(u) });
    }, CHALLENGE_WAIT_MS);
    challenges.set(uid, entry);
    return send(uid, { t: 'queue', endsAt: entry.endsAt, invite: uid });
  }
  const opp = queues.get(stake);
  if (opp) {
    clearTimeout(opp.timer);
    queues.delete(stake);
    startGame(opp.uid, uid, stake);
  } else {
    const entry = { uid, stake, level, endsAt: Date.now() + MATCH_WAIT_MS, timer: null };
    entry.timer = setTimeout(() => {
      if (queues.get(stake) === entry) { queues.delete(stake); startGame(uid, 'bot', stake, level); }
    }, MATCH_WAIT_MS);
    queues.set(stake, entry);
    send(uid, { t: 'queue', endsAt: entry.endsAt });
  }
}

function acceptChallenge(uid, host) {
  const ch = challenges.get(host);
  if (!ch || host === uid) return send(uid, { t: 'error', msg: 'This challenge is no longer available' });
  const err = precheck(uid, ch.stake);
  if (err) return send(uid, { t: 'error', msg: err });
  const u = users[uid];
  charge(u, ch.stake);
  save();
  send(uid, { t: 'paid', txHash: fakeHash(), amount: ch.stake, profile: publicProfile(u) });
  clearTimeout(ch.timer);
  challenges.delete(host);
  startGame(host, uid, ch.stake);
}

function cancelQueue(uid) {
  let entry = [...queues.values()].find((e) => e.uid === uid);
  if (entry) queues.delete(entry.stake); else { entry = challenges.get(uid); if (entry) challenges.delete(uid); }
  if (!entry) return;
  clearTimeout(entry.timer);
  const u = users[uid];
  refund(u, entry.stake);
  save();
  send(uid, { t: 'cancelled', profile: publicProfile(u) });
}

// ---- game ----
function startGame(a, b, stake, level) {
  const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
  const g = {
    id: crypto.randomBytes(6).toString('hex'),
    chess: new Chess(),
    white, black,
    stake, level: level || 'medium',
    pot: round4(stake * 2),
    drawFrom: null, rematch: {}, rematchTimers: {}, lastNotify: {},
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
  for (const uid of [white, black]) if (uid !== 'bot') notify(uid, '♟ Your match has started! Tap to play.');
}

const colorOf = (g, uid) => (g.white === uid ? 'w' : g.black === uid ? 'b' : null);
const nameOf = (uid) => (uid === 'bot' ? 'ChessBot 🤖' : users[uid]?.name || 'Player');

function snapshot(g, forUid) {
  const you = colorOf(g, forUid);
  const legal = !g.over && g.chess.turn() === you
    ? g.chess.moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to }))
    : [];
  const claim = g.claims[forUid];
  const review = g.over ? (() => {
    const c = new Chess(); const fens = [c.fen()];
    for (const m of g.chess.history({ verbose: true })) { c.move(m); fens.push(c.fen()); }
    return { fens, hv: g.chess.history({ verbose: true }).map((m) => ({ from: m.from, to: m.to })) };
  })() : null;
  return {
    stake: g.stake, drawOffer: !!g.drawFrom && g.drawFrom !== you, drawSent: g.drawFrom === you, review,
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
  g.drawFrom = null;
  const prize = round4(g.pot * (1 - HOUSE_CUT));
  for (const uid of [g.white, g.black]) {
    if (uid === 'bot') continue;
    const u = users[uid];
    const c = colorOf(g, uid);
    u.games += 1;
    let outcome;
    if (winner === 'draw') { u.draws += 1; g.claims[uid] = { amount: g.stake, claimed: false }; outcome = 'draw'; }
    else if (winner === c) { u.wins += 1; g.claims[uid] = { amount: prize, claimed: false }; outcome = 'win'; }
    else { u.losses += 1; outcome = 'loss'; }
    const net = outcome === 'win' ? round4(prize - g.stake) : outcome === 'loss' ? -g.stake : 0;
    u.history.unshift({ vs: nameOf(c === 'w' ? g.black : g.white), outcome, pot: g.pot, net, reason, at: Date.now() });
    notify(uid, outcome === 'win' ? `🏆 You won ${prize} TON vs ${nameOf(c === 'w' ? g.black : g.white)}! Open the game to claim.` : outcome === 'draw' ? '🤝 Draw. Open the game to claim your refund.' : `Game over (${reason}). Better luck next time!`);
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
  g.drawFrom = null;
  checkEnd(g);
  broadcast(g);
  if (!g.over) {
    scheduleBot(g);
    const next = g.chess.turn() === 'w' ? g.white : g.black;
    if (next !== 'bot' && !online(next) && Date.now() - (g.lastNotify[next] || 0) > 60000) {
      g.lastNotify[next] = Date.now();
      notify(next, `♟ Your move vs ${nameOf(next === g.white ? g.black : g.white)}.`);
    }
  }
  return true;
}

function scheduleBot(g) {
  if (g.over) return;
  const botColor = colorOf(g, 'bot');
  if (!botColor || g.chess.turn() !== botColor) return;
  setTimeout(() => {
    if (g.over) return;
    const m = pickMove(g.chess, g.level);
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
      const v = verifyInitData(m.initData);
      // Only Telegram sessions are accepted. Set ALLOW_GUESTS=1 to test in a plain browser.
      if (!v && process.env.ALLOW_GUESTS !== '1') return ws.send(JSON.stringify({ t: 'blocked' }));
      const tgUser = v && v.user;
      const startParam = (v && v.startParam) || String(m.startParam || '').slice(0, 40);
      const id = tgUser ? `tg${tgUser.id}` : `guest${String(m.guestId || '').replace(/\W/g, '').slice(0, 16) || 'x'}`;
      const name = tgUser ? (tgUser.first_name || tgUser.username || 'Player') : `Guest ${id.slice(-4)}`;
      uid = id;
      sockets.set(uid, ws);
      const { u, isNew } = getUser(uid, name);
      const ref = /^ref_(\w+)$/.exec(startParam);
      if (isNew && ref && ref[1] !== uid && users[ref[1]]) { // referral: both sides get a bonus
        const r = users[ref[1]];
        u.balance = round4(u.balance + REF_BONUS); r.balance = round4(r.balance + REF_BONUS); r.referrals = (r.referrals || 0) + 1;
        save(); sendProfile(r.id);
        notify(r.id, `🎁 ${name} joined through your invite. +${REF_BONUS} TON added!`);
      }
      sendProfile(uid);
      const gid = userGame.get(uid);
      const mine = [...queues.values()].find((e) => e.uid === uid) || challenges.get(uid);
      if (gid && games.get(gid)) send(uid, snapshot(games.get(gid), uid));
      else if (mine) send(uid, { t: 'queue', endsAt: mine.endsAt, invite: challenges.has(uid) ? uid : undefined });
      return;
    }
    if (!uid) return;

    if (m.t === 'wallet') {
      const addr = typeof m.address === 'string' && /^[A-Za-z0-9_:\-]{10,80}$/.test(m.address) ? m.address : null;
      users[uid].wallet = addr;
      save();
      return sendProfile(uid);
    }
    if (m.t === 'join') return joinQueue(uid, Number(m.stake), m.level, !!m.invite);
    if (m.t === 'accept') return acceptChallenge(uid, String(m.host || ''));
    if (m.t === 'challengeInfo') {
      const ch = challenges.get(String(m.host || ''));
      return send(uid, ch ? { t: 'challenge', host: ch.uid, name: users[ch.uid].name, stake: ch.stake } : { t: 'challenge', expired: true });
    }
    if (m.t === 'lb') return send(uid, leaderboard(uid));
    if (m.t === 'daily') {
      const u = users[uid];
      if (u.lastDay === today()) return send(uid, { t: 'error', msg: 'Already claimed today, come back tomorrow' });
      u.streak = u.lastDay === today() - 1 ? (u.streak || 0) + 1 : 1;
      u.lastDay = today();
      const amount = round4(0.5 + 0.5 * Math.min(u.streak, 7)); // 1 TON on day 1 up to 4 TON on day 7+
      u.balance = round4(u.balance + amount);
      save();
      return send(uid, { t: 'bonus', amount, streak: u.streak, profile: publicProfile(u) });
    }
    if (m.t === 'draw' || m.t === 'drawAccept' || m.t === 'drawDecline') {
      const g = games.get(userGame.get(uid));
      if (!g || g.over) return;
      const me = colorOf(g, uid), opp = me === 'w' ? g.black : g.white;
      if (m.t === 'draw') {
        if (g.drawFrom) return;
        if (opp === 'bot') return send(uid, { t: 'toast', msg: 'The bot declined your draw offer' });
        g.drawFrom = me;
      } else if (m.t === 'drawAccept') {
        if (g.drawFrom && g.drawFrom !== me) return endGame(g, 'draw', 'agreement');
        return;
      } else if (g.drawFrom && g.drawFrom !== me) { g.drawFrom = null; send(opp, { t: 'toast', msg: 'Draw offer declined' }); }
      return broadcast(g);
    }
    if (m.t === 'rematch') {
      const g = games.get(String(m.gameId || ''));
      if (!g || !g.over || (g.white !== uid && g.black !== uid) || g.rematch[uid]) return;
      const err = precheck(uid, g.stake);
      if (err) return send(uid, { t: 'error', msg: err });
      const u = users[uid], opp = g.white === uid ? g.black : g.white;
      charge(u, g.stake); save();
      send(uid, { t: 'paid', txHash: fakeHash(), amount: g.stake, profile: publicProfile(u) });
      g.rematch[uid] = true;
      if (opp === 'bot' || g.rematch[opp]) {
        Object.values(g.rematchTimers).forEach(clearTimeout);
        g.rematch = {}; g.rematchTimers = {};
        return startGame(g.white, g.black, g.stake, g.level);
      }
      send(opp, { t: 'rematchOffer', name: u.name });
      notify(opp, `🔁 ${u.name} wants a rematch. Open the game to accept.`);
      g.rematchTimers[uid] = setTimeout(() => {
        if (!g.rematch[uid]) return;
        delete g.rematch[uid]; refund(u, g.stake); save();
        send(uid, { t: 'rematchExpired', profile: publicProfile(u) });
      }, REMATCH_WAIT_MS);
      return;
    }
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
      sendProfile(uid);
    } else if (m.t === 'profile') {
      sendProfile(uid);
    }
  });
  ws.on('close', () => { if (uid && sockets.get(uid) === ws) sockets.delete(uid); });
});

server.listen(PORT, () => {
  console.log(`TG Chess on http://localhost:${PORT}`);
  const b = startBot();
  if (b) notifier = b.notify;
});
