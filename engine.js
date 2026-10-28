// Small material + centre-control engine. Deliberately weak so demo users can win.
const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

function evaluate(chess) {
  let score = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq) continue;
      const file = sq.square.charCodeAt(0) - 97;
      const rank = Number(sq.square[1]) - 1;
      const centre = 3.5 - Math.max(Math.abs(file - 3.5), Math.abs(rank - 3.5));
      const v = VAL[sq.type] + (sq.type === 'k' ? 0 : centre * 6);
      score += sq.color === 'w' ? v : -v;
    }
  }
  return score;
}

function negamax(chess, depth, alpha, beta) {
  if (depth === 0 || chess.isGameOver()) {
    if (chess.isCheckmate()) return -100000 - depth;
    if (chess.isDraw()) return 0;
    return chess.turn() === 'w' ? evaluate(chess) : -evaluate(chess);
  }
  let best = -Infinity;
  for (const m of chess.moves({ verbose: true })) {
    chess.move(m);
    const s = -negamax(chess, depth - 1, -beta, -alpha);
    chess.undo();
    if (s > best) best = s;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function pickMove(chess) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  if (Math.random() < 0.15) return moves[Math.floor(Math.random() * moves.length)];
  let best = null;
  let bestScore = -Infinity;
  for (const m of moves) {
    chess.move(m);
    const s = -negamax(chess, 1, -Infinity, Infinity) + (Math.random() * 40 - 20);
    chess.undo();
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

module.exports = { pickMove };
