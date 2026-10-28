const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); try { tg.setHeaderColor('#0f1412'); tg.setBackgroundColor('#0f1412'); } catch {} }

const startParam = new URLSearchParams(location.search).get('sp') || (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
const hap = (kind, type) => { try { tg.HapticFeedback[kind](type); } catch {} }; // vibration inside Telegram
const $ = (id) => document.getElementById(id);
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const fmt = (n) => Number(n).toFixed(2);
const short = (h) => h.slice(0, 10) + '…' + h.slice(-8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let guestId = '';
try { guestId = localStorage.getItem('guestId') || (localStorage.setItem('guestId', Math.random().toString(36).slice(2, 10)), localStorage.getItem('guestId')); } catch { guestId = 'x' + Math.random().toString(36).slice(2, 8); }

let ws, profile, entryFee = 1, houseCut = 0.05, waitMs = 40000, stakes = [0.5, 1, 5], botName = 'ytgchess_bot';
let reviewIdx = null, challenge = null, challengeAsked = false;
let game = null, gameRecvAt = 0, selected = null, countdownTimer = null;
let walletMode = null; // 'join' | 'claim'
let pending = null; // resolver for the next server reply

const TABS = ['lobby', 'historyTab', 'ranksTab', 'settingsTab'];
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  const isTab = TABS.includes(id);
  $('nav').classList.toggle('hidden', !isTab);
  if (isTab) document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
  if (id === 'ranksTab') send({ t: 'lb' });
  window.scrollTo(0, 0);
}
document.querySelectorAll('#nav button').forEach((b) => { b.onclick = () => show(b.dataset.tab); });
$('seeAll').onclick = () => show('historyTab');
const onTab = () => TABS.some((t) => $(t).classList.contains('active'));
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2500);
}

// ---------- connection ----------
function connect() {
  if (!(tg && tg.initData) && !location.search.includes('guest=1')) { $('openTg').classList.remove('hidden'); return; }
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', initData: tg ? tg.initData : '', guestId, startParam }));
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connect, 1500);
}
const send = (m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));

function onMessage(m) {
  if (m.t === 'blocked') { $('openTg').classList.remove('hidden'); return; }
  if (m.t === 'profile') {
    houseCut = m.houseCut; waitMs = m.waitMs; stakes = m.stakes; botName = m.bot;
    if (!stakes.includes(settings.stake)) settings.stake = m.defaultStake;
    entryFee = settings.stake; buildChips();
    setProfile(m.profile);
    const ch = /^ch_(\w+)$/.exec(startParam);
    if (ch && !challengeAsked) { challengeAsked = true; send({ t: 'challengeInfo', host: ch[1] }); }
    if (tonReady && tonAddr !== (m.profile.wallet || null)) send({ t: 'wallet', address: tonAddr });
    if (!game && !$('searching').classList.contains('active') && !onTab()) show('lobby');
  } else if (m.t === 'paid') {
    setProfile(m.profile);
    if (pending) pending(m);
  } else if (m.t === 'queue') {
    startCountdown(m.endsAt, m.invite);
  } else if (m.t === 'cancelled') {
    setProfile(m.profile); stopCountdown(); show('lobby'); toast('Entry fee refunded');
  } else if (m.t === 'game') {
    onGame(m);
  } else if (m.t === 'claimed') {
    setProfile(m.profile);
    if (pending) pending(m);
  } else if (m.t === 'toast') {
    toast(m.msg);
  } else if (m.t === 'bonus') {
    setProfile(m.profile); hap('notificationOccurred', 'success'); toast(`+${fmt(m.amount)} TON daily bonus · day ${m.streak}`);
  } else if (m.t === 'lb') {
    renderLb(m);
  } else if (m.t === 'challenge') {
    challenge = m.expired ? null : m;
    $('challengeBox').classList.toggle('hidden', !challenge);
    if (challenge) { $('chTitle').textContent = `⚔ ${challenge.name} challenged you`; $('chSub').textContent = `Entry ${fmt(challenge.stake)} TON · winner takes ${fmt(challenge.stake * 2 * (1 - houseCut))}`; }
    else toast('This challenge has expired');
  } else if (m.t === 'rematchOffer') {
    $('rematchNote').textContent = `${m.name} wants a rematch. Tap Rematch to accept.`; hap('notificationOccurred', 'warning');
  } else if (m.t === 'rematchExpired') {
    setProfile(m.profile); $('rematchNote').textContent = 'No response. Entry fee refunded.';
  } else if (m.t === 'error') {
    toast(m.msg);
    if (pending) pending({ error: true });
  }
}

