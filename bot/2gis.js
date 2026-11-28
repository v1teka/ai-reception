// Импорт точки из 2ГИС. Страница организации приходит с сервера уже собранной: всё из карточки лежит в состоянии
// страницы (var initialState = JSON.parse('…')) в формате API 2ГИС — название, адрес, контакты, график по дням,
// смещение часового пояса, особенности. Прайс — на вкладке «Цены» (адрес карточки + /tab/prices), там же: позиции,
// цены и разделы. Из этого собираем текст для ИИ (setup.js), а график и часовой пояс ставим в данные точки сами.
// Если 2ГИС поменяет устройство страницы и состояния в ней не найдётся, ИИ получит видимый текст, как с Яндекса.
const { WEEKDAY_ORDER } = require("./time");
const { htmlToText, fetchPage, fetchError, shortUrl, describeFetch, weekSchedule, zoneForOffset } = require("./cards");
const { truncate } = require("./util");

// 2gis.ru/…, 2gis.kz/…, 2gis.com/… и короткие ссылки из «Поделиться» — go.2gis.com/…
const DGIS_URL_RE = /https?:\/\/(?:(?:www\.|m\.)?2gis\.[a-z]{2,3}(?:\.[a-z]{2})?|go\.2gis\.com)(?![\w.-])\/[^\s<>"']*/i;

function extract2gisUrl(text) {
  const m = String(text || "").match(DGIS_URL_RE);
  return m ? m[0].replace(/[).,!?]+$/, "") : null;
}

// Номер организации: …/firm/70000001043775090, в том числе в ссылке из поиска (…/search/…/firm/…)
function parseFirmId(url) {
  const m = String(url || "").match(/\/firm\/(\d{6,})/);
  return m ? m[1] : null;
}

// Строка JS в кавычках, начиная с позиции кавычки → её значение
function jsString(src, start) {
  const q = src[start];
  if (q !== "'" && q !== '"') throw new Error("здесь нет строки");
  const SIMPLE = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };
  let out = "";
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === q) return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = src[++i];
    if (n === undefined) break;
    if (Object.hasOwn(SIMPLE, n)) out += SIMPLE[n];
    else if (n === "x") {
      out += String.fromCharCode(parseInt(src.substr(i + 1, 2), 16));
      i += 2;
    } else if (n === "u" && src[i + 1] === "{") {
      const end = src.indexOf("}", i);
      out += String.fromCodePoint(parseInt(src.slice(i + 2, end), 16));
      i = end;
    } else if (n === "u") {
      out += String.fromCharCode(parseInt(src.substr(i + 1, 4), 16));
      i += 4;
    } else if (n === "\r" || n === "\n") {
      if (n === "\r" && src[i + 1] === "\n") i++;
    } else out += n;
  }
  throw new Error("строка не закрыта");
}

// Состояние страницы: var initialState = JSON.parse('…') → объект или null
function pageState(html) {
  const s = String(html || "");
  const mark = "var initialState = JSON.parse(";
  const at = s.indexOf(mark);
  if (at < 0) return null;
  try {
    return JSON.parse(jsString(s, at + mark.length));
  } catch {
    return null;
  }
}

// Браузеры, которые 2ГИС считает устаревшими, он отправляет на заглушку /museum («Ваш браузер устарел»). Планка растёт
// с выходом новых Chrome: в ноябре 2026 Chrome 130 уже «устарел», 136 — ещё нет. Поэтому версию в User-Agent считаем
// от даты: Chrome выходит раз в четыре недели, 130-й вышел 15 октября 2024; отстаём на пару версий, чтобы не назваться
// ещё не вышедшим.
function chromeVersion(now = Date.now()) {
  return 130 + Math.max(0, Math.floor((now - Date.UTC(2024, 9, 15)) / (28 * 86400000)) - 2);
}

function headers(now) {
  const v = chromeVersion(now);
  return {
    "user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    "accept-language": "ru-RU,ru;q=0.9,en;q=0.5",
    accept: "text/html,application/xhtml+xml",
  };
}

