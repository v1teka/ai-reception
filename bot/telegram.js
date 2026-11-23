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
  // Реакции клиента в чате с ботом (Telegram присылает их, только если попросить явно)
  "message_reaction",
  // Бот создан через t.me/newbot/<наш бот>/… и передан нам в управление (Telegram Managed Bots, см. platform.js)
  "managed_bot",
];

class TelegramApi {
  constructor(token, { base = "https://api.telegram.org", log = console } = {}) {
    this.token = token;
    this.base = base.replace(/\/$/, "");
    this.log = log;
    this.me = null;
  }

  async call(method, params = {}, { timeoutMs = 20000, body = null } = {}) {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let data;
      try {
        const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
          method: "POST",
          ...(body ? { body: body() } : { headers: { "content-type": "application/json" }, body: JSON.stringify(params) }),
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

  // Отправить файл (sendPhoto, sendDocument…) загрузкой, а не по file_id: file_id другого бота не подходит
  upload(method, params, field, buffer, filename) {
    const body = () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(params)) if (v != null) form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      form.append(field, new Blob([buffer]), filename);
      return form;
    };
    return this.call(method, params, { timeoutMs: 60000, body });
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

// Один общий бот на несколько заведений: к callback_data кнопок дописываем заведение («v2|c:open:5»), чтобы нажатие
// попало туда, откуда пришло сообщение, даже если человек с тех пор переключился на другое (см. Platform.routeCallback).
// Остальное — как у TelegramApi, которому этот объект и передаёт вызовы.
const TAG_RE = /^(v\d+)\|([\s\S]*)$/;

function tagMarkup(markup, tag) {
  if (!Array.isArray(markup?.inline_keyboard)) return markup;
  const row = (r) => r.map((b) => (typeof b.callback_data === "string" && !TAG_RE.test(b.callback_data) ? { ...b, callback_data: `${tag}|${b.callback_data}` } : b));
  return { ...markup, inline_keyboard: markup.inline_keyboard.map(row) };
}

// «v2|c:open:5» → { venue: "v2", data: "c:open:5" }; кнопки без пометки (из сообщений до заведений) — { venue: null }
function untag(data) {
  const m = String(data ?? "").match(TAG_RE);
  return m ? { venue: m[1], data: m[2] } : { venue: null, data: String(data ?? "") };
}

class TaggedApi {
  constructor(base, tag) {
    this.base = base;
    this.tag = tag;
  }

  get me() {
    return this.base.me;
  }

  tagged(params) {
    return params?.reply_markup ? { ...params, reply_markup: tagMarkup(params.reply_markup, this.tag) } : params;
  }

  call(method, params = {}, opts) {
    return this.base.call(method, this.tagged(params), opts);
  }

  upload(method, params, field, buffer, filename) {
    return this.base.upload(method, this.tagged(params), field, buffer, filename);
  }

  // getMe общего бота одинаков для всех заведений: спрашиваем Telegram один раз
  async getMe() {
    return this.base.me || this.base.getMe();
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", { chat_id: chatId, text, ...extra });
  }

  downloadFile(fileId) {
    return this.base.downloadFile(fileId);
  }
}

module.exports = { TelegramApi, TelegramError, Poller, ALLOWED_UPDATES, TaggedApi, untag, tagMarkup };