// ---------- lobby ----------
function setProfile(p) {
  profile = p;
  $('balance').textContent = fmt(p.balance);
  $('userName').textContent = p.name;
  $('feeLabel').textContent = $('feeBtn').textContent = entryFee;
  $('potLabel').textContent = fmt(entryFee * 2);
  $('prizePreview').textContent = fmt(entryFee * 2 * (1 - houseCut));
  $('sGames').textContent = p.games; $('sWins').textContent = p.wins;
  $('sLosses').textContent = p.losses; $('sWon').textContent = fmt(p.totalWon).replace(/0+$/, '').replace(/\.$/, '') || '0';
  const empty = '<div class="empty">No games yet</div>';
  $('history').innerHTML = p.history.length ? p.history.slice(0, 4).map(histItem).join('') : empty;
  $('historyAll').innerHTML = p.history.length ? p.history.map(histItem).join('') : empty;

  const net = p.net || 0;
  $('hNet').textContent = `${net > 0 ? '+' : ''}${fmt(net)} TON`;
  $('hNet').classList.toggle('neg', net < 0);
  $('hNetSub').textContent = net >= 0 ? 'Winnings minus entry fees' : 'Entry fees exceed winnings';
  $('hWon').textContent = fmt(p.totalWon); $('hSpent').textContent = fmt(p.totalFees || 0);
  $('hRate').textContent = (p.games ? Math.round((p.wins / p.games) * 100) : 0) + '%';
  $('dailyBox').classList.toggle('hidden', !p.dailyReady);
  $('dailySub').textContent = p.streak ? `Day ${p.streak + 1} streak. Claim free test TON` : 'Claim free test TON';
  $('refCount').textContent = p.referrals; $('streakCount').textContent = `${p.streak} day${p.streak === 1 ? '' : 's'}`;
  $('sName').textContent = p.name; $('sAvatar').textContent = p.name[0].toUpperCase();
  $('sAddr').textContent = addr(); $('setFee').textContent = `${entryFee} TON`;
}
function ago(t) {
  const m = Math.floor((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
}
function histItem(h) {
  const icon = { win: '🏆', loss: '✖', draw: '🤝' }[h.outcome];
  const net = h.net || 0;
  return `<div class="item"><div class="ico ${h.outcome}">${icon}</div>
    <div class="l"><b>vs ${esc(h.vs)}</b><span>${h.outcome === 'draw' ? 'Draw' : h.outcome === 'win' ? 'Won' : 'Lost'}${h.reason ? ' · ' + esc(h.reason) : ''} · ${ago(h.at)}</span></div>
    <div class="r"><span class="tag ${h.outcome}">${net > 0 ? '+' : ''}${fmt(net)}</span><small>pot ${fmt(h.pot)}</small></div></div>`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- fake wallet ----------
const shortAddr = (x) => (x && x.length > 16 ? x.slice(0, 6) + '…' + x.slice(-6) : x || '-');
function addr() { return tonAddr || (profile && profile.wallet) || ''; }
function openWallet(mode, amount) {
  walletMode = mode;
  $('walletAddr').textContent = shortAddr(addr());
  const join = mode !== 'claim';
  const stakeAmt = join ? (amount ?? entryFee) : amount;
  $('walletBody').innerHTML = [
    [join ? 'From' : 'To', shortAddr(addr())],
    ['Contract', 'ChessEscrow'],
    ['Function', join ? 'joinMatch()' : 'claimWinnings()'],
    [join ? 'Amount' : 'Payout', join ? `${stakeAmt} TON` : `+${fmt(amount)} TON`],
    ['Network fee', '~0.01 TON'],
  ].map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('')
    + `<div class="row total"><span>Total</span><b>${join ? fmt(stakeAmt + 0.01) + ' TON' : '0.01 TON (gas)'}</b></div>`;
  $('walletActions').classList.remove('hidden');
  $('wallet').classList.remove('hidden');
}
function walletState(html) { $('walletBody').innerHTML = `<div class="state">${html}</div>`; $('walletActions').classList.add('hidden'); }
const waitReply = () => new Promise((res) => { pending = (m) => { pending = null; res(m); }; });
function closeWallet() { $('wallet').classList.add('hidden'); }

$('playBtn').onclick = () => {
  if (!tonAddr) return tonUI ? tonUI.openModal() : toast('TON Connect failed to load');
  if (profile.balance < entryFee) return toast('Insufficient balance');
  openWallet('join');
};
$('challengeBtn').onclick = () => {
  if (!tonAddr) return tonUI ? tonUI.openModal() : toast('TON Connect failed to load');
  if (profile.balance < entryFee) return toast('Insufficient balance');
  openWallet('invite');
};
$('chAccept').onclick = () => {
  if (!tonAddr) return tonUI ? tonUI.openModal() : toast('TON Connect failed to load');
  if (profile.balance < challenge.stake) return toast('Insufficient balance');
  openWallet('accept', challenge.stake);
};
$('dailyBtn').onclick = () => send({ t: 'daily' });
function shareLink(link, text) {
  const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
  if (tg && tg.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank');
}
$('inviteBtn').onclick = () => shareLink(`https://t.me/${botName}?start=ref_${profile.id}`, '♟ Play chess for TON with me on Chess Arena. Join through my link and we both get +2 TON.');
$('shareChallenge').onclick = () => shareLink(`https://t.me/${botName}?start=ch_${profile.id}`, `⚔ I challenge you to a chess match on Chess Arena. Entry ${entryFee} TON, winner takes the pot.`);
$('walletReject').onclick = closeWallet;
$('walletConfirm').onclick = async () => {
  const mode = walletMode;
  walletState('<div class="spinner"></div><b>Confirm in progress…</b><div class="muted small">Waiting for block confirmation</div>');
  await sleep(1400);
  const reply = waitReply();
  const level = settings.level;
  send({
    join: { t: 'join', stake: entryFee, level },
    invite: { t: 'join', stake: entryFee, level, invite: true },
    accept: { t: 'accept', host: challenge && challenge.host },
    rematch: { t: 'rematch', gameId: game && game.id },
    claim: { t: 'claim', gameId: game && game.id },
  }[mode]);
  const r = await reply;
  if (r.error) return closeWallet();
  walletState(`<div style="font-size:42px">✅</div><b>Transaction confirmed</b><div class="muted small" style="word-break:break-all">${short(r.txHash)}</div>`);
  await sleep(1100);
  closeWallet();
  if (mode === 'accept') { challenge = null; $('challengeBox').classList.add('hidden'); }
  if (mode === 'rematch') $('rematchNote').textContent = 'Waiting for your opponent…';
  if (mode === 'claim') {
    $('claimTx').textContent = 'tx ' + short(r.txHash);
    $('claimBtn').classList.add('hidden');
    $('resAmount').textContent = `+${fmt(r.amount)} TON received`;
  }
};

// ---------- queue ----------
function startCountdown(endsAt, invite) {
  show('searching'); stopCountdown();
  $('countdown').parentNode.classList.toggle('hidden', !!invite);
  $('shareChallenge').classList.toggle('hidden', !invite);
  $('searchNote').textContent = invite ? 'Waiting for your friend to accept your challenge' : 'Bot joins if nobody shows up';
  if (invite) return;
  const tick = () => { $('countdown').textContent = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)); };
  tick(); countdownTimer = setInterval(tick, 250);
}
function stopCountdown() { clearInterval(countdownTimer); countdownTimer = null; }
$('cancelBtn').onclick = () => send({ t: 'cancel' });

// ---------- game ----------
function onGame(g) {
  const first = !game || game.id !== g.id;
  const prevLen = game && game.id === g.id ? game.history.length : g.history.length;
  if (g.history.length > prevLen) { playSound(g.history[g.history.length - 1]); if (g.history.length % 2 !== (g.you === 'w' ? 1 : 0)) hap('impactOccurred', 'light'); }
  if (game && game.id === g.id && !game.over && g.over) playSound('end');
  game = g; gameRecvAt = Date.now(); stopCountdown();
  if (first) { reviewIdx = null; $('rematchNote').textContent = ''; selected = null; $('result').classList.add('hidden'); $('claimBtn').classList.remove('hidden'); $('claimTx').textContent = ''; }
  show('game'); render();
  if (g.over && $('result').dataset.shown !== g.id) showResult();
}

function parseFen(fen) {
  const rows = fen.split(' ')[0].split('/');
  return rows.map((r) => { const out = []; for (const ch of r) { if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) out.push(null); else out.push(ch); } return out; });
}

function render() {
  const g = game, rv = reviewIdx !== null && g.review;
  const fen = rv ? g.review.fens[reviewIdx] : g.fen;
  const grid = parseFen(fen);
  const lastMove = rv ? (reviewIdx > 0 ? g.review.hv[reviewIdx - 1] : null) : g.lastMove;
  const legal = rv ? [] : g.legal, inCheck = !rv && g.check;
  $('reviewBar').classList.toggle('hidden', !rv);
  if (rv) $('rvPos').textContent = `${reviewIdx} / ${g.review.fens.length - 1}`;
  const flip = g.you === 'b';
  const legalFrom = new Set(legal.map((m) => m.from));
  const targets = new Set(selected ? legal.filter((m) => m.from === selected).map((m) => m.to) : []);
  let kingSq = null;
  if (inCheck) {
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const p = grid[r][f];
      if (p && p.toLowerCase() === 'k' && (p === p.toUpperCase() ? 'w' : 'b') === g.turn) kingSq = 'abcdefgh'[f] + (8 - r);
    }
  }
  let html = '';
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const r = flip ? 7 - i : i, f = flip ? 7 - j : j;
    const sq = 'abcdefgh'[f] + (8 - r), p = grid[r][f];
    const cls = ['sq', (r + f) % 2 === 0 ? 'l' : 'd'];
    if (lastMove && (lastMove.from === sq || lastMove.to === sq)) cls.push('last');
    if (selected === sq) cls.push('sel');
    if (targets.has(sq)) cls.push('tgt', p ? 'cap' : 'x');
    if (kingSq === sq) cls.push('chk');
    html += `<div class="${cls.join(' ')}" data-sq="${sq}">`
      + (j === 0 ? `<span class="coord r">${8 - r}</span>` : '')
      + (i === 7 ? `<span class="coord f">${'abcdefgh'[f]}</span>` : '')
      + (p ? `<span class="pc ${p === p.toUpperCase() ? 'w' : 'b'}${p.toUpperCase()}"></span>` : '') + '</div>';
  }
  $('board').innerHTML = html;
  $('board').onclick = (e) => {
    const el = e.target.closest('.sq'); if (!el) return;
    const sq = el.dataset.sq;
    if (selected && targets.has(sq)) { send({ t: 'move', from: selected, to: sq }); hap('impactOccurred', 'medium'); selected = null; return; }
    selected = legalFrom.has(sq) && selected !== sq ? sq : null;
    if (selected) hap('selectionChanged');
    render();
  };

  const me = g.you === 'w' ? g.white : g.black, opp = g.you === 'w' ? g.black : g.white;
  $('meName').textContent = me.name + ' (you)'; $('oppName').textContent = opp.name;
  $('oppAvatar').textContent = opp.id === 'bot' ? '🤖' : opp.name[0].toUpperCase();
  $('meAvatar').textContent = me.name[0].toUpperCase();
  $('gPot').textContent = fmt(g.pot); $('gPrize').textContent = fmt(g.prize);
  $('resignBtn').disabled = !!g.over;

  // captured pieces (what each side has taken)
  const have = { w: { ...START_COUNT }, b: { ...START_COUNT } };
  for (const row of grid) for (const p of row) if (p && p.toLowerCase() !== 'k') have[p === p.toUpperCase() ? 'w' : 'b'][p.toLowerCase()]--;
  const taken = (color) => ['q', 'r', 'b', 'n', 'p'].map((t) => GLYPH[t].repeat(Math.max(0, have[color][t]))).join('') ;
  const oppColor = g.you === 'w' ? 'b' : 'w';
  const PV = { q: 9, r: 5, b: 3, n: 3, p: 1 };
  const lost = (color) => Object.entries(PV).reduce((n, [t, v]) => n + v * Math.max(0, have[color][t]), 0);
  const diff = lost(oppColor) - lost(g.you); // positive: I am ahead in material
  $('meCaptured').innerHTML = taken(oppColor) + (diff > 0 ? `<span class="adv">+${diff}</span>` : '');
  $('oppCaptured').innerHTML = taken(g.you) + (diff < 0 ? `<span class="adv">+${-diff}</span>` : '');
  $('drawBtn').disabled = !!g.over || g.drawSent; $('drawBtn').textContent = g.drawSent ? 'Offered' : '½ Draw';
  $('drawBanner').classList.toggle('hidden', !g.drawOffer || !!g.over);

  const mv = g.history; let mhtml = '';
  for (let i = 0; i < mv.length; i += 2) mhtml += `${i / 2 + 1}. ${mv[i]} ${mv[i + 1] || ''}  `;
  $('moves').textContent = mhtml; $('moves').scrollTop = 1e6;
  tickClocks();
}

