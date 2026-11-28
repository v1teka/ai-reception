// Импорт точки с Яндекс.Карт: скачиваем страницу организации и её прайс,
// превращаем в текст и отдаём ИИ на разбор (см. setup.js).
// Яндекс иногда показывает капчу серверам — тогда мастер присылает скриншоты или текст.
const { WEEKDAY_ORDER } = require("./time");
const { decodeEntities, htmlToText, fetchPage, fetchError, shortUrl, describeFetch, weekSchedule, zoneForOffset } = require("./cards");

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

// ---------- график работы из разметки карточки ----------
// На карточке график свёрнут под кнопкой «График», и в тексте страницы видно только «Открыто до 22:00» —
// состояние на момент загрузки. ИИ по такому тексту графика не восстановит и ставил все дни выходными.
// Полный график Яндекс отдаёт в разметке schema.org — по тегу на каждый рабочий день:
//   <meta itemProp="openingHours" content="Mo 10:00-22:00"/>
// Выходных дней в ней нет; перерыв — через запятую («Tu 11:00-14:00,15:00-19:00»); работа после полуночи —
// закрытием раньше открытия («Mo 12:00-06:00»). Бывает и общий вид schema.org: «Mo-Fr 10:00-19:00», «Sa,Su …»,
// «Mo-Su» без времени — круглосуточно.
const OH_DAY = { mo: "mon", tu: "tue", we: "wed", th: "thu", fr: "fri", sa: "sat", su: "sun" };

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

// → null, если графика в разметке нет; иначе { hours, line, notes } — см. weekSchedule в cards.js
function parseOpeningHours(html) {
  const intervals = [];
  for (const value of openingHoursValues(html)) {
    for (const rule of value.split(";")) {
      const m = rule.trim().match(/^([A-Za-z]{2}(?:\s*[-,]\s*[A-Za-z]{2})*)(?:\s+(.+))?$/);
      const days = m && ohDays(m[1]);
      if (!days) continue;
      for (const t of (m[2] || "00:00-24:00").split(",")) {
        const r = t.trim().match(/^(\d{1,2}[:.]\d{2})\s*[-–—]\s*(\d{1,2}[:.]\d{2})$/);
        if (r) for (const day of days) intervals.push({ day, open: r[1], close: r[2] });
      }
    }
  }
  return weekSchedule(intervals);
}

// Закрытую организацию Яндекс помечает в заголовке карточки: «Больше не работает: Барбер, барбершоп, …»
function orgStatusCheck(html) {
  const title = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title && /^\s*Больше не работает/i.test(decodeEntities(title[1]))) {
    return { level: "error", text: "Яндекс пишет, что организация больше не работает: проверьте, та ли это карточка." };
  }
  return null;
}

// Часовой пояс точки: в данных страницы Яндекс пишет смещение организации от UTC в секундах
// («"tzOffset":18000» — Пермь) и страну в адресе («"compositeAddress":{"country":"Россия",…»)
function pageTimezone(html) {
  const s = String(html || "");
  const offset = s.match(/"tzOffset":(-?\d+)/);
  if (!offset) return null;
  const country = (s.match(/"compositeAddress":\{[^{}]*?"country":"([^"]+)"/) || [])[1];
  return zoneForOffset(Number(offset[1]) / 60, country);
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

// → { ok: true, text, url, orgId, pages, hours, checks, timezone } | { ok: false, reason, pages }
// pages — что Яндекс ответил на каждый запрос (статус, итоговый адрес после редиректов, капча);
// hours — график из разметки карточки (как shop.hours) или null; checks — что показать администратору
// для проверки: перерывы и работа после полуночи из графика, «больше не работает» (см. review.js);
// timezone — часовой пояс точки по карточке или null
async function fetchOrgText(url, { fetchImpl = fetch, timeoutMs = 15000, maxChars = 60000, log } = {}) {
  const pages = [];
  const get = async (what, pageUrl) => {
    const p = { what, url: pageUrl };
    let html = "";
    try {
      const r = await fetchPage(pageUrl, { fetchImpl, timeoutMs, headers: HEADERS });
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
  if (schedule) text = `График работы (из данных карточки): ${schedule.line}\n${text}`;
  const checks = [orgStatusCheck(html), ...(schedule?.notes || [])].filter(Boolean);
  return { ok: true, text: text.slice(0, maxChars), url: main.finalUrl, orgId, pages, hours: schedule?.hours || null, checks, timezone: pageTimezone(html) };
}

module.exports = { extractYandexUrl, parseOrgId, fetchOrgText, looksLikeCaptcha, parseOpeningHours, orgStatusCheck, pageTimezone };
