# TG Chess (demo)

Telegram bot + WebApp chess where players stake an entry fee and the winner claims the pot.
**This is a demo build: the wallet, transactions and smart contract are mocked. No real chain or real funds are involved.**

## Features

- Telegram bot (`/start`, menu button) that opens the chess WebApp
- **TON Connect**: users connect their TON wallet (Tonkeeper, etc.); the address is stored on their profile and required to play
- Mock payment popup (TON branded) for the entry fee (`joinMatch()`) and for payouts (`claimWinnings()`)
- Matchmaking: waits 40s for a human opponent, otherwise plays against a built-in bot (the bot stakes too)
- Server-authoritative chess (move validation, check/mate/stalemate/draw, 5 min clocks, resign)
- Pot = 2 × entry fee. Winner claims pot minus 5% platform fee. Draw refunds the entry fee
- Lobby stats, History & Income tab (net profit, winnings, fees, win rate, per-game results)
- Settings: board theme, legal-move hints, sound, wallet info, test-TON faucet

## Requirements

- Node.js 20.6+ (uses `node --env-file`)
- `cloudflared` for the tunnel (`brew install cloudflared`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

```bash
npm install
cp .env.example .env     # then set BOT_TOKEN
```

`.env`

| Variable | Meaning |
|---|---|
| `BOT_TOKEN` | Telegram bot token |
| `WEBAPP_URL` | Public https URL of this server (set automatically by `dev.sh`) |
| `PORT` | Server port, default `3000` |

## Run

```bash
./dev.sh
```

Starts a Cloudflare quick tunnel, then the server with `WEBAPP_URL` pointing at it. The bot re-registers its menu button on every start, so the changed URL needs no manual step.

Then open the bot in Telegram and send `/start`. After a restart the URL changes, so send a fresh `/start` (old chat buttons point to the old URL).

Without a tunnel: `npm start` serves on `http://localhost:3000`. The bot stays disabled unless `WEBAPP_URL` is set, but the app works in a normal browser as a guest.

## Game flow

1. `/start` → **Play Chess**
2. **Connect wallet** (TON Connect button, first time only) → **Play** → payment popup → **Confirm** (1 TON leaves the demo balance, fake tx hash)
3. "Finding opponent…" for 40s (cancel refunds the fee). A human match starts instantly; otherwise the bot joins
4. Play. Tap a piece, then a highlighted square
5. Result screen → **Claim** → wallet popup → winnings added to the balance

## Project layout

| File | Role |
|---|---|
| `server.js` | HTTP + WebSocket server, matchmaking, game state, mock wallet/claim logic, persistence |
| `engine.js` | Weak material-based bot opponent (depth 2, random blunders) |
| `bot.js` | Telegram bot (`/start`, menu button) |
| `public/` | WebApp: `index.html`, `style.css`, `app.js`, `pieces/*.svg`, `ton.svg`, `ton-icon.png`, `vendor/tonconnect-ui.min.js` |
| `dev.sh` | Tunnel + server launcher |
| `data.json` | Created at runtime: user balances, stats, history (gitignored) |

## TON Connect

- The client uses `@tonconnect/ui` (vendored in `public/vendor/`). The manifest is served at `/tonconnect-manifest.json` and is built from the request host, so it follows the tunnel URL automatically.
- Connect/disconnect is available from the header button and from Settings. The friendly (UQ…) address is sent to the server (`wallet` message) and saved on the user.
- Demo limitation: the server trusts the address the client reports (no `ton_proof` verification), and payments are still mocked. Amounts are in a demo TON balance (10 TON from the faucet/start).

## Going real later

The mock layer is isolated in `server.js` (`fakeHash`, `joinQueue` fee deduction, the `claim` handler). Replace those with real contract calls: verify the entry transaction before queueing, and have the contract release the pot to the winner on claim. In `public/app.js`, `openWallet` is where `tonUI.sendTransaction(...)` would replace the mock popup, and `ton_proof` should be added to verify wallet ownership on the server.

## Notes

- Telegram `initData` is verified server-side. Unsigned guest sessions are allowed so the app can be tested in a plain browser; remove that before production.
- Revoke and rotate the bot token (BotFather → `/revoke`) if it has been shared.
- Piece artwork: cburnett set by Colin M.L. Burnett (via lichess), check its licence before production use.
