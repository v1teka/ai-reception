// Общее для карточек организаций на картах (Яндекс.Карты — yandex.js, 2ГИС — 2gis.js): загрузка страницы,
// HTML → текст, строка о запросе для владельца бота, график по дням и часовой пояс точки.
const { WEEKDAY_ORDER, parseTime, fmtTime, zoneOffset } = require("./time");
const { dayGroups, hoursText } = require("./shop");

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", laquo: "«", raquo: "»", hellip: "…", thinsp: " ", rub: "₽" };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, code) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

// Видимый текст страницы + JSON-LD и meta-описание, без скриптов и стилей.
function htmlToText(html) {
  html = String(html || "");
  const extra = [];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) extra.push("Заголовок: " + decodeEntities(title[1]).trim());
  for (const m of html.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:title|og:description)["'][^>]*>/gi)) {
    const c = m[0].match(/content=["']([^"']*)["']/i);
    if (c) extra.push(decodeEntities(c[1]).trim());
  }
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    extra.push("JSON-LD: " + m[1].trim().slice(0, 5000));
  }
  let body = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, "$&\n")
    .replace(/<[^>]+>/g, " ");
  body = decodeEntities(body);
  // Убираем только подряд идущие повторы: одинаковые цены у разных услуг должны остаться
  const lines = [];
  for (let line of body.split("\n")) {
    line = line.replace(/[ \t ]+/g, " ").trim();
    if (!line || line === lines[lines.length - 1]) continue;
    lines.push(line);
  }
  return [...extra, ...lines].join("\n");
}

async function fetchPage(url, { fetchImpl, timeoutMs, headers }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, redirect: "follow", signal: ctrl.signal });
    const html = await res.text();
    return { status: res.status, url: res.url || url, html };
  } finally {
    clearTimeout(t);
  }
}

// «fetch failed» сам по себе ничего не говорит: настоящая причина (DNS, отказ в соединении,
// сертификат) лежит в e.cause
function fetchError(e) {
  if (e?.name === "AbortError") return "таймаут";
  const cause = e?.cause?.code || e?.cause?.message;
  return cause && cause !== e.message ? `${e.message}: ${cause}` : String(e?.message || e);
}

const shortUrl = (u, max = 200) => (u.length > max ? u.slice(0, max) + "…" : u);

// Одна строка о запросе к картам: для логов и для владельца бота. blocked — что карты показали
// вместо страницы: капча Яндекса, заглушка 2ГИС «браузер устарел»
function describeFetch(p) {
  if (p.error) return `${p.what}: ${p.error}`;
  const parts = [`HTTP ${p.status}`, p.bytes < 1024 ? `${p.bytes} Б` : `${Math.round(p.bytes / 1024)} КБ`];
  if (p.finalUrl && p.finalUrl !== p.url) parts.push(`итоговый адрес ${shortUrl(p.finalUrl)}`);
  if (p.captcha) parts.push("капча");
  if (p.blocked) parts.push(p.blocked);
  return `${p.what}: ${parts.join(", ")}`;
}

// ---------- график по дням ----------

const DAY_MIN = 24 * 60;
const fmtRange = ([a, b]) => `${fmtTime(a)}–${fmtTime(b)}`;

// Одинаковое по дням — одной строкой: «вт–сб 14:00–15:00», дни без значения пропускаем
function byDays(valueOf) {
  return dayGroups(valueOf)
    .filter((g) => g.value)
    .map((g) => `${g.label} ${g.value}`)
    .join(", ");
}

