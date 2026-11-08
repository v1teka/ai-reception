// YCLIENTS: подключение точки из панели, запись и отмена через API, напоминания.
const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeTelegram, FakeAnthropic, FakeYclients, final, toolUse, tmpFile } = require("./fakes");
const { loadConfig } = require("../bot/config");
const { Store } = require("../bot/store");
const { TelegramApi } = require("../bot/telegram");
const { Llm } = require("../bot/llm");
const { App } = require("../bot/app");
const { normalizeShop } = require("../bot/shop");
const { parseCompanyId, normalizePhone, priceText } = require("../bot/yclients");

const OWNER = 100;
const quiet = { info() {}, warn() {}, error() {} };
let tg, an, yc;
let clock;
let upd = 1;

test.before(async () => {
  tg = await new FakeTelegram().start();
  an = await new FakeAnthropic().start();
});
test.after(() => {
  tg.close();
  an.close();
});
test.beforeEach(async () => {
  yc = await new FakeYclients().start();
});
test.afterEach(() => yc.close());

async function makeApp({ token = "yc-partner" } = {}) {
  tg.reset();
  an.reset();
  clock = Date.parse("2026-11-05T10:00:00Z"); // чт 13:00 МСК
  const cfg = {
    ...loadConfig({ OWNER_IDS: String(OWNER), YCLIENTS_PARTNER_TOKEN: token, YCLIENTS_API_BASE: yc.url }),
    telegramApiBase: tg.url,
    anthropicBaseUrl: an.url,
    anthropicApiKey: "test-key",
    debounceMs: 30,
    llmTimeoutMs: 3000,
    typing: { baseMs: 0, perCharMs: 0, minMs: 1, maxMs: 5, pauseMs: 1 },
    dataFile: tmpFile(),
  };
  const store = new Store(cfg.dataFile, { log: quiet });
  store.load();
  const api = new TelegramApi("main-token", { base: tg.url, log: quiet });
  const llm = new Llm({ apiKey: "test-key", baseURL: an.url, model: cfg.model, fallbacks: true, log: quiet });
  const app = new App({ cfg, store, api, llm, log: quiet, now: () => clock });
  await app.init();
  return app;
}

const user = (id, first_name = "Иван") => ({ id, is_bot: false, first_name, username: "u" + id });
async function clientSays(app, id, text) {
  await app.handleUpdate({ update_id: upd++, message: { message_id: upd, chat: { id, type: "private" }, from: user(id), date: 0, text } });
}
async function adminSays(app, text) {
  await app.handleUpdate({ update_id: upd++, message: { message_id: upd, chat: { id: OWNER, type: "private" }, from: user(OWNER, "Мастер"), date: 0, text } });
}
async function press(app, data) {
  await app.handleUpdate({
    update_id: upd++,
    callback_query: { id: `cq${upd}`, from: user(OWNER, "Мастер"), data, message: { message_id: 1, chat: { id: OWNER, type: "private" } } },
  });
}
const confident = (reply) => final({ reply, confidence: 0.95, handoff: false, handoff_reason: "" });
const toolResult = (body) => JSON.parse(body.messages.at(-1).content[0].content);

async function connect(app) {
  await press(app, "s:yc");
  await press(app, "s:ycon");
  assert.equal(app.state.admins[OWNER].mode, "await_yclients");
  await adminSays(app, "https://n123.yclients.com/company/555/menu");
  await app.idle();
  await press(app, "s:save");
}

// ---------- разбор ввода ----------

test("ID компании, телефон и цена в формате YCLIENTS", () => {
  assert.equal(parseCompanyId("https://n123456.yclients.com/company/987654/personal/menu"), "987654");
  assert.equal(parseCompanyId("https://yclients.com/company/555/"), "555");
  assert.equal(parseCompanyId("ID филиала 4567"), "4567");
  assert.equal(parseCompanyId("company_id=31337"), "31337");
  assert.equal(parseCompanyId("555"), "555");
  assert.equal(parseCompanyId("привет"), null);
  assert.equal(normalizePhone("+7 (900) 123-45-67"), "79001234567");
  assert.equal(normalizePhone("89001234567"), "79001234567");
  assert.equal(normalizePhone("9001234567"), "79001234567");
  assert.equal(normalizePhone("123"), null);
  assert.equal(priceText({ price_min: 1800, price_max: 1800 }), "1 800 ₽");
  assert.equal(priceText({ price_min: 900, price_max: 1200 }), "900–1 200 ₽");
  assert.equal(priceText({ price_min: 0, price_max: 0 }), "");
});

