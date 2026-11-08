// Даты и время в часовом поясе точки, без внешних библиотек.
// Дата — строка "YYYY-MM-DD", время — минуты от полуночи.

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAY_SHORT = { mon: "пн", tue: "вт", wed: "ср", thu: "чт", fri: "пт", sat: "сб", sun: "вс" };
const WEEKDAY_LONG = {
  mon: "понедельник",
  tue: "вторник",
  wed: "среда",
  thu: "четверг",
  fri: "пятница",
  sat: "суббота",
  sun: "воскресенье",
};
const MONTHS_GEN = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

const pad = (n) => String(n).padStart(2, "0");

// Создавать Intl.DateTimeFormat дорого (~60 мкс), а nowParts вызывается на каждую запись
// при подборе слотов и напоминаниях — держим по одному форматтеру на часовой пояс.
const formatters = new Map();
function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// Текущие дата и время в нужном часовом поясе.
function nowParts(timeZone, now = Date.now()) {
  const parts = {};
  for (const p of formatter(timeZone).formatToParts(new Date(now))) {
    parts[p.type] = p.value;
  }
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { date, minutes, weekday: weekdayOf(date) };
}

function toUtc(date) {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fromUtc(toUtc(s)) === s;
}

function addDays(date, n) {
  return fromUtc(toUtc(date) + n * 86400000);
}

function diffDays(a, b) {
  return Math.round((toUtc(a) - toUtc(b)) / 86400000);
}

// Ключ дня недели: "mon" ... "sun"
function weekdayOf(date) {
  return WEEKDAY_KEYS[new Date(toUtc(date)).getUTCDay()];
}

function parseTime(s) {
  const m = typeof s === "string" && s.trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

function fmtTime(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

// "пт, 6 ноября"
function fmtDate(date) {
  const [, m, d] = date.split("-").map(Number);
  return `${WEEKDAY_SHORT[weekdayOf(date)]}, ${d} ${MONTHS_GEN[m - 1]}`;
}

// "сегодня" / "завтра" / "пт, 6 ноября"
function fmtDateRelative(date, today) {
  const diff = diffDays(date, today);
  if (diff === 0) return `сегодня (${fmtDate(date)})`;
  if (diff === 1) return `завтра (${fmtDate(date)})`;
  return fmtDate(date);
}

function fmtDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} мин`;
  if (!m) return `${h} ч`;
  return `${h} ч ${m} мин`;
}

// Сколько минут осталось до (date, minutes) от текущего момента в часовом поясе точки.
function minutesUntil(date, minutes, timeZone, now = Date.now()) {
  const cur = nowParts(timeZone, now);
  return diffDays(date, cur.date) * 1440 + minutes - cur.minutes;
}

// "5 мин назад", "2 ч назад", "вчера"
function ago(ts, now = Date.now()) {
  const min = Math.max(0, Math.round((now - ts) / 60000));
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return d === 1 ? "вчера" : `${d} дн назад`;
}

module.exports = {
  WEEKDAY_ORDER,
  WEEKDAY_SHORT,
  WEEKDAY_LONG,
  MONTHS_GEN,
  nowParts,
  isDate,
  addDays,
  diffDays,
  weekdayOf,
  parseTime,
  fmtTime,
  fmtDate,
  fmtDateRelative,
  fmtDuration,
  minutesUntil,
  ago,
};
