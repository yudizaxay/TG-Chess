# TG Chess (demo)

Chess inside Telegram. Players connect a TON wallet, stake an entry fee, play a match and claim the pot straight from the game.

**Try it:** [@ytgchess_bot](https://t.me/ytgchess_bot) on Telegram. Send `/start` and tap **Play Chess**.

> **Demo build.** Wallet connection is real (TON Connect), but payments, the escrow contract and balances are mocked. No real chain transactions or funds are involved.

## Features

- **Telegram bot** with `/start`, `/play`, `/help` and a **Play** menu button that opens the WebApp. Each command removes the user's command and the bot's previous reply, so the chat stays clean
- **TON Connect**: connect Tonkeeper, Wallet in Telegram or any TON Connect wallet. The address is saved on the player's profile and is required to play
- **Staked matches**: 1 TON entry (demo balance), pot = 2 × entry, winner claims the pot minus a 5% platform fee. A draw refunds the entry fee
- **Matchmaking**: waits 40s for a human opponent, otherwise plays against the built-in bot (which stakes too)
- **Chess**: server-authoritative move validation, check / checkmate / stalemate / draw detection, 5 min clocks, resign, legal-move hints, sound effects
- **Lobby, History & Income, Settings**: stats, net profit, winnings, fees, win rate, per-game results, wallet info, test-TON faucet
- **5 themes** (Ocean blue by default, matching Telegram and TON): Ocean, Emerald, Amber, Violet, Rose. A theme restyles the whole app, not just the board

## Game flow

1. `/start` → **Play Chess**
2. **Connect wallet** (first time only) → **Play** → payment popup → **Confirm** (1 TON leaves the demo balance, fake tx hash)
3. "Finding opponent…" for up to 40s (cancel refunds the fee). A human match starts instantly, otherwise the bot joins
4. Play: tap a piece, then a highlighted square
5. Result screen → **Claim** → wallet popup → winnings are added to the balance

## Tech stack

Node.js, Express, `ws` (WebSocket), `chess.js` (rules), `node-telegram-bot-api` (long polling), vanilla JS frontend, `@tonconnect/ui` (vendored).

## Requirements

- Node.js 20.6 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- For local Telegram testing: `cloudflared` (`brew install cloudflared`)

## Configuration

```bash
npm install
cp .env.example .env     # then set BOT_TOKEN
```

| Variable | Meaning |
|---|---|
| `BOT_TOKEN` | Telegram bot token |
| `WEBAPP_URL` | Public https URL of this server. Optional on Render (it falls back to `RENDER_EXTERNAL_URL`), set automatically by `dev.sh` |
| `PORT` | Server port, default `3000` |

## Run locally

```bash
./dev.sh
```

Starts a Cloudflare quick tunnel (HTTP/2), then the server with `WEBAPP_URL` pointing at it. The bot re-registers its menu button on every start. The tunnel URL changes on every run, so send a fresh `/start` afterwards (buttons in old messages point to the old URL).

Without a tunnel, `npm run dev` serves on `http://localhost:3000`. The bot stays disabled unless `WEBAPP_URL` is set, but the app still works in a normal browser as a guest.

`npm start` runs `node server.js` without loading `.env`, which is what hosting platforms expect (set env vars in their dashboard).

## Deploy (Render)

1. Push the repo to GitHub
2. Render → **New** → **Web Service** → connect the repo (or use **Blueprint** with `render.yaml`)
3. Build command `npm install`, start command `npm start`, plan Free
4. Add the environment variable `BOT_TOKEN`
5. After the deploy, open `<your-service-url>/health`. It should return `{"ok":true}`. Then send `/start` to the bot
6. The free plan sleeps when idle, and a sleeping service cannot poll Telegram. Keep it awake with an uptime monitor pinging `/health` every 5 minutes
7. A bot token can be polled from one place only. Stop `./dev.sh` (and any other host) while the deployed service is live, otherwise Telegram returns `409 Conflict`
8. The free disk is temporary, so `data.json` (balances, history) resets on every redeploy

## Project layout

| File | Role |
|---|---|
| `server.js` | HTTP + WebSocket server, matchmaking, game state, mock wallet and claim logic, persistence |
| `engine.js` | Weak material-based bot opponent (depth 2, with random blunders) |
| `bot.js` | Telegram bot (`/start`, `/play`, `/help`, menu button, chat cleanup) |
| `public/` | WebApp: `index.html`, `style.css`, `app.js`, `pieces/*.svg`, `ton.svg`, `ton-icon.png`, `vendor/tonconnect-ui.min.js` |
| `dev.sh` | Local tunnel + server launcher |
| `render.yaml` | Render blueprint |
| `data.json` | Runtime only: balances, stats, history, wallet addresses (gitignored) |
| `bot-state.json` | Runtime only: last bot reply per chat, used for chat cleanup (gitignored) |

## TON Connect

- The client uses `@tonconnect/ui`, vendored in `public/vendor/`. The manifest is served at `/tonconnect-manifest.json` and built from the request host, so it follows whatever domain the app runs on.
- Connect and disconnect from the header button or from Settings. The friendly (`UQ…`) address is sent to the server (`wallet` message) and stored on the user.
- Demo limitation: the server trusts the address the client reports (no `ton_proof` verification).

## Going real later

The mock layer is isolated in `server.js` (`fakeHash`, the fee deduction in `joinQueue`, the `claim` handler). Replace those with real contract calls: verify the entry transaction before queueing, and have the contract release the pot to the winner on claim. In `public/app.js`, `openWallet` is where `tonUI.sendTransaction(...)` replaces the mock popup, and `ton_proof` should be added to verify wallet ownership on the server.

## Notes

- Telegram `initData` is verified server-side, and the app only works inside Telegram. In a normal browser it shows an "Open in Telegram" screen and the server rejects the connection. For local browser testing, set `ALLOW_GUESTS=1` and open the page with `?guest=1`.
- Game state lives in memory. A server restart ends running games and drops unclaimed winnings; balances and history are kept in `data.json`.
- Never commit `.env`. Revoke and rotate the bot token (BotFather → `/revoke`) if it has been shared.
- Piece artwork: cburnett set by Colin M.L. Burnett (via lichess). Check its licence before production use.