test("правка словами не теряет связь услуг и мастеров с YCLIENTS", () => {
  const prev = normalizeShop({
    name: "Т",
    yclients: { companyId: "555" },
    staff: [{ name: "Артём", ycId: "11" }],
    services: [{ name: "Стрижка", price: "1 800 ₽", slots: 2, durationMin: 60, ycId: "101" }],
  });
  // Так приходит результат правки от ИИ: без ycId, но с теми же названиями
  const next = normalizeShop({ ...prev, staff: ["Артём"], services: [{ name: "Стрижка", price: "2 000 ₽", slots: 2 }] }, prev);
  assert.equal(next.services[0].ycId, "101");
  assert.equal(next.services[0].durationMin, 60);
  assert.equal(next.services[0].price, "2 000 ₽");
  assert.equal(next.staff[0].ycId, "11");
  assert.equal(next.yclients.companyId, "555");
});

// ---------- подключение ----------

test("подключение: ID компании → предпросмотр → сохранить; услуги и мастера из YCLIENTS", async () => {
  const app = await makeApp();
  await press(app, "s:yc");
  assert.match(tg.of("editMessageText").at(-1).params.text, /реальное свободное время/);
  await press(app, "s:ycon");
  await adminSays(app, "n123.yclients.com/company/555");
  await app.idle();
  const preview = tg.sentTo(OWNER).at(-1).params.text;
  assert.match(preview, /Проверьте, что получилось/);
  assert.match(preview, /Барбершоп Борода/);
  assert.match(preview, /Из YCLIENTS: 2 услуг, 2 мастеров/);
  assert.match(preview, /900–1 200 ₽/);
  assert.equal(app.shop.demo, true, "до подтверждения ничего не меняется");
  assert.ok(yc.requests.every((r) => r.headers.authorization === "Bearer yc-partner"));
  assert.ok(yc.requests.every((r) => r.headers.accept === "application/vnd.yclients.v2+json"));

  await press(app, "s:save");
  const shop = app.shop;
  assert.equal(shop.yclients.companyId, "555");
  assert.equal(shop.name, "Барбершоп Борода");
  assert.equal(shop.city, "Казань");
  assert.equal(shop.demoBusy, false);
  assert.deepEqual(shop.services.map((s) => [s.name, s.ycId, s.durationMin]), [["Мужская стрижка", "101", 60], ["Борода", "102", 30]]);
  assert.deepEqual(shop.staff.map((s) => [s.name, s.ycId]), [["Артём", "11"], ["Илья", "12"]]);
  assert.equal(shop.knowledge.length, 0, "демо-знания не переезжают в настоящую точку");

  // В промпте ассистента — правило про YCLIENTS и обязательный телефон
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 701, "Привет");
  await app.idle();
  const sys = an.requests.at(-1).body.system[0].text;
  assert.match(sys, /Запись ведётся в YCLIENTS/);
  assert.match(sys, /Телефон обязателен/);
  assert.doesNotMatch(sys, /слота?\)/);
});

test("подключение: неверный ID и неверный ключ — понятная ошибка, режим ввода остаётся", async () => {
  const app = await makeApp();
  await press(app, "s:ycon");
  await adminSays(app, "777777");
  await app.idle();
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /компания с ID 777777 не найдена/);
  assert.equal(app.state.admins[OWNER].mode, "await_yclients");

  const bad = await makeApp({ token: "wrong" });
  await press(bad, "s:ycon");
  await adminSays(bad, "555");
  await bad.idle();
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /не принял ключ партнёра/);
});

test("без ключа партнёра кнопки подключения нет, есть подсказка", async () => {
  const app = await makeApp({ token: "" });
  assert.equal(app.yclients, null);
  await press(app, "s:yc");
  const msg = tg.of("editMessageText").at(-1).params;
  assert.match(msg.text, /YCLIENTS_PARTNER_TOKEN/);
  assert.ok(!msg.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "s:ycon"));
});

// ---------- запись ----------