function tickClocks() {
  if (!game) return;
  const g = game, el = Date.now() - gameRecvAt;
  for (const [c, id] of [['w', g.you === 'w' ? 'meClock' : 'oppClock'], ['b', g.you === 'b' ? 'meClock' : 'oppClock']]) {
    const active = !g.over && g.turn === c;
    const ms = Math.max(0, g.clocks[c] - (active ? el : 0));
    const s = Math.ceil(ms / 1000), node = $(id);
    node.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    node.classList.toggle('active', active); node.classList.toggle('me', id === 'meClock'); node.classList.toggle('low', s <= 30);
  }
}
setInterval(tickClocks, 250);

$('drawBtn').onclick = () => send({ t: 'draw' });
$('drawYes').onclick = () => send({ t: 'drawAccept' });
$('drawNo').onclick = () => send({ t: 'drawDecline' });
$('resignBtn').onclick = () => {
  const b = $('resignBtn');
  if (b.dataset.armed) { delete b.dataset.armed; b.textContent = 'Resign'; return send({ t: 'resign' }); }
  b.dataset.armed = '1'; b.textContent = 'Tap again';
  setTimeout(() => { delete b.dataset.armed; b.textContent = 'Resign'; }, 2500);
};

// ---------- result ----------
function showResult() {
  const g = game; $('result').dataset.shown = g.id;
  const won = g.over.winner === g.you, draw = g.over.winner === 'draw';
  $('resIcon').textContent = draw ? '🤝' : won ? '🏆' : '😔';
  $('resTitle').textContent = draw ? 'Draw' : won ? 'You won!' : 'You lost';
  $('resReason').textContent = g.over.reason;
  $('rematchNote').textContent = '';
  hap('notificationOccurred', draw ? 'warning' : won ? 'success' : 'error');
  $('shareBtn').classList.toggle('hidden', !won);
  $('claimTx').textContent = '';
  if (g.claim) {
    $('resAmount').textContent = `${draw ? 'Refund ' : ''}${fmt(g.claim.amount)} TON`;
    $('claimBtn').textContent = draw ? 'Claim refund' : 'Claim winnings';
    $('claimBtn').classList.toggle('hidden', g.claim.claimed);
  } else {
    $('resAmount').textContent = `-${fmt(g.stake)} TON`; $('claimBtn').classList.add('hidden');
  }
  setTimeout(() => $('result').classList.remove('hidden'), 700);
}
$('rematchBtn').onclick = () => {
  if (profile.balance < game.stake) return toast('Insufficient balance');
  openWallet('rematch', game.stake);
};
$('reviewBtn').onclick = () => { reviewIdx = game.review.fens.length - 1; $('result').classList.add('hidden'); render(); };
const rvGo = (i) => { reviewIdx = Math.max(0, Math.min(game.review.fens.length - 1, i)); render(); };
$('rvFirst').onclick = () => rvGo(0); $('rvPrev').onclick = () => rvGo(reviewIdx - 1);
$('rvNext').onclick = () => rvGo(reviewIdx + 1); $('rvLast').onclick = () => rvGo(1e6);
$('rvBack').onclick = () => { reviewIdx = null; render(); $('result').classList.remove('hidden'); };
$('shareBtn').onclick = () => shareLink(`https://t.me/${botName}?start=ref_${profile.id}`, `🏆 I just won ${fmt(game.claim ? game.claim.amount : 0)} TON on Chess Arena! Think you can beat me?`);
$('claimBtn').onclick = () => openWallet('claim', game.claim.amount);
$('againBtn').onclick = () => { $('result').classList.add('hidden'); game = null; reviewIdx = null; send({ t: 'profile' }); show('lobby'); };

