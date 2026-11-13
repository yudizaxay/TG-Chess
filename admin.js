// KYC submission API (players) and the admin dashboard API + page.
// Players submit identity data and photos over HTTPS; an admin reviews them at /admin.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const DOC_TYPES = ['passport', 'national_id', 'driving_licence'];
const MAX_IMG = 3 * 1024 * 1024; // decoded bytes per image
const MAX_ATTEMPTS = 5;
const FILES = ['front', 'back', 'selfie'];

// First bytes tell the real image type, whatever the client claims.
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}
function decodeImage(dataUrl) {
  const m = /^data:image\/(?:jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > MAX_IMG) return null;
  const ext = sniff(buf);
  return ext ? { buf, ext } : null;
}
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

module.exports = function mountAdmin(app, ctx) {
  const { users, save, verifyInitData, sendProfile, notify, send, round4, dataDir, runtime } = ctx;
  const logs = () => ctx.gamesLog; // read live: the server may replace the array when it trims it
  const kycDir = path.join(dataDir, 'kyc');

  // ---------- player: submit KYC ----------
  function authPlayer(req) {
    const v = verifyInitData(req.get('x-init-data'));
    if (v && v.user) return `tg${v.user.id}`;
    if (process.env.ALLOW_GUESTS === '1' && req.get('x-guest-id')) return `guest${String(req.get('x-guest-id')).replace(/\W/g, '').slice(0, 16) || 'x'}`;
    return null;
  }

  app.post('/api/kyc', express.json({ limit: '14mb' }), (req, res) => {
    const uid = authPlayer(req);
    const u = uid && users[uid];
    if (!u) return res.status(401).json({ error: 'Open the game from Telegram first' });
    if (u.banned) return res.status(403).json({ error: 'Account suspended' });
    const cur = u.kyc;
    if (cur && (cur.status === 'pending' || cur.status === 'approved')) return res.status(409).json({ error: `KYC already ${cur.status}` });
    if (cur && cur.attempts >= MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many attempts. Contact support.' });

    const b = req.body || {};
    const fullName = clean(b.fullName, 80), country = clean(b.country, 60), docNumber = clean(b.docNumber, 30).toUpperCase();
    const dob = clean(b.dob, 10);
    if (fullName.length < 2) return res.status(400).json({ error: 'Enter your full name as on the document' });
    if (country.length < 2) return res.status(400).json({ error: 'Enter your country' });
    if (!DOC_TYPES.includes(b.docType)) return res.status(400).json({ error: 'Choose a document type' });
    if (!/^[A-Z0-9][A-Z0-9 \-/]{3,29}$/.test(docNumber)) return res.status(400).json({ error: 'Enter a valid document number' });
    const born = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? new Date(`${dob}T00:00:00Z`) : null;
    if (!born || isNaN(born)) return res.status(400).json({ error: 'Enter your date of birth' });
    const age = (Date.now() - born.getTime()) / (365.25 * 864e5);
    if (age < 18) return res.status(400).json({ error: 'You must be at least 18 years old' });
    if (age > 110) return res.status(400).json({ error: 'Check your date of birth' });
    if (b.consent !== true) return res.status(400).json({ error: 'Please accept the consent statement' });

    const imgs = {};
    for (const k of FILES) {
      if (k === 'back' && !b.back) continue;
      const img = decodeImage(b[k]);
      if (!img) return res.status(400).json({ error: `The ${k === 'selfie' ? 'selfie' : `document ${k}`} photo is missing or not a valid image (JPG/PNG, max 3 MB)` });
      imgs[k] = img;
    }

    const dir = path.join(kycDir, uid);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const files = {};
    for (const [k, img] of Object.entries(imgs)) {
      files[k] = `${k}.${img.ext}`;
      fs.writeFileSync(path.join(dir, files[k]), img.buf, { mode: 0o600 });
    }
    u.kyc = {
      status: 'pending', submittedAt: Date.now(), attempts: ((cur && cur.attempts) || 0) + 1,
      fullName, dob, country, docType: b.docType, docNumber, files, reason: '', reviewedAt: null, reviewedBy: null,
    };
    if (process.env.KYC_AUTO_APPROVE === '1') Object.assign(u.kyc, { status: 'approved', reviewedAt: Date.now(), reviewedBy: 'auto (demo)' });
    save();
    sendProfile(uid);
    res.json({ ok: true, status: u.kyc.status });
  });

  // ---------- admin auth (HTTP Basic, set ADMIN_PASSWORD to enable) ----------
  const fails = new Map(); // ip -> { n, until }
  const sha = (x) => crypto.createHash('sha256').update(String(x)).digest();
  function adminAuth(req, res, next) {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    const pass = process.env.ADMIN_PASSWORD;
    if (!pass) return res.status(503).type('text').send('Admin is disabled. Set ADMIN_PASSWORD on the server.');
    const f = fails.get(req.ip);
    if (f && f.n >= 10 && f.until > Date.now()) return res.status(429).type('text').send('Too many attempts. Try again later.');
    const h = req.get('authorization') || '';
    const [user, ...rest] = Buffer.from(h.replace(/^Basic /i, ''), 'base64').toString().split(':');
    const ok = h.startsWith('Basic ')
      && crypto.timingSafeEqual(sha(user), sha(process.env.ADMIN_USER || 'admin'))
      && crypto.timingSafeEqual(sha(rest.join(':')), sha(pass));
    if (!ok) {
      if (h) fails.set(req.ip, { n: ((f && f.until > Date.now() ? f.n : 0) + 1), until: Date.now() + 10 * 60 * 1000 });
      res.set('WWW-Authenticate', 'Basic realm="Chess Arena admin"');
      return res.status(401).type('text').send('Authentication required');
    }
    fails.delete(req.ip);
    next();
  }

  app.get('/admin', adminAuth, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
  const api = express.Router();
  api.use(adminAuth, express.json({ limit: '10kb' }));

  const kycView = (u) => {
    const k = u.kyc || {};
    return {
      id: u.id, name: u.name, status: k.status || 'none', submittedAt: k.submittedAt || null, reviewedAt: k.reviewedAt || null,
      reviewedBy: k.reviewedBy || null, reason: k.reason || '', attempts: k.attempts || 0,
      fullName: k.fullName || '', dob: k.dob || '', country: k.country || '', docType: k.docType || '', docNumber: k.docNumber || '',
      files: Object.keys(k.files || {}),
    };
  };
  const userRow = (u) => ({
    id: u.id, name: u.name, wallet: u.wallet || null, balance: round4(u.balance), games: u.games, wins: u.wins, losses: u.losses, draws: u.draws,
    totalWon: round4(u.totalWon), net: round4((u.totalReturned || 0) - (u.totalFees || 0)), streak: u.streak || 0,
    createdAt: u.createdAt || null, banned: !!u.banned, online: runtime.online(u.id), kyc: (u.kyc && u.kyc.status) || 'none',
  });

  api.get('/summary', (_req, res) => {
    const list = Object.values(users);
    const count = (s) => list.filter((u) => ((u.kyc && u.kyc.status) || 'none') === s).length;
    const gamesLog = logs();
    const decided = gamesLog.filter((g) => g.winner !== 'draw');
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = Math.floor(Date.now() / 864e5) - i;
      days.push({ day: new Date(d * 864e5).toISOString().slice(5, 10), games: gamesLog.filter((g) => Math.floor(g.at / 864e5) === d).length });
    }
    res.json({
      users: list.length, online: runtime.online(), activeGames: runtime.activeGames(), queued: runtime.queued(),
      kyc: { none: count('none'), pending: count('pending'), approved: count('approved'), rejected: count('rejected') },
      withWallet: list.filter((u) => u.wallet).length, banned: list.filter((u) => u.banned).length,
      games: gamesLog.length, decided: decided.length,
      volume: round4(gamesLog.reduce((n, g) => n + g.pot, 0)), fees: round4(gamesLog.reduce((n, g) => n + g.fee, 0)),
      vsBot: gamesLog.filter((g) => g.white.id === 'bot' || g.black.id === 'bot').length,
      days,
      balances: round4(list.reduce((n, u) => n + u.balance, 0)),
    });
  });
  api.get('/users', (_req, res) => res.json(Object.values(users).map(userRow).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))));
  api.get('/kyc', (req, res) => {
    const st = String(req.query.status || '');
    res.json(Object.values(users).filter((u) => u.kyc && (!st || u.kyc.status === st)).map(kycView).sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0)));
  });
  api.get('/games', (_req, res) => res.json(logs().slice(-200).reverse()));

  const pick = (uid) => (/^\w+$/.test(uid) && users[uid]) || null;
  api.get('/kyc/:uid/:file', (req, res) => {
    const u = pick(req.params.uid);
    const f = u && u.kyc && u.kyc.files && u.kyc.files[req.params.file];
    if (!f || !FILES.includes(req.params.file)) return res.status(404).end();
    res.type(f.endsWith('png') ? 'png' : 'jpeg').sendFile(path.join(kycDir, u.id, f));
  });
  api.post('/kyc/:uid', (req, res) => {
    const u = pick(req.params.uid);
    if (!u || !u.kyc) return res.status(404).json({ error: 'Not found' });
    const { action } = req.body || {};
    const reason = clean(req.body && req.body.reason, 200);
    if (action === 'approve') Object.assign(u.kyc, { status: 'approved', reason: '' });
    else if (action === 'reject') {
      if (!reason) return res.status(400).json({ error: 'Add a reason so the player knows what to fix' });
      Object.assign(u.kyc, { status: 'rejected', reason });
    } else return res.status(400).json({ error: 'Unknown action' });
    Object.assign(u.kyc, { reviewedAt: Date.now(), reviewedBy: process.env.ADMIN_USER || 'admin' });
    save();
    sendProfile(u.id);
    if (u.kyc.status === 'approved') notify(u.id, '✅ Your identity is verified. Open the game, connect your wallet and play!');
    else notify(u.id, `❌ Verification was not approved: ${reason}. Open the game to submit again.`);
    send(u.id, { t: 'toast', msg: u.kyc.status === 'approved' ? 'Identity verified ✅' : 'Verification rejected' });
    res.json({ ok: true, kyc: kycView(u) });
  });
  api.post('/users/:uid/ban', (req, res) => {
    const u = pick(req.params.uid);
    if (!u) return res.status(404).json({ error: 'Not found' });
    u.banned = !!(req.body && req.body.banned);
    save();
    sendProfile(u.id);
    res.json({ ok: true, banned: u.banned });
  });
  app.use('/api/admin', api);
};