test("запись: свободное время из YCLIENTS → запись в журнал → уведомление → отмена удаляет в YCLIENTS", async () => {
  const app = await makeApp();
  await connect(app);
  yc.requests = [];
  yc.taken.add("11|2026-11-06|10:00"); // у Артёма 10:00 уже занято в салоне

  let slots;
  an.respond = (body, n) => {
    if (n === 1) return toolUse("get_free_slots", { service_id: "s1", date_from: "2026-11-06", days: 3, staff_id: null });
    if (n === 2) {
      slots = toolResult(body);
      return toolUse("create_booking", {
        service_id: "s1",
        date: "2026-11-06",
        time: "11:00",
        staff_id: slots.days[0].staff[0].staff_id,
        client_name: "Иван",
        phone: "8 (900) 123-45-67",
        comment: "без машинки",
      });
    }
    const booked = toolResult(body);
    assert.equal(booked.ok, true, JSON.stringify(booked));
    return confident(`Записал на ${booked.booking.when}, мастер ${booked.booking.master}.`);
  };
  await clientSays(app, 702, "Хочу на стрижку завтра в 11");
  await app.idle();

  // Свободное время — из YCLIENTS, с учётом занятого в салоне; воскресенье закрыто
  assert.equal(slots.service.duration, "1 ч");
  const [fri, sat, sun] = slots.days;
  assert.deepEqual(fri.staff.map((s) => [s.name, s.times]), [["Артём", ["11:00", "15:00"]], ["Илья", ["10:00", "11:00", "15:00"]]]);
  assert.equal(sat.staff.length, 2);
  assert.equal(sun.closed, true);
  assert.equal(yc.of(/^book_times\/555\/\d+\/2026-11-08$/).length, 0, "в выходной время не спрашиваем");
  assert.deepEqual(yc.of(/^book_times/)[0].query.getAll("service_ids[]"), ["101"]);

  // Запись ушла в YCLIENTS
  const rec = yc.of(/^book_record\/555$/, "POST")[0].body;
  assert.equal(rec.phone, "79001234567");
  assert.equal(rec.fullname, "Иван");
  assert.equal(rec.comment, "без машинки");
  assert.deepEqual(rec.appointments, [{ id: 1, services: [101], staff_id: 11, datetime: "2026-11-06 11:00:00" }]);

  const b = app.state.bookings[0];
  assert.equal(b.source, "yclients");
  assert.equal(b.staffName, "Артём");
  assert.equal(b.durationMin, 60);
  assert.equal(b.yc.recordId, "9001");
  assert.match(tg.sentTo(702).at(-1).params.text, /Записал на завтра/);
  assert.ok(tg.sentTo(OWNER).some((m) => /Новая запись/.test(m.params.text) && /запись №9001/.test(m.params.text)));

  // Клиент отменяет — запись удаляется и в YCLIENTS
  an.respond = (body, n) => {
    if (body.messages.at(-1).role === "user" && typeof body.messages.at(-1).content === "string") {
      return toolUse("cancel_booking", { booking_id: b.id });
    }
    assert.equal(toolResult(body).ok, true);
    return confident("Отменил.");
  };
  await clientSays(app, 702, "Отмените, пожалуйста");
  await app.idle();
  assert.equal(yc.of(/^user\/records\/9001\/h9001$/, "DELETE").length, 1);
  assert.equal(b.status, "cancelled");
  assert.ok(!yc.taken.has("11|2026-11-06|11:00"));
});

test("запись: время заняли — бот получает ближайшие варианты; без телефона — просит телефон", async () => {
  const app = await makeApp();
  await connect(app);
  const results = [];
  an.respond = (body, n) => {
    if (n > 1) results.push(toolResult(body));
    if (n === 1) {
      yc.taken.add("12|2026-11-06|11:00"); // кто-то занял, пока клиент думал
      return toolUse("create_booking", { service_id: "s2", date: "2026-11-06", time: "11:00", staff_id: "m2", client_name: "Пётр", phone: "+79005554433", comment: null });
    }
    if (n === 2) return toolUse("create_booking", { service_id: "s2", date: "2026-11-06", time: "15:00", staff_id: null, client_name: "Пётр", phone: null, comment: null });
    return confident("Подскажите номер телефона?");
  };
  await clientSays(app, 703, "Бороду завтра в 11 к Илье");
  await app.idle();
  assert.match(results[0].error, /уже занято/);
  assert.match(results[0].error, /10:00 \(Илья\)/);
  assert.match(results[1].error, /нужен номер телефона/);
  assert.equal(app.state.bookings.length, 0);
  assert.equal(app.state.seq.booking, 0, "номер записи не потрачен");
});

