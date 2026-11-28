// Импорт точки с Яндекс.Карт: скачиваем страницу организации и её прайс,
// превращаем в текст и отдаём ИИ на разбор (см. setup.js).
// Яндекс иногда показывает капчу серверам — тогда мастер присылает скриншоты или текст.
const { WEEKDAY_ORDER, parseTime, fmtTime } = require("./time");
const { dayGroups, hoursText } = require("./shop");

// yandex.ru/maps/…, yandex.ru/profile/…, ya.ru/maps/… и старый домен maps.yandex.ru/…
const YANDEX_URL_RE =
  /https?:\/\/(?:(?:www\.)?(?:yandex\.(?:ru|com|by|kz|uz|com\.tr|ua)|ya\.ru)\/(?:maps|profile|web-maps)|maps\.yandex\.(?:ru|com|by|kz|uz|com\.tr|ua)(?![\w.-]))[^\s<>"']*/i;

function extractYandexUrl(text) {
  const m = String(text || "").match(YANDEX_URL_RE);
  return m ? m[0].replace(/[).,!?]+$/, "") : null;
}

function parseOrgId(url) {
  const s = String(url || "");
  const m =
    s.match(/\/org\/(?:[^/?#]+\/)?(\d{5,})/) ||
    s.match(/[?&]oid=(\d{5,})/) ||
    s.match(/\/profile\/(\d{5,})/) ||
    s.match(/ymapsbm1:\/\/org\?oid=(\d{5,})/) ||
    s.match(/ymapsbm1%3A%2F%2Forg%3Foid%3D(\d{5,})/i);
  return m ? m[1] : null;
}

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
    line = line.replace(/[ \t ]+/g, " ").trim();
    if (!line || line === lines[lines.length - 1]) continue;
    lines.push(line);
  }
  return [...extra, ...lines].join("\n");
}

// ---------- график работы из разметки карточки ----------
// На карточке график свёрнут под кнопкой «График», и в тексте страницы видно только «Открыто до 22:00» —
// состояние на момент загрузки. ИИ по такому тексту графика не восстановит и ставил все дни выходными.
// Полный график Яндекс отдаёт в разметке schema.org — по тегу на каждый рабочий день:
//   <meta itemProp="openingHours" content="Mo 10:00-22:00"/>
// Выходных дней в ней нет; перерыв — через запятую («Tu 11:00-14:00,15:00-19:00»); работа после полуночи —
// закрытием раньше открытия («Mo 12:00-06:00»). Бывает и общий вид schema.org: «Mo-Fr 10:00-19:00», «Sa,Su …»,
// «Mo-Su» без времени — круглосуточно.
const OH_DAY = { mo: "mon", tu: "tue", we: "wed", th: "thu", fr: "fri", sa: "sat", su: "sun" };
const DAY_MIN = 24 * 60;

function openingHoursValues(html) {
  const out = [];
  for (const m of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bitemprop\s*=\s*["']?openingHours["'\s/>]/i.test(m[0])) continue;
    const c = m[0].match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (c) out.push(decodeEntities(c[1] ?? c[2]));
  }
  return out;
}

// «Mo-Fr», «Sa,Su», «Fr-Mo» → ["mon", …]; null, если это не дни недели
function ohDays(spec) {
  const days = [];
  for (const part of spec.split(",")) {
    const m = part.trim().toLowerCase().match(/^([a-z]{2})(?:\s*-\s*([a-z]{2}))?$/);
    if (!m || !OH_DAY[m[1]] || (m[2] && !OH_DAY[m[2]])) return null;
    let i = WEEKDAY_ORDER.indexOf(OH_DAY[m[1]]);
    const last = WEEKDAY_ORDER.indexOf(OH_DAY[m[2] || m[1]]);
    for (;;) {
      days.push(WEEKDAY_ORDER[i]);
      if (i === last) break;
      i = (i + 1) % 7;
    }
  }
  return days;
}

const fmtRange = ([a, b]) => `${fmtTime(a)}–${fmtTime(b)}`;

// Одинаковое по дням — одной строкой: «вт–сб 14:00–15:00», дни без значения пропускаем
function byDays(valueOf) {
  return dayGroups(valueOf)
    .filter((g) => g.value)
    .map((g) => `${g.label} ${g.value}`)
    .join(", ");
}

// → null, если графика в разметке нет; иначе { hours (как shop.hours), line — график словами, notes — что
// не уложилось в расписание бота: перерывы (у бота на день один промежуток) и работа после полуночи }
function parseOpeningHours(html) {
  const spans = {}; // день -> [[открытие, закрытие], …] в минутах
  const overnight = {}; // день -> до скольки работают после полуночи
  let found = false;
  for (const value of openingHoursValues(html)) {
    for (const rule of value.split(";")) {
      const m = rule.trim().match(/^([A-Za-z]{2}(?:\s*[-,]\s*[A-Za-z]{2})*)(?:\s+(.+))?$/);
      const days = m && ohDays(m[1]);
      if (!days) continue;
      const ranges = [];
      for (const t of (m[2] || "00:00-24:00").split(",")) {
        const r = t.trim().match(/^(\d{1,2}[:.]\d{2})\s*[-–—]\s*(\d{1,2}[:.]\d{2})$/);
        const open = r && parseTime(r[1]);
        let close = r && parseTime(r[2]);
        if (open == null || close == null || open >= DAY_MIN) continue;
        if (close === 0) close = DAY_MIN;
        else if (close <= open) {
          for (const d of days) overnight[d] = Math.max(overnight[d] || 0, close);
          close = DAY_MIN;
        }
        ranges.push([open, close]);
      }
      if (!ranges.length) continue;
      found = true;
      for (const d of days) (spans[d] ||= []).push(...ranges);
    }
  }
  if (!found) return null;

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

// Закрытую организацию Яндекс помечает в заголовке карточки: «Больше не работает: Барбер, барбершоп, …»
function orgStatusCheck(html) {
  const title = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title && /^\s*Больше не работает/i.test(decodeEntities(title[1]))) {
    return { level: "error", text: "Яндекс пишет, что организация больше не работает: проверьте, та ли это карточка." };
  }
  return null;
}

function looksLikeCaptcha(url, html) {
  return /showcaptcha|captcha/i.test(url || "") || /SmartCaptcha|checkcaptcha|Подтвердите, что запросы отправляли вы/i.test(html || "");
}

const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "accept-language": "ru-RU,ru;q=0.9,en;q=0.5",
  accept: "text/html,application/xhtml+xml",
};

async function fetchPage(url, fetchImpl, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: HEADERS, redirect: "follow", signal: ctrl.signal });
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

