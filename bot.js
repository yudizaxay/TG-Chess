const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const STATE_FILE = path.join(__dirname, 'bot-state.json');

module.exports = function startBot() {
  const token = process.env.BOT_TOKEN;
  const url = process.env.WEBAPP_URL;
  if (!token) return console.warn('BOT_TOKEN missing, Telegram bot disabled');
  if (!url) return console.warn('WEBAPP_URL missing, Telegram bot disabled');

  const bot = new TelegramBot(token, { polling: true });
  const keyboard = { inline_keyboard: [[{ text: '♟ Play Chess', web_app: { url } }]] };

  bot.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Play', web_app: { url } } })
    .catch((e) => console.warn('menu button:', e.message));

  // Keep the chat clean: send the new reply first (so it always shows), then remove the
  // user's command and the previous bot reply. A chat cleared on the user's side still
  // holds the old message server-side, so editing it in place would be invisible.
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first run */ }
  const lastReply = new Map(Object.entries(saved).map(([k, v]) => [Number(k), v])); // chatId -> bot message id
  const persist = () => fs.writeFile(STATE_FILE, JSON.stringify(Object.fromEntries(lastReply)), () => {});
  const queue = new Map(); // chatId -> promise chain
  const seen = new Set(); // handled message ids (guards against duplicate delivery)

  function reply(msg, text, extra = {}) {
    const chatId = msg.chat.id;
    const key = `${chatId}:${msg.message_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    console.log(`cmd ${JSON.stringify(msg.text)} chat=${chatId} msg=${msg.message_id}`);

    const run = async () => {
      const sent = await bot.sendMessage(chatId, text, { reply_markup: keyboard, ...extra });
      const stale = [msg.message_id];
      if (lastReply.has(chatId)) stale.push(lastReply.get(chatId));
      lastReply.set(chatId, sent.message_id);
      persist();
      await bot.deleteMessages(chatId, stale).catch(() => {});
    };
    queue.set(chatId, (queue.get(chatId) || Promise.resolve()).then(run).catch((e) => console.warn('reply:', e.message)));
  }

  bot.onText(/^\/start/, (msg) => reply(
    msg,
    '♟ *Chess Arena*\n\nStake a small entry fee, play a match, and claim the pot straight from the game.\n\nNo opponent in 40s? You play our bot.',
    { parse_mode: 'Markdown' },
  ));

  bot.onText(/^\/play/, (msg) => reply(msg, 'Ready for a match? Tap below to open the board.'));

  bot.onText(/^\/help/, (msg) => reply(
    msg,
    '*How it works*\n1. Tap Play and connect your TON wallet\n2. Pay the entry fee to join a match\n3. No opponent in 40s? You play our bot\n4. Win and claim the pot (minus 5% fee) right from the game\n\nDraws refund your entry fee.\n\nCommands: /play to open the game, /start for the welcome message.',
    { parse_mode: 'Markdown' },
  ));

  bot.on('polling_error', (e) => console.warn('polling:', e.message));
  console.log('Telegram bot polling');
};
