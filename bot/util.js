const crypto = require("crypto");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ждёт promise, но не дольше ms: потом идём дальше, не дождавшись. Сбой, случившийся раньше срока, не глотает.
function atMost(promise, ms) {
  let timer;
  const timeout = new Promise((r) => (timer = setTimeout(r, ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Экранирование для parse_mode=HTML в Telegram
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Чужой текст одной строкой и без «ёлочек»: внутри кавычек в подсказке для ИИ он не сможет
// закрыть кавычку или начать новую строку и выдать себя за правило точки.
function oneLine(s) {
  return String(s ?? "")
    .replace(/[«»]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function randomCode(bytes = 6) {
  return crypto.randomBytes(bytes).toString("base64url");
}

// Детерминированный псевдослучайный генератор (для демо-занятости)
function seededRandom(seed) {
  let h = crypto.createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    h ^= h << 13;
    h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 4294967296;
  };
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function userName(u) {
  if (!u) return "Клиент";
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || (u.username ? "@" + u.username : "Клиент");
}

module.exports = { sleep, atMost, esc, truncate, oneLine, randomCode, seededRandom, clamp, userName };
