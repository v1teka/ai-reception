// Всё состояние бота — в одном JSON-файле (для демо этого достаточно).
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

class Store {
  constructor(file, { log = console } = {}) {
    this.file = file;
    this.log = log;
    this.state = defaultState();
    this.timer = null;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.state = { ...defaultState(), ...raw };
      this.state.shop = normalizeShop(this.state.shop);
      this.state.seq = { booking: 0, conv: 0, ...(raw.seq || {}) };
    } catch (e) {
      if (e.code !== "ENOENT") this.log.error("Не удалось прочитать состояние, начинаю с нуля:", e.message);
    }
    return this.state;
  }

  // Отложенная запись, чтобы не писать файл на каждый чих
  save() {
    if (this.timer) return;
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
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, defaultState };
