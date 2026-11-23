// Запуск Telegram-бота: node bot/index.js (или npm run bot).
// Заведений может быть несколько (platform.js); управление с сервера — node bot/cli.js help.
require("./env").loadEnv();

const { loadConfig } = require("./config");
const { Llm } = require("./llm");
const { Platform } = require("./platform");
const { startControl } = require("./control");

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

  const llm = new Llm({ apiKey: cfg.anthropicApiKey, baseURL: cfg.anthropicBaseUrl, model: cfg.model, fallbacks: cfg.fallbacks, log });
  const platform = new Platform({ cfg, llm, log });
  await platform.init();
  await platform.startPolling();
  const control = startControl(platform, cfg.controlSocket, { log });
  const reminders = setInterval(() => platform.checkReminders(), 60000);

  const venues = platform.venueList().length;
  log.info(
    `Бот @${platform.sharedMe.username} запущен${platform.sharedConsoleMe ? `, панель мастера — @${platform.sharedConsoleMe.username}` : ""}. Заведений: ${venues}. Модель: ${cfg.model}.`
  );
  if (!platform.canManageBots()) {
    log.info(`Отдельные боты заведений одной кнопкой: включите для @${platform.sharedMe.username} в @BotFather «Managed Bots» и перезапустите бота.`);
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) {
      // Повторный Ctrl+C — выходим сразу
      platform.flush();
      process.exit(0);
    }
    stopping = true;
    log.info("Останавливаюсь…");
    clearInterval(reminders);
    control?.close();
    // Даём дописать начатые ответы: docker stop ждёт 10 с, потом убивает процесс.
    // Что не успело уйти, бот подхватит после запуска (App.resumePending).
    await platform.stop(7000);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