// ---------- lobby chips + leaderboard ----------
function buildChips() {
  $('stakeChips').innerHTML = stakes.map((x) => `<button class="chip${x === settings.stake ? ' on' : ''}" data-v="${x}">${x} TON</button>`).join('');
  $('levelChips').innerHTML = ['easy', 'medium', 'hard'].map((l) => `<button class="chip${l === settings.level ? ' on' : ''}" data-v="${l}">${l[0].toUpperCase() + l.slice(1)}</button>`).join('');
}
function saveSettings() { try { localStorage.setItem('settings.v2', JSON.stringify(settings)); } catch {} }
$('stakeChips').onclick = (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  settings.stake = Number(b.dataset.v); entryFee = settings.stake; saveSettings(); buildChips(); if (profile) setProfile(profile);
};
$('levelChips').onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; settings.level = b.dataset.v; saveSettings(); buildChips(); };
function renderLb(m) {
  $('myRank').textContent = m.rank ? `#${m.rank}` : '-';
  $('myRankSub').textContent = m.rank ? `of ${m.total} ranked players` : 'Play a game to get ranked';
  $('lbList').innerHTML = m.rows.length ? m.rows.map((r, i) => `<div class="lb-row${profile && r.id === profile.id ? ' me' : ''}"><div class="rk">${['🥇', '🥈', '🥉'][i] || i + 1}</div><div class="nm"><b>${esc(r.name)}</b><span>${r.wins} wins · ${r.games} games</span></div><div class="amt">${fmt(r.totalWon)} TON</div></div>`).join('') : '<div class="empty">No ranked players yet</div>';
}

