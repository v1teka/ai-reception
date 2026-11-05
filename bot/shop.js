// Точка (барбершоп) — это данные, а не код. Их меняет мастер прямо в Telegram:
// импорт с Яндекс.Карт, правки словами, заметки-«знания».
const { WEEKDAY_ORDER, WEEKDAY_SHORT, parseTime, fmtTime, fmtDuration } = require("./time");
const { esc, clamp, truncate } = require("./util");

const DAY_LABEL = WEEKDAY_SHORT;

// Тестовая точка: работает сразу после запуска, пока мастер не загрузил свою.
function demoShop() {
  return normalizeShop({
    demo: true,
    demoBusy: true,
    name: "Демо-барбершоп «Бритва»",
    city: "Москва",
    address: "ул. Примерная, 1 (демо-адрес)",
    phone: "+7 (900) 000-00-00",
    site: "",
    yandexUrl: "",
    description: "Мужские стрижки, оформление бороды, королевское бритьё. Уютно, кофе за счёт заведения.",
    timezone: "Europe/Moscow",
    slotMinutes: 30,
    minLeadMinutes: 60,
    bookingDays: 14,
    hours: {
      mon: ["10:00", "21:00"],
      tue: ["10:00", "21:00"],
      wed: ["10:00", "21:00"],
      thu: ["10:00", "21:00"],
      fri: ["10:00", "21:00"],
      sat: ["11:00", "20:00"],
      sun: ["11:00", "20:00"],
    },
    staff: [
      { id: "m1", name: "Артём" },
      { id: "m2", name: "Илья" },
    ],
    services: [
      { id: "s1", name: "Мужская стрижка", price: "1 800 ₽", slots: 2, description: "Консультация, мытьё головы, стрижка, укладка" },
      { id: "s2", name: "Стрижка машинкой", price: "1 000 ₽", slots: 1, description: "Одна-две насадки" },
      { id: "s3", name: "Моделирование бороды", price: "1 200 ₽", slots: 1, description: "Форма, контуры, горячее полотенце" },
      { id: "s4", name: "Стрижка + борода", price: "2 700 ₽", slots: 3, description: "" },
      { id: "s5", name: "Королевское бритьё", price: "1 500 ₽", slots: 2, description: "Опасной бритвой, распаривание, уход" },
      { id: "s6", name: "Детская стрижка (до 12 лет)", price: "1 300 ₽", slots: 2, description: "" },
      { id: "s7", name: "Отец + сын", price: "2 900 ₽", slots: 3, description: "Две стрижки подряд" },
      { id: "s8", name: "Камуфляж седины", price: "1 300 ₽", slots: 1, description: "Тонирование седины на голове или бороде" },
      { id: "s9", name: "Комплекс: стрижка + борода + камуфляж", price: "4 000 ₽", slots: 4, description: "" },
    ],
    knowledge: [
      "Оплата: наличные, карта, СБП.",
      "Бесплатный кофе, чай и вода для гостей.",
      "Отмена или перенос — не позднее чем за 2 часа до визита.",
      "Опоздание больше 15 минут — запись может сдвинуться или понадобится перенос.",
      "Детей стрижём с 4 лет.",
      "Есть подарочные сертификаты от 1 500 ₽.",
    ],
  });
}

// Пустая точка — основа, когда мастер описывает свою точку с нуля.
function emptyShop(prev) {
  return normalizeShop({
    demo: false,
    demoBusy: prev ? prev.demoBusy : true,
    name: "",
    timezone: prev?.timezone || "Europe/Moscow",
    slotMinutes: prev?.slotMinutes || 30,
    minLeadMinutes: prev?.minLeadMinutes ?? 60,
    bookingDays: prev?.bookingDays || 14,
    hours: {},
    staff: [],
    services: [],
    knowledge: [],
  });
}

const str = (v, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v, def) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : def);

function normHours(raw) {
  const out = {};
  for (const day of WEEKDAY_ORDER) {
    let v = raw ? raw[day] : null;
    if (Array.isArray(raw)) {
      const item = raw.find((x) => x && x.day === day);
      v = item && !item.closed ? [item.open, item.close] : null;
    }
    if (Array.isArray(v) && v.length === 2) {
      const open = parseTime(v[0]);
      const close = parseTime(v[1]);
      out[day] = open != null && close != null && close > open ? [fmtTime(open), fmtTime(close)] : null;
    } else {
      out[day] = null;
    }
  }
  return out;
}