function looksLikeMuseum(url, html) {
  return /^https?:\/\/[^/?#]+\/museum(?:[/?#]|$)/i.test(url || "") || /Ваш браузер устарел/.test(html || "");
}

// ---------- карточка ----------

const DAY = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };

// schedule из 2ГИС: { Mon: { working_hours: [{ from: "10:00", to: "22:00" }] }, …, is_24x7 } — дня нет, значит выходной,
// перерыв — несколько промежутков, после полуночи — to раньше from («11:00»–«03:00»). → см. weekSchedule
function firmSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") return null;
  const intervals = [];
  for (const [key, day] of Object.entries(DAY)) {
    for (const wh of schedule[key]?.working_hours || []) intervals.push({ day, open: wh?.from, close: wh?.to });
  }
  if (!intervals.length && schedule.is_24x7) for (const day of WEEKDAY_ORDER) intervals.push({ day, open: "00:00", close: "24:00" });
  return weekSchedule(intervals);
}

const CONTACT_LABEL = {
  website: "Сайт",
  email: "Почта",
  vkontakte: "ВКонтакте",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  viber: "Viber",
  instagram: "Instagram",
  youtube: "YouTube",
  odnoklassniki: "Одноклассники",
  facebook: "Facebook",
  twitter: "X (Twitter)",
  pinterest: "Pinterest",
  tiktok: "TikTok",
};

const attrTags = (firm) => (firm.attribute_groups || []).flatMap((g) => (g.attributes || []).map((a) => a.tag || ""));

// Карточка словами — для ИИ: из неё он соберёт название, адрес, телефон, сайт и «знания» (оплата, удобства)
function firmText(firm) {
  const lines = [`Название: ${firm.name_ex?.primary || firm.name || ""}`];
  const kinds = [...new Set([firm.name_ex?.extension, ...(firm.rubrics || []).map((r) => r.name)].filter(Boolean))];
  if (kinds.length) lines.push(`Вид деятельности: ${kinds.join(", ")}`);
  const city = (firm.adm_div || []).find((a) => a.type === "city")?.name;
  if (city) lines.push(`Город: ${city}`);
  const address = [firm.address_name, firm.address_comment && `(${firm.address_comment})`].filter(Boolean).join(" ");
  const building = firm.address?.building_name;
  if (address) lines.push(`Адрес: ${address}${building ? `, ${building}` : ""}`);
  const contacts = (firm.contact_groups || []).flatMap((g) => g.contacts || []);
  const phones = [...new Set(contacts.filter((c) => c.type === "phone").map((c) => c.text || c.value).filter(Boolean))];
  if (phones.length) lines.push(`Телефон: ${phones.join(", ")}`);
  for (const c of contacts) {
    if (c.type === "phone") continue;
    // value у сайта — переадресация через link.2gis.ru, настоящий адрес — в url
    let link = c.url || c.text || c.value;
    if (!link) continue;
    // В ссылку WhatsApp 2ГИС подставляет текст «Пишу из приложения 2ГИС»
    if (c.type === "whatsapp") link = link.replace(/\?.*$/, "");
    lines.push(`${CONTACT_LABEL[c.type] || c.type}: ${link}`);
  }
  if (typeof firm.schedule?.comment === "string" && firm.schedule.comment.trim()) lines.push(`Комментарий к графику: ${firm.schedule.comment.trim()}`);
  // «Актуальность данных не подтверждена» и «Подтверждённый рейтинг» — о самой карточке, клиентам это не нужно
  const groups = (firm.attribute_groups || [])
    .map((g) => ({ name: g.name, items: (g.attributes || []).filter((a) => a.name && !/^(data_currency|rating)_/.test(a.tag || "")).map((a) => a.name) }))
    .filter((g) => g.items.length);
  if (groups.length) lines.push("Особенности:", ...groups.map((g) => `- ${g.name ? `${g.name}: ` : ""}${g.items.join(", ")}`));
  return lines.join("\n");
}

