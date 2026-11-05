// Импорт точки с Яндекс.Карт: скачиваем страницу организации и её прайс,
// превращаем в текст и отдаём ИИ на разбор (см. setup.js).
// Яндекс иногда показывает капчу серверам — тогда мастер присылает скриншоты или текст.

const YANDEX_URL_RE =
  /https?:\/\/(?:www\.)?(?:yandex\.(?:ru|com|by|kz|uz|com\.tr|ua)|ya\.ru)\/(?:maps|profile|web-maps)[^\s<>"']*/i;

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

// → { ok: true, text, url, orgId } | { ok: false, reason }
async function fetchOrgText(url, { fetchImpl = fetch, timeoutMs = 15000, maxChars = 60000 } = {}) {
  let main;
  try {
    main = await fetchPage(url, fetchImpl, timeoutMs);
  } catch (e) {
    return { ok: false, reason: `не удалось открыть страницу (${e.name === "AbortError" ? "таймаут" : e.message})` };
  }
  if (looksLikeCaptcha(main.url, main.html)) return { ok: false, reason: "Яндекс показал капчу вместо страницы" };
  if (main.status >= 400) return { ok: false, reason: `Яндекс ответил ошибкой ${main.status}` };

  const orgId = parseOrgId(main.url) || parseOrgId(url) || parseOrgId(main.html);
  let text = htmlToText(main.html);

  // Прайс обычно на отдельной вкладке /prices/
  const base = (main.url.match(/^(https?:\/\/[^?#]*\/org\/[^?#]*?\d{5,})/) || [])[1];
  if (base) {
    try {
      const prices = await fetchPage(base.replace(/\/$/, "") + "/prices/", fetchImpl, timeoutMs);
      if (prices.status < 400 && !looksLikeCaptcha(prices.url, prices.html)) {
        text += "\n\n=== Вкладка «Цены» ===\n" + htmlToText(prices.html);
      }
    } catch {}
  }
  if (text.replace(/\s/g, "").length < 100) return { ok: false, reason: "на странице почти нет текста" };
  return { ok: true, text: text.slice(0, maxChars), url: main.url, orgId };
}

module.exports = { extractYandexUrl, parseOrgId, htmlToText, fetchOrgText, looksLikeCaptcha };
