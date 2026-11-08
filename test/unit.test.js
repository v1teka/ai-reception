const test = require("node:test");
const assert = require("node:assert/strict");

const { nowParts, addDays, fmtTime, parseTime, minutesUntil } = require("../bot/time");
const { normalizeShop, demoShop, fromLlmShop, toLlmShop } = require("../bot/shop");
const { freeStarts, findFreeSlots, createBooking, cancelBooking, demoBusy } = require("../bot/schedule");
const { typingDuration, splitReply } = require("../bot/typing");
const { extractYandexUrl, parseOrgId, htmlToText, looksLikeCaptcha, fetchOrgText } = require("../bot/yandex");
const { buildMessages } = require("../bot/assistant");
const { Store } = require("../bot/store");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Четверг, 5 ноября 2026, 13:00 по Москве
const NOW = Date.parse("2026-11-05T10:00:00Z");

function shopFixture(extra = {}) {
  return normalizeShop({
    ...demoShop(),
    demo: false,
    demoBusy: false,
    minLeadMinutes: 60,
    hours: { mon: ["10:00", "21:00"], tue: ["10:00", "21:00"], wed: ["10:00", "21:00"], thu: ["10:00", "21:00"], fri: ["10:00", "21:00"], sat: null, sun: null },
    ...extra,
  });
}

const emptyState = () => ({ bookings: [], seq: {} });

test("время в поясе точки", () => {
  const p = nowParts("Europe/Moscow", NOW);
  assert.equal(p.date, "2026-11-05");
  assert.equal(fmtTime(p.minutes), "13:00");
  assert.equal(p.weekday, "thu");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(parseTime("9:30"), 570);
  assert.equal(parseTime("25:00"), null);
  assert.equal(minutesUntil("2026-11-06", 600, "Europe/Moscow", NOW), 21 * 60);
  // Форматтеры кэшируются по поясу — пояса не путаются
  assert.equal(fmtTime(nowParts("Asia/Yekaterinburg", NOW).minutes), "15:00");
  assert.equal(fmtTime(nowParts("Europe/Moscow", NOW).minutes), "13:00");
});

test("битый файл состояния не затирается: копия остаётся рядом", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "barber-store-")), "state.json");
  fs.writeFileSync(file, '{"shop": {"name": "Моя точка",}}'); // лишняя запятая после ручной правки
  const store = new Store(file, { log: { error() {} } });
  store.load();
  assert.equal(store.state.shop.demo, true, "начинаем с демо-данных");
  const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith("state.json.broken-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), backups[0]), "utf8"), '{"shop": {"name": "Моя точка",}}');
  store.flush();
  assert.equal(new Store(file).load().shop.demo, true);
});

test("услуга на 3 слота не наезжает на занятое время", () => {
  const shop = shopFixture();
  const state = emptyState();
  // Занято пт 12:00–13:00
  const r = createBooking(state, shop, { serviceId: "s1", date: "2026-11-06", time: "12:00", staffId: "m1", client: { key: "x" }, now: NOW });
  assert.ok(r.ok);
  const starts = freeStarts(state, shop, { date: "2026-11-06", staffId: "m1", slots: 3, now: NOW }).map(fmtTime);
  assert.ok(starts.includes("10:00"));
  assert.ok(starts.includes("10:30")); // 10:30–12:00 вплотную к записи
  assert.ok(!starts.includes("11:00"));
  assert.ok(!starts.includes("12:30"));
  assert.ok(starts.includes("13:00"));
  assert.equal(starts[starts.length - 1], "19:30"); // 19:30 + 1,5 ч = закрытие
  // У второго мастера в это время свободно
  assert.ok(freeStarts(state, shop, { date: "2026-11-06", staffId: "m2", slots: 3, now: NOW }).map(fmtTime).includes("11:00"));
});

test("сегодня — не раньше чем через minLead, выходной — пусто, дальше горизонта — пусто", () => {
  const shop = shopFixture();
  const today = freeStarts(emptyState(), shop, { date: "2026-11-05", staffId: "m1", slots: 1, now: NOW }).map(fmtTime);
  assert.equal(today[0], "14:00");
  assert.deepEqual(freeStarts(emptyState(), shop, { date: "2026-11-07", staffId: "m1", slots: 1, now: NOW }), []);
  assert.deepEqual(freeStarts(emptyState(), shop, { date: addDays("2026-11-05", 30), staffId: "m1", slots: 1, now: NOW }), []);
});