// ---------- прайс ----------

const CURRENCY = { RUB: "₽", KZT: "₸", KGS: "сом", UZS: "сум", BYN: "Br", AMD: "֏", AZN: "₼", GEL: "₾", USD: "$", EUR: "€" };
const cur = (code) => CURRENCY[code] || code || "";
const num = (v) => {
  const [int, frac] = String(v).split(".");
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + (frac ? `,${frac}` : "");
};

// price_value: { fixed: { value, currency } } | { range: { min, max, currency } } | { empty: {} }
function fmtPrice(pv) {
  const join = (amount, currency) => `${amount} ${cur(currency)}`.trim();
  if (pv?.fixed?.value != null) return join(num(pv.fixed.value), pv.fixed.currency);
  const r = pv?.range;
  if (r && r.min != null && r.max != null) return join(r.min === r.max ? num(r.min) : `${num(r.min)}–${num(r.max)}`, r.currency);
  if (r && r.min != null) return join(`от ${num(r.min)}`, r.currency);
  if (r && r.max != null) return join(`до ${num(r.max)}`, r.currency);
  return "цена не указана";
}

// Прайс с вкладки «Цены»: позиции первой страницы по порядку и разделам, и сколько их всего — следующие страницы 2ГИС
// догружает уже в браузере. → { lines, count, total } или null, если прайса в состоянии нет
function priceList(state, firmId) {
  const m = state?.data?.market;
  if (!m?.offers || !m?.products) return null;
  const search = m.offersSearch || {};
  const keys = search.pagination?.[firmId]?.["1"]?.data || Object.keys(m.offers);
  const sections = new Map();
  let count = 0;
  for (const key of keys) {
    const offer = m.offers[key]?.data;
    const product = offer && m.products[offer.productId]?.data?.product;
    const name = String(product?.name || "").trim();
    if (!name) continue;
    const section = product.categories?.[0]?.label || "";
    const about = String(product.description || "").replace(/\s+/g, " ").trim();
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push(`- ${name} — ${fmtPrice(offer.price_value)}${about ? `. ${truncate(about, 300)}` : ""}`);
    count++;
  }
  if (!count) return null;
  const lines = [];
  for (const [section, items] of sections) lines.push(...(section ? [`${section}:`] : []), ...items);
  const total = Number(search.profile?.[firmId]?.data?.total) || 0;
  return { lines, count, total: Math.max(total, count) };
}

// ---------- что проверить ----------

function firmChecks(firm, prices) {
  const checks = [];
  if (firm.type === "branch" && (firm.dates?.deleted_at || firm.is_deleted)) {
    checks.push({ level: "error", text: "2ГИС пишет, что организация больше не работает: проверьте, та ли это карточка." });
  }
  const closed = firm.flags?.temporary_closed;
  if (closed) {
    checks.push({
      level: "warn",
      text: closed === "opening_soon" ? "2ГИС пишет, что организация скоро откроется: проверьте график и дату открытия." : "2ГИС пишет, что организация временно не работает: проверьте карточку и график.",
    });
  }
  if (attrTags(firm).includes("data_currency_data_relevance_data_not_confirmed")) {
    checks.push({ level: "warn", text: "2ГИС пишет: «Актуальность данных не подтверждена» — сверьте адрес, телефон, график и цены." });
  }
  if (prices && prices.total > prices.count) {
    checks.push({ level: "warn", text: `В прайсе 2ГИС позиций: ${prices.total}, загрузились первые ${prices.count}. Проверьте, все ли услуги на месте.` });
  }
  return checks;
}

// ---------- загрузка ----------

