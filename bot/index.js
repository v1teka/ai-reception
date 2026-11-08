// Запуск Telegram-бота: node bot/index.js (или npm run bot)
const fs = require("fs");
const path = require("path");

// Подхватываем .env, если он есть
try {
  for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    const v = m[2].trim();
    process.env[m[1]] = /^["']/.test(v) ? v.replace(/^["']|["']$/g, "") : v.replace(/\s+#.*$/, "");
  }
} catch {}

const { loadConfig } = require("./config");
const { Store } = require("./store");
const { TelegramApi, Poller } = require("./telegram");
const { Llm } = require("./llm");
const { App } = require("./app");

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), "WARN", ...a),
  error: (...a) => console.error(new Date().toISOString(), "ERROR", ...a),
};

async function main() {
  const cfg = loadConfig();
  if (!cfg.telegramToken) {
    console.error("Нужен TELEGRAM_BOT_TOKEN (получить у @BotFather). См. README.");
    process.exit(1);
  }
  if (!cfg.anthropicApiKey) log.warn("ANTHROPIC_API_KEY не задан — ИИ не сможет отвечать, все сообщения уйдут мастеру.");

  const store = new Store(cfg.dataFile, { log });
  store.load();
  const api = new TelegramApi(cfg.telegramToken, { base: cfg.telegramApiBase, log });
  const consoleApi = cfg.adminBotToken ? new TelegramApi(cfg.adminBotToken, { base: cfg.telegramApiBase, log }) : null;
  const llm = new Llm({ apiKey: cfg.anthropicApiKey, baseURL: cfg.anthropicBaseUrl, model: cfg.model, fallbacks: cfg.fallbacks, log });
  const app = new App({ cfg, store, api, consoleApi, llm, log });
  await app.init();

  const offsets = store.state.offsets;
  const pollers = [
    new Poller(api, (u) => app.handleUpdate(u, "main"), {
      log,
      getOffset: () => offsets.main || 0,
      setOffset: (id) => ((offsets.main = id), store.save()),
    }),
  ];
  if (consoleApi) {
    pollers.push(
      new Poller(consoleApi, (u) => app.handleUpdate(u, "console"), {
        log,
        getOffset: () => offsets.console || 0,
        setOffset: (id) => ((offsets.console = id), store.save()),
      })
    );
  }
  for (const p of pollers) await p.start();
  const reminders = setInterval(() => app.run(() => app.checkReminders()), 60000);

  log.info(
    `Бот @${app.me.username} запущен${consoleApi ? `, панель мастера — @${app.consoleMe.username}` : ""}. Модель: ${cfg.model}.`
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) {
      // Повторный Ctrl+C — выходим сразу
      store.flush();
      process.exit(0);
    }
    stopping = true;
    log.info("Останавливаюсь…");
    clearInterval(reminders);
    for (const p of pollers) p.stop();
    // Даём дописать начатые ответы: docker stop ждёт 10 с, потом убивает процесс.
    // Что не успело уйти, бот подхватит после запуска (App.resumePending).
    await app.idle(7000).catch(() => log.warn("Не все ответы успели уйти — отвечу после перезапуска."));
    store.flush();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
