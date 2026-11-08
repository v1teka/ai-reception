const path = require("path");

const num = (v, def) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : def);
const ids = (v) =>
  String(v || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
const off = (v) => /^(0|off|false|no|нет)$/i.test(String(v || "").trim());

function loadConfig(env = process.env) {
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN || "",
    // Необязательно: отдельный бот для панели мастера (удобно, когда один человек тестирует обе роли)
    adminBotToken: env.ADMIN_BOT_TOKEN || "",
    telegramApiBase: env.TELEGRAM_API_BASE || "https://api.telegram.org",
    ownerIds: ids(env.OWNER_IDS),
    adminIds: ids(env.ADMIN_IDS),

    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || undefined,
    model: env.ANTHROPIC_MODEL || "claude-opus-5-5",
    effort: env.ANTHROPIC_EFFORT || "low", // чат: важна скорость
    setupEffort: env.ANTHROPIC_SETUP_EFFORT || "medium", // разбор карточки и прайса
    fallbacks: !off(env.ANTHROPIC_FALLBACKS),
    yandexWebFetch: !off(env.YANDEX_WEB_FETCH),

    // YCLIENTS: ключ партнёра из кабинета разработчика (маркетплейс YCLIENTS → «Настройки аккаунта»)
    yclientsPartnerToken: env.YCLIENTS_PARTNER_TOKEN || "",
    yclientsApiBase: env.YCLIENTS_API_BASE || "https://api.yclients.com/api/v1",
    yclientsTimeoutMs: num(env.YCLIENTS_TIMEOUT_MS, 10000),

    llmTimeoutMs: num(env.LLM_TIMEOUT_MS, 30000),
    setupTimeoutMs: num(env.SETUP_TIMEOUT_MS, 120000),
    maxSteps: num(env.LLM_MAX_STEPS, 6),
    llmCallsPerHour: num(env.LLM_CALLS_PER_HOUR, 40),
    confidenceThreshold: num(env.CONFIDENCE_THRESHOLD, 0.6),

    typing: {
      baseMs: num(env.TYPING_BASE_MS, 400),
      perCharMs: num(env.TYPING_MS_PER_CHAR, 12),
      minMs: num(env.TYPING_MIN_MS, 800),
      maxMs: num(env.TYPING_MAX_MS, 4000),
      pauseMs: num(env.TYPING_PAUSE_MS, 500), // пауза между «пузырями»
    },
    debounceMs: num(env.DEBOUNCE_MS, 1500), // ждём, не допишет ли клиент ещё
    reminderMinutes: num(env.REMINDER_MINUTES, 120),
    dataFile: env.DATA_FILE || path.join(env.DATA_DIR || path.join(__dirname, "..", "data"), "state.json"),
  };
}

module.exports = { loadConfig };