// Одна строка о запросе к Яндексу: для логов и для владельца бота
function describeFetch(p) {
  if (p.error) return `${p.what}: ${p.error}`;
  const parts = [`HTTP ${p.status}`, p.bytes < 1024 ? `${p.bytes} Б` : `${Math.round(p.bytes / 1024)} КБ`];
  if (p.finalUrl && p.finalUrl !== p.url) parts.push(`итоговый адрес ${shortUrl(p.finalUrl)}`);
  if (p.captcha) parts.push("капча");
  return `${p.what}: ${parts.join(", ")}`;
}

// → { ok: true, text, url, orgId, pages, hours, checks } | { ok: false, reason, pages }
// pages — что Яндекс ответил на каждый запрос (статус, итоговый адрес после редиректов, капча);
// hours — график из разметки карточки (как shop.hours) или null; checks — что показать администратору
// для проверки: перерывы и работа после полуночи из графика, «больше не работает» (см. review.js)
async function fetchOrgText(url, { fetchImpl = fetch, timeoutMs = 15000, maxChars = 60000, log } = {}) {
  const pages = [];
  const get = async (what, pageUrl) => {
    const p = { what, url: pageUrl };
    let html = "";
    try {
      const r = await fetchPage(pageUrl, fetchImpl, timeoutMs);
      html = r.html;
      Object.assign(p, { status: r.status, finalUrl: r.url, bytes: Buffer.byteLength(html), captcha: looksLikeCaptcha(r.url, html) });
    } catch (e) {
      p.error = fetchError(e);
    }
    pages.push(p);
    const bad = p.error || p.captcha || p.status >= 400;
    log?.[bad ? "warn" : "info"]?.(`Яндекс.Карты: ${shortUrl(pageUrl)} → ${describeFetch(p)}`);
    return { p, html };
  };
  const fail = (reason) => ({ ok: false, reason, pages });

  const { p: main, html } = await get("Карточка", url);
  if (main.error) return fail(`не удалось открыть страницу (${main.error})`);
  if (main.captcha) return fail("Яндекс показал капчу вместо страницы");
  if (main.status >= 400) return fail(`Яндекс ответил ошибкой ${main.status}`);

  const orgId = parseOrgId(main.finalUrl) || parseOrgId(url) || parseOrgId(html);
  let text = htmlToText(html);

  // Прайс обычно на отдельной вкладке /prices/
  const base = (main.finalUrl.match(/^(https?:\/\/[^?#]*\/org\/[^?#]*?\d{5,})/) || [])[1];
  if (base) {
    const { p: prices, html: pricesHtml } = await get("Вкладка «Цены»", base.replace(/\/$/, "") + "/prices/");
    if (!prices.error && prices.status < 400 && !prices.captcha) {
      text += "\n\n=== Вкладка «Цены» ===\n" + htmlToText(pricesHtml);
    }
  }
  if (text.replace(/\s/g, "").length < 100) return fail("на странице почти нет текста");

  // График — первой строкой: её видит ИИ (и не обрежет maxChars), а hours подставит в данные точки setup.js
  const schedule = parseOpeningHours(html);
  log?.info?.(`Яндекс.Карты: график в разметке карточки — ${schedule ? schedule.line : "не найден"}`);
  if (schedule) text = `График работы (из разметки карточки): ${schedule.line}\n${text}`;
  const checks = [orgStatusCheck(html), ...(schedule?.notes || [])].filter(Boolean);
  return { ok: true, text: text.slice(0, maxChars), url: main.finalUrl, orgId, pages, hours: schedule?.hours || null, checks };
}

module.exports = { extractYandexUrl, parseOrgId, htmlToText, fetchOrgText, looksLikeCaptcha, describeFetch, parseOpeningHours, orgStatusCheck };