test("запись на занятое время возвращает ошибку с вариантами", () => {
  const shop = shopFixture({ staff: [{ id: "m1", name: "Артём" }] });
  const state = emptyState();
  assert.ok(createBooking(state, shop, { serviceId: "s2", date: "2026-11-06", time: "15:00", client: { key: "a" }, now: NOW }).ok);
  const r = createBooking(state, shop, { serviceId: "s2", date: "2026-11-06", time: "15:00", client: { key: "b" }, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /недоступно/);
  assert.match(r.error, /Свободно в этот день/);
  // Отменить чужую нельзя, свою — можно
  const id = state.bookings[0].id;
  assert.equal(cancelBooking(state, id, { clientKey: "b" }).ok, false);
  assert.equal(cancelBooking(state, id, { clientKey: "a" }).ok, true);
  assert.ok(createBooking(state, shop, { serviceId: "s2", date: "2026-11-06", time: "15:00", client: { key: "b" }, now: NOW }).ok);
});

test("findFreeSlots: дни, выходные, неизвестная услуга", () => {
  const shop = shopFixture();
  const r = findFreeSlots(emptyState(), shop, { serviceId: "s4", dateFrom: "2026-11-06", days: 2, now: NOW });
  assert.equal(r.service.duration, "1 ч 30 мин");
  assert.equal(r.days.length, 2);
  assert.equal(r.days[1].closed, true); // суббота
  assert.equal(r.days[0].staff.length, 2);
  assert.ok(findFreeSlots(emptyState(), shop, { serviceId: "nope", now: NOW }).error);
});

test("демо-занятость детерминирована и выключается", () => {
  const shop = shopFixture({ demoBusy: true });
  assert.deepEqual(demoBusy(shop, "m1", "2026-11-06"), demoBusy(shop, "m1", "2026-11-06"));
  assert.ok(demoBusy(shop, "m1", "2026-11-06").length > 0);
  assert.deepEqual(demoBusy({ ...shop, demoBusy: false }, "m1", "2026-11-06"), []);
});

test("«печатает»: пропорционально длине, но в пределах", () => {
  const cfg = { baseMs: 400, perCharMs: 12, minMs: 800, maxMs: 4000 };
  assert.equal(typingDuration("Да", cfg), 800);
  assert.equal(typingDuration("x".repeat(100), cfg), 1600);
  assert.equal(typingDuration("x".repeat(200), cfg), 2800);
  assert.equal(typingDuration("x".repeat(1000), cfg), 4000);
  assert.ok(typingDuration("x".repeat(150), cfg) > typingDuration("x".repeat(80), cfg));
  assert.deepEqual(splitReply("Раз\n\nДва\n\nТри\n\nЧетыре"), ["Раз", "Два", "Три\n\nЧетыре"]);
});

test("ссылки Яндекс.Карт и текст страницы", () => {
  assert.equal(
    extractYandexUrl("вот наша точка https://yandex.ru/maps/org/barbershop/1234567890/?ll=37.6,55.7 заходите"),
    "https://yandex.ru/maps/org/barbershop/1234567890/?ll=37.6,55.7"
  );
  assert.equal(extractYandexUrl("https://yandex.ru/maps/-/CDb~aBcD"), "https://yandex.ru/maps/-/CDb~aBcD");
  assert.equal(extractYandexUrl("просто текст"), null);
  assert.equal(parseOrgId("https://yandex.ru/maps/org/barbershop/1234567890/reviews/"), "1234567890");
  assert.equal(parseOrgId("https://yandex.ru/maps/?oid=987654321&ol=biz"), "987654321");
  const text = htmlToText(
    "<html><head><title>Барбершоп</title><script>var x=1</script></head><body><div>Стрижка</div><div>1 500 ₽</div><div>Борода</div><div>1 500 ₽</div><p>Пн&nbsp;–&nbsp;Пт</p></body></html>"
  );
  assert.equal(text.match(/1 500 ₽/g).length, 2); // одинаковые цены не склеиваются
  assert.ok(!text.includes("var x"));
  assert.ok(text.includes("Пн – Пт"));
  assert.ok(looksLikeCaptcha("https://yandex.ru/showcaptcha?retpath=…", ""));

  // Старый домен maps.yandex.ru
  assert.equal(extractYandexUrl("наша точка: https://maps.yandex.ru/org/barbershop/1234567890/."), "https://maps.yandex.ru/org/barbershop/1234567890/");
  assert.equal(extractYandexUrl("https://maps.yandex.ru/-/CDb~aBcD"), "https://maps.yandex.ru/-/CDb~aBcD");
  assert.equal(extractYandexUrl("https://maps.yandex.com.tr/org/x/123456/"), "https://maps.yandex.com.tr/org/x/123456/");
  assert.equal(parseOrgId("https://maps.yandex.ru/org/barbershop/1234567890/"), "1234567890");
  assert.equal(extractYandexUrl("https://maps.yandex.ru.evil.example/org/1/"), null);
  assert.equal(extractYandexUrl("https://yandex.ru/search/?text=барбершоп"), null);
});

function logSpy() {
  const lines = [];
  const add = (level) => (...a) => lines.push(`${level} ${a.join(" ")}`);
  return { lines, info: add("info"), warn: add("warn"), error: add("error") };
}

test("загрузка карточки: в логе и в итоге видны статус, итоговый адрес и капча", async () => {
  const log = logSpy();
  const captcha = await fetchOrgText("https://yandex.ru/maps/org/x/123456789/", {
    log,
    fetchImpl: async () => ({ status: 200, url: "https://yandex.ru/showcaptcha?cc=1&retpath=x", text: async () => "<div>SmartCaptcha</div>" }),
  });
  assert.equal(captcha.ok, false);
  assert.match(captcha.reason, /капчу/);
  assert.equal(captcha.pages.length, 1);
  assert.equal(captcha.pages[0].status, 200);
  assert.equal(captcha.pages[0].finalUrl, "https://yandex.ru/showcaptcha?cc=1&retpath=x");
  assert.equal(captcha.pages[0].captcha, true);
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /^warn .*HTTP 200.*итоговый адрес https:\/\/yandex\.ru\/showcaptcha.*капча/);

  // Сетевая ошибка: настоящая причина из e.cause, а не просто «fetch failed»
  const offline = await fetchOrgText("https://yandex.ru/maps/org/x/123456789/", {
    log,
    fetchImpl: async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND yandex.ru"), { code: "ENOTFOUND" }) });
    },
  });
  assert.equal(offline.reason, "не удалось открыть страницу (fetch failed: ENOTFOUND)");

  // Успех после редиректа: карточка и цены, оба запроса в логе
  log.lines.length = 0;
  const html = `<html><body><h1>Барбершоп</h1><div>${"Стрижка 1 500 ₽. ".repeat(20)}</div></body></html>`;
  const ok = await fetchOrgText("https://yandex.ru/maps/-/abc", {
    log,
    fetchImpl: async (url) => ({ status: 200, url: /prices/.test(url) ? url : "https://yandex.ru/maps/org/barbershop/1234567890/", text: async () => html }),
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.pages.map((p) => p.what), ["Карточка", "Вкладка «Цены»"]);
  assert.equal(ok.pages[1].url, "https://yandex.ru/maps/org/barbershop/1234567890/prices/");
  assert.equal(log.lines.length, 2);
  assert.match(log.lines[0], /^info .*maps\/-\/abc → Карточка: HTTP 200, \d+ (?:Б|КБ), итоговый адрес https:\/\/yandex\.ru\/maps\/org\/barbershop\/1234567890\//);
});

test("точка: слоты из длительности, стабильные id, формат для ИИ туда-обратно", () => {
  const prev = demoShop();
  const llmObj = {
    ...toLlmShop(prev),
    services: [
      { name: "Мужская стрижка", price: "2 000 ₽", duration_minutes: 60, slots: 0, description: "" },
      { name: "Укладка", price: "700 ₽", duration_minutes: 25, slots: 0, description: "" },
    ],
  };
  const shop = fromLlmShop(llmObj, prev);
  assert.equal(shop.demo, false);
  assert.equal(shop.services[0].id, "s1"); // то же имя — тот же id
  assert.equal(shop.services[0].slots, 2);
  assert.equal(shop.services[1].slots, 1);
  assert.notEqual(shop.services[1].id, "s1");
  assert.equal(shop.hours.mon[0], "10:00");
});

test("история для ИИ: роли и склейка", () => {
  const msgs = buildMessages({
    messages: [
      { role: "bot", text: "Здравствуйте!" },
      { role: "client", text: "Привет" },
      { role: "client", text: "Сколько стоит?" },
      { role: "admin", text: "1800" },
    ],
  });
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[0].content, "Привет\nСколько стоит?");
  assert.equal(msgs[1].content, "[ответил мастер] 1800");
});
