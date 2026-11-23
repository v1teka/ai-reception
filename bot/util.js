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

// HTML для Telegram → простой текст (для консоли сервера и когда Telegram не разобрал разметку)
function plain(html) {
  return String(html ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g", ў: "u",
};
// Слова, которые есть в названии почти каждой точки: в ссылке они ничего не различают
const GENERIC_WORDS = new Set(["barbershop", "barber", "shop", "salon", "studiya", "studio", "parikmakherskaya", "krasoty", "demo", "the", "i", "na", "v"]);

// Название → короткая латиница для ссылки на заведение: «Барбершоп «Бородач»» → borodach.
// Только a-z, 0-9 и дефис: такое Telegram принимает в ?start=, и с приглашениями (adm_…) не путается.
function slugify(name, { max = 24, keepGeneric = false } = {}) {
  const words = [...String(name || "").toLowerCase()]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join("")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const meaningful = keepGeneric ? words : words.filter((w) => !GENERIC_WORDS.has(w));
  let out = "";
  for (const w of meaningful.length ? meaningful : words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  return out || (words[0] || "").slice(0, max);
}

module.exports = { sleep, atMost, esc, plain, truncate, oneLine, randomCode, seededRandom, clamp, userName, slugify };