// Сопоставляем новые элементы со старыми по имени, чтобы id не «прыгали».
function assignIds(items, prevItems, prefix) {
  const used = new Set();
  const byName = new Map((prevItems || []).map((x) => [x.name?.toLowerCase(), x.id]));
  for (const it of items) {
    const prevId = it.id && !used.has(it.id) ? it.id : byName.get(it.name?.toLowerCase());
    if (prevId && !used.has(prevId)) {
      it.id = prevId;
      used.add(prevId);
    } else {
      it.id = null;
    }
  }
  let n = 1;
  for (const it of items) {
    if (it.id) continue;
    while (used.has(prefix + n)) n++;
    it.id = prefix + n;
    used.add(it.id);
  }
  return items;
}

function normalizeShop(raw, prev) {
  raw = raw || {};
  const slotMinutes = clamp(int(raw.slotMinutes, prev?.slotMinutes || 30), 5, 240);
  const staff = assignIds(
    (Array.isArray(raw.staff) ? raw.staff : [])
      .map((s) => (typeof s === "string" ? { name: s } : s))
      .filter((s) => s && str(s.name))
      .slice(0, 20)
      .map((s) => ({ id: s.id || null, name: str(s.name, 60) })),
    prev?.staff,
    "m"
  );
  if (!staff.length) staff.push({ id: "m1", name: "Мастер" });

  const services = assignIds(
    (Array.isArray(raw.services) ? raw.services : [])
      .filter((s) => s && str(s.name))
      .slice(0, 60)
      .map((s) => {
        let slots = int(s.slots, 0);
        const dur = int(s.duration_minutes ?? s.durationMinutes, 0);
        if (slots < 1 && dur > 0) slots = Math.ceil(dur / slotMinutes);
        return {
          id: s.id || null,
          name: str(s.name, 100),
          price: str(String(s.price ?? ""), 40),
          slots: clamp(slots || 1, 1, 12),
          description: str(s.description, 300),
        };
      }),
    prev?.services,
    "s"
  );

  const knowledge = (Array.isArray(raw.knowledge) ? raw.knowledge : [])
    .map((k) => (typeof k === "string" ? { text: k } : k))
    .filter((k) => k && str(k.text, 2000))
    .slice(0, 100)
    .map((k) => ({ id: k.id || null, text: str(k.text, 2000) }));
  // id заметок — по порядку, если не было
  const usedK = new Set();
  for (const k of knowledge) {
    if (k.id && !usedK.has(k.id)) usedK.add(k.id);
    else k.id = null;
  }
  let kn = 1;
  for (const k of knowledge) {
    if (k.id) continue;
    while (usedK.has("k" + kn)) kn++;
    k.id = "k" + kn;
    usedK.add(k.id);
  }

  return {
    demo: Boolean(raw.demo),
    demoBusy: raw.demoBusy !== undefined ? Boolean(raw.demoBusy) : true,
    name: str(raw.name, 120),
    city: str(raw.city, 80),
    address: str(raw.address, 300),
    phone: str(raw.phone, 80),
    site: str(raw.site, 200),
    yandexUrl: str(raw.yandexUrl, 500),
    description: str(raw.description, 1000),
    greeting: str(raw.greeting, 500),
    timezone: str(raw.timezone, 60) || "Europe/Moscow",
    slotMinutes,
    minLeadMinutes: clamp(int(raw.minLeadMinutes, 60), 0, 24 * 60),
    bookingDays: clamp(int(raw.bookingDays, 14), 1, 60),
    hours: normHours(raw.hours),
    staff,
    services,
    knowledge,
    updatedAt: raw.updatedAt || Date.now(),
  };
}

// ---------- Формат для LLM (импорт и правки словами) ----------

