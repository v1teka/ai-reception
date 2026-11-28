// Страницы 2ГИС для тестов — так, как их отдаёт сервер: данные карточки и прайса лежат в состоянии страницы
// (var initialState = JSON.parse('…')), а не в видимом тексте. Устройство — как у настоящих карточек
// (ноябрь 2026), данные выдуманы.
const FIRM_ID = "70000001000000001";
const FIRM_URL = `https://2gis.kz/almaty/firm/${FIRM_ID}`;

// JSON внутри строки JS в одинарных кавычках, как на странице 2ГИС
const jsLiteral = (s) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const page = (title, state, body = "") =>
  `<!DOCTYPE html><html><head><title>${title}</title></head><body><div id="root">${body}</div>` +
  `<script>var initialState = JSON.parse(${jsLiteral(JSON.stringify(state))});</script></body></html>`;

const weekday = { working_hours: [{ from: "10:00", to: "14:00" }, { from: "15:00", to: "21:00" }] };

// Барбершоп в Алматы: пн–пт 10–21 с перерывом 14–15, сб 11–02 (после полуночи), вс — выходной
function firm(over = {}) {
  return {
    id: FIRM_ID,
    type: "branch",
    name: "Барбершоп Тест, барбершоп",
    name_ex: { primary: "Барбершоп Тест", extension: "барбершоп" },
    city_alias: "almaty",
    address_name: "проспект Абая, 1",
    address_comment: "1 этаж",
    address: { building_name: "" },
    adm_div: [
      { id: "1", type: "country", name: "Казахстан" },
      { id: "2", type: "city", name: "Алматы", city_alias: "almaty" },
    ],
    timezone_offset: 300,
    rubrics: [{ id: "110998", kind: "primary", name: "Барбершопы" }],
    schedule: { Mon: weekday, Tue: weekday, Wed: weekday, Thu: weekday, Fri: weekday, Sat: { working_hours: [{ from: "11:00", to: "02:00" }] } },
    contact_groups: [
      {
        contacts: [
          { type: "phone", text: "+7‒700‒000‒11‒22", print_text: "+7‒700‒000‒11‒22", value: "+77000001122" },
          { type: "website", text: "barbershop-test.kz", url: "http://barbershop-test.kz", value: "http://link.2gis.ru/1.2/AAAA/online/x?http://barbershop-test.kz" },
          { type: "whatsapp", text: "https://wa.me/77000001122?text=%D0%9F%D0%B8%D1%88%D1%83", url: "https://wa.me/77000001122?text=%D0%9F%D0%B8%D1%88%D1%83" },
        ],
      },
    ],
    attribute_groups: [
      {
        name: "Способы оплаты",
        attributes: [
          { tag: "general_payment_type_card", name: "Оплата картой" },
          { tag: "general_payment_type_qrcode", name: "Оплата по QR-коду" },
        ],
      },
      { name: "Рейтинг", attributes: [{ tag: "rating_confirmed_rating", name: "Подтверждённый рейтинг" }] },
    ],
    flags: { photos: true },
    dates: { created_at: "2024-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" },
    ...over,
  };
}

const NOT_CONFIRMED = { name: "Актуальность данных", attributes: [{ tag: "data_currency_data_relevance_data_not_confirmed", name: "Актуальность данных не подтверждена" }] };

// В видимом тексте карточки, как и у Яндекса, — только состояние на момент загрузки
const cardHtml = (f = firm()) =>
  page(`${f.name} — 2ГИС`, { data: { entity: { profile: { [f.id]: { data: f, meta: { status: "success", code: 200 } } } } } }, `<h1>${f.name_ex.primary}</h1><div>Откроется в 10:00</div>`);

const PRICES = [
  { section: "Стрижки", name: "Мужская стрижка", price: { fixed: { value: 5000, currency: "KZT" } }, about: "Мытьё головы и укладка" },
  { section: "Стрижки", name: "Детская стрижка", price: { range: { min: 3500, max: 5000, currency: "KZT" } } },
  { section: "Борода", name: "Моделирование бороды", price: { fixed: { value: 3000, currency: "KZT" } } },
  { section: "Борода", name: "Консультация", price: { empty: {} } },
];

// Вкладка «Цены»: позиции — в market.products, цены — в market.offers, порядок первой страницы и сколько всего —
// в market.offersSearch (остальные страницы 2ГИС догружает в браузере)
function pricesHtml(items = PRICES, { firmId = FIRM_ID, total = items.length } = {}) {
  const products = {};
  const offers = {};
  const keys = [];
  items.forEach((it, i) => {
    const pid = `702662000000${String(i).padStart(5, "0")}`;
    products[pid] = { data: { product: { id: pid, name: it.name, description: it.about || "", categories: it.section ? [{ id: `c${it.section}`, label: it.section }] : [] } }, meta: { code: 200 } };
    offers[`${pid}:${firmId}`] = { data: { productId: pid, branchId: firmId, price_value: it.price }, meta: { code: 200 } };
    keys.push(`${pid}:${firmId}`);
  });
  const offersSearch = { profile: { [firmId]: { data: { total, pages: Math.ceil(total / 50) } } }, pagination: { [firmId]: { 1: { data: keys } } } };
  return page("Цены — 2ГИС", { data: { market: { products, offers, offersSearch } } });
}

// fetchImpl: короткая ссылка go.2gis.com/… ведёт на карточку, …/tab/prices — прайс
function fake2gisFetch({ card = cardHtml(), prices = pricesHtml(), firmUrl = FIRM_URL } = {}) {
  return async (url) => {
    const final = /go\.2gis\.com/.test(url) ? firmUrl : url;
    return { status: 200, url: final, text: async () => (/\/tab\/prices/.test(final) ? prices : card) };
  };
}

module.exports = { FIRM_ID, FIRM_URL, firm, NOT_CONFIRMED, cardHtml, PRICES, pricesHtml, fake2gisFetch };
