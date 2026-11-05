// Минимальный клиент Telegram Bot API без зависимостей + long polling.
const { sleep } = require("./util");

class TelegramError extends Error {
  constructor(method, data) {
    super(`Telegram ${method}: ${data.error_code} ${data.description}`);
    this.code = data.error_code;
    this.description = data.description;
    this.retryAfter = data.parameters?.retry_after;
  }
}

const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
];

class TelegramApi {
  constructor(token, { base = "https://api.telegram.org", log = console } = {}) {
    this.token = token;
    this.base = base.replace(/\/$/, "");
    this.log = log;
    this.me = null;
  }

  async call(method, params = {}, { timeoutMs = 20000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let data;
      try {
        const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: ctrl.signal,
        });
        data = await res.json().catch(() => ({ ok: false, error_code: res.status, description: res.statusText }));
      } finally {
        clearTimeout(t);
      }
      if (data.ok) return data.result;
      const err = new TelegramError(method, data);
      // Флуд-контроль: подождать и повторить один раз, если ждать недолго
      if (err.code === 429 && attempt === 0 && (err.retryAfter || 1) <= 10) {
        await sleep((err.retryAfter || 1) * 1000);
        continue;
      }
      throw err;
    }
  }

  async getMe() {
    this.me = await this.call("getMe");
    return this.me;
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", { chat_id: chatId, text, ...extra });
  }

  async downloadFile(fileId) {
    const file = await this.call("getFile", { file_id: fileId });
    const res = await fetch(`${this.base}/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`Не удалось скачать файл: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

// Long polling: getUpdates в цикле. onUpdate вызывается последовательно,
// но обработчик сам решает, ждать ли ему долгих операций.
class Poller {
  constructor(api, onUpdate, { log = console, timeoutSec = 25, getOffset, setOffset } = {}) {
    this.api = api;
    this.onUpdate = onUpdate;
    this.log = log;
    this.timeoutSec = timeoutSec;
    this.getOffset = getOffset || (() => 0);
    this.setOffset = setOffset || (() => {});
    this.running = false;
  }

  async start() {
    this.running = true;
    // Если раньше был вебхук — снимаем, иначе getUpdates не работает
    await this.api.call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
    this.loop = this.run();
  }

  async run() {
    let backoff = 1000;
    while (this.running) {
      try {
        const offset = this.getOffset();
        const updates = await this.api.call(
          "getUpdates",
          { offset: offset ? offset + 1 : undefined, timeout: this.timeoutSec, allowed_updates: ALLOWED_UPDATES },
          { timeoutMs: (this.timeoutSec + 10) * 1000 }
        );
        backoff = 1000;
        for (const u of updates) {
          if (!this.running) break;
          this.setOffset(u.update_id);
          try {
            await this.onUpdate(u);
          } catch (e) {
            this.log.error("Ошибка обработки апдейта", u.update_id, e);
          }
        }
      } catch (e) {
        if (!this.running) break;
        this.log.error("getUpdates:", e.message);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }

  stop() {
    this.running = false;
  }
}

module.exports = { TelegramApi, TelegramError, Poller, ALLOWED_UPDATES };