const LLM_SHOP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "city",
    "address",
    "phone",
    "site",
    "description",
    "slot_minutes",
    "hours",
    "staff",
    "services",
    "knowledge",
    "changes",
  ],
  properties: {
    name: { type: "string", description: "Название точки" },
    city: { type: "string" },
    address: { type: "string" },
    phone: { type: "string" },
    site: { type: "string" },
    description: { type: "string", description: "1–2 предложения о точке" },
    slot_minutes: { type: "integer", description: "Длина одного слота записи в минутах" },
    hours: {
      type: "array",
      description: "График на все 7 дней недели",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["day", "closed", "open", "close"],
        properties: {
          day: { type: "string", enum: WEEKDAY_ORDER },
          closed: { type: "boolean" },
          open: { type: "string", description: "HH:MM" },
          close: { type: "string", description: "HH:MM" },
        },
      },
    },
    staff: { type: "array", items: { type: "string" }, description: "Имена мастеров" },
    services: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "price", "duration_minutes", "slots", "description"],
        properties: {
          name: { type: "string" },
          price: { type: "string", description: "Как в прайсе, например «1 800 ₽» или «от 2 000 ₽»" },
          duration_minutes: { type: "integer" },
          slots: { type: "integer", description: "Сколько слотов занимает услуга" },
          description: { type: "string" },
        },
      },
    },
    knowledge: {
      type: "array",
      items: { type: "string" },
      description: "Прочие факты для ответов клиентам: оплата, парковка, правила, акции и т.п. Одна заметка — один факт или тема.",
    },
    changes: {
      type: "array",
      items: { type: "string" },
      description: "Что изменилось или что стоит проверить мастеру — коротко, по-русски",
    },
  },
};

function toLlmShop(shop) {
  return {
    name: shop.name,
    city: shop.city,
    address: shop.address,
    phone: shop.phone,
    site: shop.site,
    description: shop.description,
    slot_minutes: shop.slotMinutes,
    hours: WEEKDAY_ORDER.map((day) => {
      const h = shop.hours[day];
      return { day, closed: !h, open: h ? h[0] : "", close: h ? h[1] : "" };
    }),
    staff: shop.staff.map((s) => s.name),
    services: shop.services.map((s) => ({
      name: s.name,
      price: s.price,
      duration_minutes: s.slots * shop.slotMinutes,
      slots: s.slots,
      description: s.description,
    })),
    knowledge: shop.knowledge.map((k) => k.text),
  };
}

function fromLlmShop(obj, base) {
  return normalizeShop(
    {
      ...base,
      demo: false,
      name: obj.name,
      city: obj.city,
      address: obj.address,
      phone: obj.phone,
      site: obj.site,
      description: obj.description,
      slotMinutes: obj.slot_minutes || base.slotMinutes,
      hours: obj.hours,
      staff: obj.staff,
      services: obj.services,
      knowledge: obj.knowledge,
      updatedAt: Date.now(),
    },
    base
  );
}

// ---------- Текстовые представления ----------

function hoursLines(shop) {
  // Склеиваем одинаковые дни подряд: «пн–пт 10:00–21:00»
  const out = [];
  let i = 0;
  while (i < WEEKDAY_ORDER.length) {
    const day = WEEKDAY_ORDER[i];
    const h = shop.hours[day];
    let j = i;
    while (
      j + 1 < WEEKDAY_ORDER.length &&
      JSON.stringify(shop.hours[WEEKDAY_ORDER[j + 1]]) === JSON.stringify(h)
    )
      j++;
    const label = i === j ? DAY_LABEL[day] : `${DAY_LABEL[day]}–${DAY_LABEL[WEEKDAY_ORDER[j]]}`;
    out.push(`${label}: ${h ? `${h[0]}–${h[1]}` : "выходной"}`);
    i = j + 1;
  }
  return out;
}

function serviceLine(shop, s, withId) {
  const dur = fmtDuration(s.slots * shop.slotMinutes);
  const slots = `${s.slots} ${s.slots === 1 ? "слот" : s.slots < 5 ? "слота" : "слотов"}`;
  return `${withId ? `[${s.id}] ` : ""}${s.name} — ${s.price || "цена не указана"} — ${dur} (${slots})${
    s.description ? `. ${s.description}` : ""
  }`;
}