// → { ok: true, text, url, orgId, pages, hours, checks, timezone } | { ok: false, reason, pages } — как fetchOrgText
// в yandex.js. url — адрес карточки без поиска и координат, timezone — часовой пояс точки по смещению из карточки.
async function fetch2gisCard(url, { fetchImpl = fetch, timeoutMs = 15000, maxChars = 60000, log, now = Date.now() } = {}) {
  const pages = [];
  const get = async (what, pageUrl) => {
    const p = { what, url: pageUrl };
    let html = "";
    try {
      const r = await fetchPage(pageUrl, { fetchImpl, timeoutMs, headers: headers(now) });
      html = r.html;
      Object.assign(p, { status: r.status, finalUrl: r.url, bytes: Buffer.byteLength(html) });
      if (looksLikeMuseum(r.url, "")) p.blocked = "заглушка «браузер устарел»";
    } catch (e) {
      p.error = fetchError(e);
    }
    pages.push(p);
    const bad = p.error || p.blocked || p.status >= 400;
    log?.[bad ? "warn" : "info"]?.(`2ГИС: ${shortUrl(pageUrl)} → ${describeFetch(p)}`);
    return { p, html };
  };
  const fail = (reason) => ({ ok: false, reason, pages });

  const { p: main, html } = await get("Карточка", url);
  if (main.error) return fail(`не удалось открыть страницу (${main.error})`);
  if (main.blocked) return fail("2ГИС показал заглушку «Ваш браузер устарел» вместо карточки");
  const firmId = parseFirmId(main.finalUrl) || parseFirmId(url);
  const profile = firmId ? pageState(html)?.data?.entity?.profile?.[firmId] : null;
  if (main.status === 404 || profile?.meta?.code === 404) return fail("2ГИС не нашёл такую организацию: проверьте ссылку");
  if (main.status >= 400) return fail(`2ГИС ответил ошибкой ${main.status}`);
  if (!firmId) return fail("в ссылке нет организации: нужна ссылка на её карточку, а не на карту, поиск или здание");

  const firm = profile?.data || null;
  let origin = "";
  try {
    origin = new URL(main.finalUrl).origin;
  } catch {}
  const card = firm?.city_alias && origin ? `${origin}/${firm.city_alias}/firm/${firmId}` : (main.finalUrl.match(/^https?:\/\/[^?#]*?\/firm\/\d+/) || [main.finalUrl])[0];

  let text = firm ? firmText(firm) : htmlToText(html);
  if (!firm) log?.warn?.(`2ГИС: в странице нет данных карточки (initialState) — ИИ получит видимый текст`);

  const { p: tab, html: tabHtml } = await get("Вкладка «Цены»", `${card}/tab/prices`);
  let prices = null;
  if (!tab.error && !tab.blocked && tab.status < 400) {
    prices = priceList(pageState(tabHtml), firmId);
    if (prices) {
      const part = prices.total > prices.count ? ` (первые ${prices.count} из ${prices.total})` : "";
      text += `\n\n=== Вкладка «Цены»${part} ===\n${prices.lines.join("\n")}`;
    } else if (!firm) text += "\n\n=== Вкладка «Цены» ===\n" + htmlToText(tabHtml);
  }
  if (!firm && text.replace(/\s/g, "").length < 100) return fail("на странице почти нет текста");

  // График — первой строкой: её видит ИИ (и не обрежет maxChars), а hours подставит в данные точки setup.js
  const schedule = firm ? firmSchedule(firm.schedule) : null;
  log?.info?.(`2ГИС: график в данных карточки — ${schedule ? schedule.line : "не найден"}`);
  if (schedule) text = `График работы (из данных карточки): ${schedule.line}\n${text}`;
  const country = (firm?.adm_div || []).find((a) => a.type === "country")?.name;
  const timezone = firm ? zoneForOffset(firm.timezone_offset, country, now) : null;
  const checks = [...(firm ? firmChecks(firm, prices) : []), ...(schedule?.notes || [])];
  return { ok: true, text: text.slice(0, maxChars), url: card, orgId: firmId, pages, hours: schedule?.hours || null, checks, timezone };
}

module.exports = { extract2gisUrl, parseFirmId, pageState, firmSchedule, priceList, fetch2gisCard, looksLikeMuseum, chromeVersion };
