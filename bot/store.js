// Всё состояние заведения — в одном JSON-файле (для демо этого достаточно).
// Тот же класс хранит и реестр заведений (data/platform.json, см. platform.js) — со своими defaults и normalize.
const fs = require("fs");
const path = require("path");
const { demoShop, normalizeShop } = require("./shop");

function defaultState() {
  return {
    version: 1,
    shop: demoShop(),
    bookings: [],
    conversations: {}, // id -> разговор с клиентом
    admins: {}, // telegram user id -> мастер/владелец
    invites: {}, // код -> приглашение мастера
    ownerClaimCode: null,
    businessConnections: {}, // id -> подключение Telegram Business
    consoleRefs: {}, // "adminId:messageId" -> id разговора (для ответа реплаем)
    offsets: {}, // последний update_id по каждому боту
    seq: { booking: 0, conv: 0 },
  };
}

function normalizeState(state, raw) {
  state.shop = normalizeShop(state.shop);
  state.seq = { booking: 0, conv: 0, ...(raw.seq || {}) };
  return state;
}

class Store {
  constructor(file, { log = console, defaults = defaultState, normalize = normalizeState } = {}) {
    this.file = file;
    this.log = log;
    this.defaults = defaults;
    this.normalize = normalize;
    this.state = defaults();
    this.timer = null;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.state = this.normalize({ ...this.defaults(), ...raw }, raw);
    } catch (e) {
      if (e.code === "ENOENT") return this.state;
      this.log.error("Не удалось прочитать состояние, начинаю с нуля:", this.file, e.message);
      this.state = this.defaults();
      // Первая же запись затёрла бы файл — сначала откладываем копию, чтобы данные можно было вернуть
      const backup = `${this.file}.broken-${Date.now()}`;
      try {
        fs.copyFileSync(this.file, backup);
        this.log.error("Прежний файл сохранён как", backup);
      } catch {}
    }
    return this.state;
  }

  // Отложенная запись, чтобы не писать файл на каждый чих
  save() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 200);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.closed) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    // Без отступов: файл на ~15% меньше и пишется почти вдвое быстрее (читать удобно через jq)
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  // Последняя запись — и больше файл не трогаем (данные удалённого заведения переезжают в архив)
  close() {
    this.flush();
    this.closed = true;
  }
}

module.exports = { Store, defaultState };