// Блок для системного промпта ассистента
function renderForPrompt(shop) {
  const lines = [];
  lines.push(`Название: ${shop.name || "(не указано)"}`);
  if (shop.description) lines.push(`О точке: ${shop.description}`);
  if (shop.city || shop.address) lines.push(`Адрес: ${[shop.city, shop.address].filter(Boolean).join(", ")}`);
  if (shop.phone) lines.push(`Телефон: ${shop.phone}`);
  if (shop.site) lines.push(`Сайт: ${shop.site}`);
  if (shop.yandexUrl) lines.push(`Яндекс.Карты: ${shop.yandexUrl}`);
  lines.push(`График работы: ${hoursLines(shop).join("; ")}`);
  lines.push(
    `Запись: слот ${shop.slotMinutes} мин; записываем минимум за ${fmtDuration(shop.minLeadMinutes || 0)} и не дальше чем на ${shop.bookingDays} дн вперёд.`
  );
  lines.push(`Мастера: ${shop.staff.map((s) => `${s.name} [${s.id}]`).join(", ")}`);
  lines.push("");
  lines.push("Услуги (id — название — цена — длительность):");
  for (const s of shop.services) lines.push(`- ${serviceLine(shop, s, true)}`);
  if (!shop.services.length) lines.push("- (список услуг пока пуст — записывать не на что, зови мастера)");
  if (shop.knowledge.length) {
    lines.push("");
    lines.push("Прочие знания от мастера:");
    for (const k of shop.knowledge) lines.push(`- ${k.text}`);
  }
  return lines.join("\n");
}

// Короткая сводка для мастера (HTML)
function renderSummary(shop) {
  const lines = [];
  lines.push(`<b>${esc(shop.name || "Точка без названия")}</b>${shop.demo ? " <i>(демо-данные)</i>" : ""}`);
  if (shop.city || shop.address) lines.push(`📍 ${esc([shop.city, shop.address].filter(Boolean).join(", "))}`);
  if (shop.phone) lines.push(`📞 ${esc(shop.phone)}`);
  lines.push(`🕐 ${esc(hoursLines(shop).join("; "))}`);
  lines.push(`✂️ Услуг: ${shop.services.length} · слот ${shop.slotMinutes} мин`);
  lines.push(`👤 Мастера: ${esc(shop.staff.map((s) => s.name).join(", "))}`);
  lines.push(`📚 Заметок-знаний: ${shop.knowledge.length}`);
  lines.push(`🎲 Демо-занятость в расписании: ${shop.demoBusy ? "вкл" : "выкл"}`);
  return lines.join("\n");
}

// Полная карточка (HTML), режется на части при отправке
function renderFull(shop) {
  const lines = [renderSummary(shop), ""];
  if (shop.description) lines.push(esc(shop.description), "");
  if (shop.site) lines.push(`🌐 ${esc(shop.site)}`);
  if (shop.yandexUrl) lines.push(`🗺 ${esc(shop.yandexUrl)}`);
  lines.push("<b>Услуги</b>");
  for (const s of shop.services) lines.push(`• ${esc(serviceLine(shop, s, false))}`);
  if (!shop.services.length) lines.push("— пока нет");
  lines.push("", "<b>Знания</b>");
  for (const k of shop.knowledge) lines.push(`• ${esc(truncate(k.text, 300))}`);
  if (!shop.knowledge.length) lines.push("— пока нет");
  return lines.join("\n");
}

function findService(shop, id) {
  if (!id) return null;
  const s = String(id).trim().toLowerCase();
  return shop.services.find((x) => x.id === s) || shop.services.find((x) => x.name.toLowerCase() === s) || null;
}

function findStaff(shop, id) {
  if (!id) return null;
  const s = String(id).trim().toLowerCase();
  return shop.staff.find((x) => x.id === s) || shop.staff.find((x) => x.name.toLowerCase() === s) || null;
}

module.exports = {
  demoShop,
  emptyShop,
  normalizeShop,
  LLM_SHOP_SCHEMA,
  toLlmShop,
  fromLlmShop,
  renderForPrompt,
  renderSummary,
  renderFull,
  hoursLines,
  serviceLine,
  findService,
  findStaff,
};