test("запись к любому мастеру: YCLIENTS сам выбирает, бот узнаёт имя мастера", async () => {
  const app = await makeApp();
  await connect(app);
  yc.taken.add("11|2026-11-06|10:00");
  an.respond = (body, n) => {
    if (n === 1) return toolUse("create_booking", { service_id: "s1", date: "2026-11-06", time: "10:00", staff_id: null, client_name: "Олег", phone: "+79001112233", comment: null });
    return confident("Готово");
  };
  await clientSays(app, 704, "Завтра в 10 к любому");
  await app.idle();
  assert.equal(yc.of(/^book_record\/555$/, "POST")[0].body.appointments[0].staff_id, 0);
  const b = app.state.bookings[0];
  assert.equal(b.staffName, "Илья");
  assert.equal(b.staffId, "m2");
});

test("YCLIENTS недоступен — бот не выдумывает время и зовёт мастера", async () => {
  const app = await makeApp();
  await connect(app);
  yc.close(); // сервер упал
  an.respond = (body, n) => {
    if (n === 1) return toolUse("get_free_slots", { service_id: "s1", date_from: "2026-11-06", days: 1, staff_id: null });
    const r = toolResult(body);
    assert.match(r.error, /YCLIENTS сейчас не отвечает/);
    return final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "YCLIENTS не отвечает" });
  };
  await clientSays(app, 705, "Есть время завтра?");
  await app.idle();
  assert.equal(tg.sentTo(705).length, 0);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /YCLIENTS не отвечает/);
  yc = await new FakeYclients().start(); // для afterEach
});

// ---------- панель и напоминания ----------

test("панель: свободное время из YCLIENTS, отмена мастером, напоминание пропускается, если запись удалили в салоне", async () => {
  const app = await makeApp();
  await connect(app);

  await press(app, "m:slots");
  const slotsMsg = tg.of("editMessageText").at(-1).params.text;
  assert.match(slotsMsg, /из YCLIENTS/);
  assert.match(slotsMsg, /Борода/);
  assert.match(slotsMsg, /Артём: 10:00, 11:00, 15:00/);

  const book = async (clientId, time) => {
    an.respond = (body, n) =>
      n === 1
        ? toolUse("create_booking", { service_id: "s1", date: "2026-11-06", time, staff_id: "m1", client_name: "К" + clientId, phone: "+7900000000" + (clientId % 10), comment: null })
        : confident("Ок");
    an.reset();
    await clientSays(app, clientId, "Запишите");
    await app.idle();
    return app.state.bookings.at(-1);
  };
  const b1 = await book(706, "10:00");
  const b2 = await book(707, "11:00");
  assert.equal(app.state.bookings.length, 2);

  // Мастер отменяет запись из панели → удаляется в YCLIENTS, клиенту сообщение
  await press(app, `b:cx2:${b1.id}`);
  await app.idle();
  assert.equal(b1.status, "cancelled");
  assert.equal(yc.of(new RegExp(`^user/records/${b1.yc.recordId}/`), "DELETE").length, 1);
  assert.match(tg.sentTo(706).at(-1).params.text, /пришлось отменить/);

  // Вторую запись удалили прямо в YCLIENTS — напоминания не будет
  yc.records[b2.yc.recordId].deleted = true;
  const before = tg.sentTo(707).length;
  clock = Date.parse("2026-11-06T06:30:00Z"); // пт 09:30 МСК, запись в 11:00
  await app.checkReminders();
  await app.idle();
  assert.equal(tg.sentTo(707).length, before);
  assert.equal(b2.status, "cancelled");
  assert.equal(b2.cancelledBy, "yclients");
});

test("отключение YCLIENTS возвращает собственное расписание", async () => {
  const app = await makeApp();
  await connect(app);
  await press(app, "s:ycoff");
  await press(app, "s:ycoff2");
  assert.equal(app.shop.yclients, undefined);
  assert.equal(app.backend().kind, "local");
});