// Часы работы с карточки → график точки. intervals — [{ day: "mon", open: "10:00", close: "22:00" }, …],
// день без интервалов — выходной. Закрытие в 00:00 — полночь, раньше открытия — работа после полуночи: в графике
// день до 24:00, остаток ночи — в notes. Несколько интервалов в день — у бота это один промежуток от первого
// открытия до последнего закрытия, а перерывы между ними — в notes.
// → null, если интервалов нет («не знаем», а не «все дни выходные»); иначе { hours (как shop.hours),
// line — график словами, notes — что не уложилось в расписание бота, для проверки администратором (review.js) }
function weekSchedule(intervals) {
  const spans = {}; // день -> [[открытие, закрытие], …] в минутах
  const overnight = {}; // день -> до скольки работают после полуночи
  for (const it of intervals || []) {
    const open = parseTime(it.open);
    let close = parseTime(it.close);
    if (!WEEKDAY_ORDER.includes(it.day) || open == null || close == null || open >= DAY_MIN) continue;
    if (close === 0) close = DAY_MIN;
    else if (close <= open) {
      overnight[it.day] = Math.max(overnight[it.day] || 0, close);
      close = DAY_MIN;
    }
    (spans[it.day] ||= []).push([open, close]);
  }
  if (!Object.keys(spans).length) return null;

  const hours = {};
  const breaks = {};
  for (const day of WEEKDAY_ORDER) {
    const list = (spans[day] || []).sort((a, b) => a[0] - b[0]);
    if (!list.length) {
      hours[day] = null;
      continue;
    }
    const gaps = [];
    let end = list[0][1];
    for (const [open, close] of list.slice(1)) {
      if (open > end) gaps.push([end, open]);
      end = Math.max(end, close);
    }
    hours[day] = [fmtTime(list[0][0]), fmtTime(end)];
    if (gaps.length) breaks[day] = gaps.map(fmtRange).join(", ");
  }

  const notes = [];
  const pause = byDays((d) => breaks[d] || null);
  const night = byDays((d) => (overnight[d] ? `до ${fmtTime(overnight[d])}` : null));
  if (pause) {
    notes.push({ level: "warn", text: `В карточке перерыв: ${pause}. Перерывов в расписании бота нет, на это время он может записать клиента.` });
  }
  if (night) {
    notes.push({ level: "warn", text: `По карточке после полуночи работают: ${night}. Бот записывает только до 24:00.` });
  }
  const line = [hoursText({ hours }), pause && `перерыв ${pause}`, night && `после полуночи ${night}`].filter(Boolean).join("; ");
  return { hours, line, notes };
}

// ---------- часовой пояс ----------

// Карты дают смещение от UTC (Яндекс — tzOffset в секундах, 2ГИС — timezone_offset в минутах), а боту нужен пояс
// IANA: по нему он считает «сегодня», свободное время и напоминания. Берём пояс страны с тем же смещением сейчас
// (Казахстан — Asia/Almaty, в России — по смещению), иначе любой из списка с тем же смещением, иначе Etc/GMT∓N.
const COUNTRY_ZONES = {
  RU: ["Europe/Moscow", "Europe/Kaliningrad", "Europe/Samara", "Asia/Yekaterinburg", "Asia/Omsk", "Asia/Novosibirsk", "Asia/Irkutsk", "Asia/Yakutsk", "Asia/Vladivostok", "Asia/Magadan", "Asia/Kamchatka"],
  KZ: ["Asia/Almaty"],
  KG: ["Asia/Bishkek"],
  UZ: ["Asia/Tashkent"],
  TJ: ["Asia/Dushanbe"],
  AM: ["Asia/Yerevan"],
  AZ: ["Asia/Baku"],
  GE: ["Asia/Tbilisi"],
  BY: ["Europe/Minsk"],
  AE: ["Asia/Dubai"],
  CY: ["Asia/Nicosia"],
  TR: ["Europe/Istanbul"],
};
const COUNTRY_CODES = {
  россия: "RU",
  казахстан: "KZ",
  кыргызстан: "KG",
  киргизия: "KG",
  узбекистан: "UZ",
  таджикистан: "TJ",
  армения: "AM",
  азербайджан: "AZ",
  грузия: "GE",
  беларусь: "BY",
  белоруссия: "BY",
  оаэ: "AE",
  "объединённые арабские эмираты": "AE",
  "объединенные арабские эмираты": "AE",
  кипр: "CY",
  турция: "TR",
};

// offsetMinutes — смещение от UTC (Алматы — 300); country — код («KZ») или название («Казахстан»).
// → пояс IANA или null, если смещения нет или оно не в целых часах и в списке такого нет
function zoneForOffset(offsetMinutes, country, now = Date.now()) {
  if (typeof offsetMinutes !== "number" || !Number.isFinite(offsetMinutes)) return null;
  const c = String(country || "").trim();
  const code = COUNTRY_ZONES[c.toUpperCase()] ? c.toUpperCase() : COUNTRY_CODES[c.toLowerCase()];
  const candidates = [...(COUNTRY_ZONES[code] || []), ...Object.values(COUNTRY_ZONES).flat()];
  const found = candidates.find((tz) => zoneOffset(tz, now) === offsetMinutes);
  if (found) return found;
  if (offsetMinutes % 60 || Math.abs(offsetMinutes) > 14 * 60) return null;
  // В названиях Etc знак обратный: Etc/GMT-5 — это UTC+5
  return offsetMinutes ? `Etc/GMT${offsetMinutes > 0 ? "-" : "+"}${Math.abs(offsetMinutes) / 60}` : "UTC";
}

module.exports = { decodeEntities, htmlToText, fetchPage, fetchError, shortUrl, describeFetch, weekSchedule, zoneForOffset };