// ---------- settings ----------
const THEMES = {
  green: { bg: '#0f1412', accent: '#7bd88f', ink: '#0b1f12' },
  amber: { bg: '#15110d', accent: '#f0b35a', ink: '#2a1805' },
  ocean: { bg: '#0b1220', accent: '#2aabee', ink: '#04152e' },
  violet: { bg: '#120e1c', accent: '#b48cff', ink: '#1c0b3a' },
  rose: { bg: '#1a0e13', accent: '#ff7a9c', ink: '#3a0716' },
};
const BOARDS = { ocean: ['Ocean', '#dbe7f5', '#5b87c0'], green: ['Emerald', '#ebecd0', '#739552'], amber: ['Classic', '#f0d9b5', '#b58863'], violet: ['Violet', '#e6dcf5', '#8a6bc0'], rose: ['Rose', '#f6dde3', '#c0788a'] };
const PIECES = { cburnett: 'Classic', merida: 'Merida', alpha: 'Alpha', staunty: 'Staunty', anarcandy: 'Candy' };
const settings = Object.assign({ theme: 'ocean', pieces: 'cburnett', hints: true, sound: true, stake: 1, level: 'medium' }, (() => { try { return JSON.parse(localStorage.getItem('settings.v2')); } catch { return null; } })());
function applySettings() {
  if (!THEMES[settings.theme]) settings.theme = 'ocean';
  if (!PIECES[settings.pieces]) settings.pieces = 'cburnett';
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.dataset.pieces = settings.pieces;
  document.querySelectorAll('.boardStrip .opt').forEach((b) => b.classList.toggle('on', b.dataset.k === settings.theme));
  document.querySelectorAll('.pieceStrip .opt').forEach((b) => b.classList.toggle('on', b.dataset.k === settings.pieces));
  const t = THEMES[settings.theme];
  if (tg) { try { tg.setHeaderColor(t.bg); tg.setBackgroundColor(t.bg); } catch {} }
  if (tonUI && window.TON_CONNECT_UI) {
    try { tonUI.uiOptions = { uiPreferences: { theme: TON_CONNECT_UI.THEME.DARK, colorsSet: { [TON_CONNECT_UI.THEME.DARK]: { connectButton: { background: t.accent, foreground: t.ink } } } } }; } catch {}
  }
  document.body.classList.toggle('nohints', !settings.hints);
  document.querySelectorAll('#themes .sw').forEach((b) => b.classList.toggle('on', b.dataset.theme === settings.theme));
  $('optHints').checked = settings.hints; $('optSound').checked = settings.sound;
  try { localStorage.setItem('settings.v2', JSON.stringify(settings)); } catch {}
}
// slider on the game screen: board colours and piece sets
document.querySelectorAll('.boardStrip').forEach((el) => { el.innerHTML = Object.entries(BOARDS).map(([k, [n, a, b]]) => `<button class="opt" data-k="${k}"><i class="prev" style="--a:${a};--b:${b}"></i>${n}</button>`).join(''); });
document.querySelectorAll('.pieceStrip').forEach((el) => { el.innerHTML = Object.entries(PIECES).map(([k, n]) => `<button class="opt" data-k="${k}"><img src="pieces/${k}/wN.svg" alt="">${n}</button>`).join(''); });
// make every strip scrollable on desktop too: wheel, drag, and arrow buttons
document.querySelectorAll('.strip').forEach((el) => {
  const wrap = document.createElement('div'); wrap.className = 'strip-wrap';
  el.parentNode.insertBefore(wrap, el); wrap.appendChild(el);
  for (const [cls, ch, dir] of [['l', '‹', -1], ['r', '›', 1]]) {
    const a = document.createElement('button'); a.className = 'arr ' + cls; a.textContent = ch;
    a.onclick = () => el.scrollBy({ left: dir * 180, behavior: 'smooth' }); wrap.appendChild(a);
  }
  el.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { el.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  let sx = 0, sl = 0, down = false, moved = false;
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') return; down = true; moved = false; sx = e.clientX; sl = el.scrollLeft; });
  window.addEventListener('pointermove', (e) => { if (!down) return; const dx = e.clientX - sx; if (Math.abs(dx) > 4) { moved = true; el.classList.add('drag'); } if (moved) el.scrollLeft = sl - dx; });
  window.addEventListener('pointerup', () => { down = false; el.classList.remove('drag'); });
  el.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
});
document.querySelectorAll('.boardStrip').forEach((el) => { el.onclick = (e) => { const b = e.target.closest('.opt'); if (b) { settings.theme = b.dataset.k; applySettings(); } }; });
document.querySelectorAll('.pieceStrip').forEach((el) => { el.onclick = (e) => { const b = e.target.closest('.opt'); if (b) { settings.pieces = b.dataset.k; applySettings(); } }; });
document.querySelectorAll('#themes .sw').forEach((b) => { b.onclick = () => { settings.theme = b.dataset.theme; applySettings(); }; });
$('optHints').onchange = (e) => { settings.hints = e.target.checked; applySettings(); };
$('optSound').onchange = (e) => { settings.sound = e.target.checked; applySettings(); };
$('faucetBtn').onclick = () => { send({ t: 'faucet' }); toast('10 test TON added'); };
$('copyAddr').onclick = () => { if (!addr()) return toast('No wallet connected'); try { navigator.clipboard.writeText(addr()); } catch {} toast('Address copied'); };

// ---------- TON Connect ----------
let tonUI = null, tonAddr = null, tonReady = false;
function updateWalletUI() {
  const on = !!tonAddr;
  $('balState').textContent = on ? 'Wallet connected' : 'Wallet not connected';
  $('balState').classList.toggle('ok', on);
  $('playLbl').textContent = on ? 'Play for' : 'Connect wallet to play ·';
  $('setWalletState').textContent = on ? 'Connected' : 'Not connected';
  $('setWalletAddr').textContent = on ? shortAddr(tonAddr) : '-';
  $('sAddr').textContent = on ? shortAddr(tonAddr) : 'No wallet connected';
  $('walletToggle').textContent = on ? 'Disconnect wallet' : 'Connect TON wallet';
  $('walletToggle').classList.toggle('primary', !on);
  $('walletToggle').classList.toggle('ghost', on);
}
$('walletToggle').onclick = () => { if (!tonUI) return toast('TON Connect failed to load'); tonAddr ? tonUI.disconnect() : tonUI.openModal(); };
function initTon() {
  if (!window.TON_CONNECT_UI) { tonReady = false; return; }
  tonUI = new TON_CONNECT_UI.TonConnectUI({
    manifestUrl: `${location.origin}/tonconnect-manifest.json`,
    buttonRootId: 'tonBtn',
    actionsConfiguration: { twaReturnUrl: 'https://t.me/ytgchess_bot' },
  });
  tonUI.onStatusChange((w) => {
    tonAddr = w ? TON_CONNECT_UI.toUserFriendlyAddress(w.account.address, w.account.chain === '-3') : null;
    tonReady = true;
    updateWalletUI();
    send({ t: 'wallet', address: tonAddr });
  });
}
applySettings();
initTon();
applySettings();
updateWalletUI();

let audio;
function playSound(san) {
  if (!settings.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), gn = audio.createGain();
    const cap = san === 'end' ? 2 : /x/.test(san) ? 1 : 0;
    o.type = 'triangle'; o.frequency.value = [440, 300, 220][cap];
    gn.gain.setValueAtTime(0.15, audio.currentTime); gn.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + (cap === 2 ? 0.5 : 0.12));
    o.connect(gn); gn.connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.5);
  } catch {}
}

connect();
