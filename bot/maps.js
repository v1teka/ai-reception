// Карточка организации на картах. Мастер просто присылает ссылку — Яндекс.Карты это или 2ГИС, бот понимает сам.
// Загрузка и разбор у каждых карт свои (yandex.js, 2gis.js), а результат один и тот же: текст для ИИ, график,
// часовой пояс и что проверить (см. fetchOrgText в yandex.js).
const yandex = require("./yandex");
const dgis = require("./2gis");

const MAPS = [
  {
    id: "yandex",
    name: "Яндекс.Карты",
    from: "с Яндекс.Карт",
    find: yandex.extractYandexUrl,
    orgId: yandex.parseOrgId,
    fetch: yandex.fetchOrgText,
    blocked: (url, html) => (yandex.looksLikeCaptcha(url, html) ? "капча" : null),
    // Для ИИ: что за текст ниже и как самому открыть карточку, если бот её не загрузил
    page: "текст страницы организации с Яндекс.Карт (и вкладки «Цены», если она есть)",
    open: 'Открой карточку организации на Яндекс.Картах и её вкладку с ценами (обычно адрес карточки + "prices/")',
  },
  {
    id: "2gis",
    name: "2ГИС",
    from: "из 2ГИС",
    find: dgis.extract2gisUrl,
    orgId: dgis.parseFirmId,
    fetch: dgis.fetch2gisCard,
    blocked: (url, html) => (dgis.looksLikeMuseum(url, html) ? "заглушка «браузер устарел»" : null),
    page: "данные карточки организации из 2ГИС (и вкладки «Цены», если она есть)",
    open: 'Открой карточку организации в 2ГИС и её вкладку «Цены» (адрес карточки + "/tab/prices")',
  },
];

// Первая ссылка на карты в тексте → { url, map } | null
function findMapLink(text) {
  const s = String(text || "");
  let best = null;
  for (const map of MAPS) {
    const url = map.find(s);
    if (!url) continue;
    const at = s.indexOf(url);
    if (!best || at < best.at) best = { url, map, at };
  }
  return best && { url: best.url, map: best.map };
}

const extractMapUrl = (text) => findMapLink(text)?.url || null;
const mapOf = (url) => findMapLink(url)?.map || null;

// Что карты показали вместо страницы: капча, заглушка; null — страница открылась
function blockedPage(url, html) {
  for (const map of MAPS) {
    const b = map.blocked(url, html);
    if (b) return b;
  }
  return null;
}

module.exports = { MAPS, findMapLink, extractMapUrl, mapOf, blockedPage };
