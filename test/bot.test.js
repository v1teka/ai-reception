// Сквозные сценарии: настоящий App + TelegramApi + Anthropic SDK против фейковых серверов.
const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeTelegram, FakeAnthropic, final, toolUse, tmpFile } = require("./fakes");
const { loadConfig } = require("../bot/config");
const { Store } = require("../bot/store");
const { TelegramApi, Poller } = require("../bot/telegram");
const { Llm } = require("../bot/llm");
const { App } = require("../bot/app");
const { typingDuration } = require("../bot/typing");
const { LLM_SHOP_SCHEMA } = require("../bot/shop");

const OWNER = 100;
const quiet = { info() {}, warn() {}, error() {} };
let tg, an;
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

async function makeApp({ adminBot = false, env = {} } = {}) {
  tg.reset();
  an.reset();
  clock = Date.parse("2026-11-05T10:00:00Z"); // чт 13:00 МСК
  const cfg = {
    ...loadConfig({ OWNER_IDS: String(OWNER), ...env }),
    telegramApiBase: tg.url,
    anthropicBaseUrl: an.url,
    anthropicApiKey: "test-key",
    debounceMs: 30,
    llmTimeoutMs: 1500,
    setupTimeoutMs: 3000,
    typing: { baseMs: 0, perCharMs: 3, minMs: 60, maxMs: 600, pauseMs: 10 },
    dataFile: tmpFile(),
  };
  const store = new Store(cfg.dataFile, { log: quiet });
  store.load();
  store.state.shop.demoBusy = false;
  const api = new TelegramApi("main-token", { base: tg.url, log: quiet });
  const consoleApi = adminBot ? new TelegramApi("admin-token", { base: tg.url, log: quiet }) : null;
  const llm = new Llm({ apiKey: "test-key", baseURL: an.url, model: cfg.model, fallbacks: true, log: quiet });
  const app = new App({ cfg, store, api, consoleApi, llm, log: quiet, now: () => clock, fetchImpl: fakeYandexFetch });
  await app.init();
  return app;
}

const user = (id, first_name = "Иван", username = "ivan") => ({ id, is_bot: false, first_name, username });

async function clientSays(app, id, text, extra = {}) {
  await app.handleUpdate({
    update_id: upd++,
    message: { message_id: upd, chat: { id, type: "private" }, from: user(id), date: 0, text, ...extra },
  });
}

async function adminSays(app, text, source = "main", extra = {}) {
  await app.handleUpdate(
    { update_id: upd++, message: { message_id: upd, chat: { id: OWNER, type: "private" }, from: user(OWNER, "Мастер", "boss"), date: 0, text, ...extra } },
    source
  );
}

async function press(app, data, source = "main", from = OWNER) {
  await app.handleUpdate(
    {
      update_id: upd++,
      callback_query: { id: `cq${upd}`, from: user(from, "Мастер"), data, message: { message_id: 1, chat: { id: from, type: "private" } } },
    },
    source
  );
}

const confident = (reply) => final({ reply, confidence: 0.95, handoff: false, handoff_reason: "" });
const lastConv = (app) => Object.values(app.state.conversations).at(-1);

// ---------- ответы и «печатает» ----------

test("бот отвечает: сначала «печатает» пропорционально длине, потом сообщение", async () => {
  const app = await makeApp();
  const short = "Да, работаем 😊";
  const long = "Мужская стрижка стоит 1 800 ₽ и длится час: консультация, мытьё головы, стрижка и укладка. Подобрать вам время на завтра?";
  an.respond = () => confident(short);
  await clientSays(app, 501, "Вы работаете сегодня?");
  await app.idle();
  an.respond = () => confident(long);
  await clientSays(app, 501, "А сколько стоит стрижка?");
  await app.idle();

  const msgs = tg.sentTo(501);
  assert.deepEqual(msgs.map((m) => m.params.text), [short, long]);
  const actions = tg.of("sendChatAction", (p) => p.chat_id === 501);
  assert.equal(actions.length, 2);
  assert.ok(actions.every((a) => a.params.action === "typing"));
  const gaps = msgs.map((m, i) => m.at - actions[i].at);
  const expected = [short, long].map((t) => typingDuration(t, app.cfg.typing));
  for (let i = 0; i < 2; i++) assert.ok(gaps[i] >= expected[i] - 15, `пауза ${gaps[i]} < ${expected[i]}`);
  assert.ok(gaps[1] > gaps[0] + 100, "длинный ответ печатается дольше");
  assert.equal(tg.of("readBusinessMessage").length, 0);

  // Запрос к ИИ: модель, инструменты, схема ответа, кэш, fallback
  const req = an.requests[0];
  assert.equal(req.body.model, "claude-opus-5-5");
  assert.equal(req.body.fallbacks, "default");
  assert.match(req.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(req.body.output_config.effort, "low");
  assert.equal(req.body.output_config.format.type, "json_schema");
  assert.deepEqual(req.body.tools.map((t) => t.name), ["get_free_slots", "create_booking", "list_client_bookings", "cancel_booking"]);
  assert.deepEqual(req.body.system[0].cache_control, { type: "ephemeral" });
  assert.match(req.body.system[0].text, /Мужская стрижка/);
  assert.match(req.body.system[1].text, /четверг/);
  assert.equal(req.body.messages.at(-1).content, "Вы работаете сегодня?");
  assert.equal(an.requests[1].body.messages.length, 3); // вопрос, ответ, вопрос
});

test("несколько сообщений подряд — один ответ", async () => {
  const app = await makeApp();
  an.respond = () => confident("Подскажу!");
  await clientSays(app, 502, "Здравствуйте");
  await clientSays(app, 502, "хочу на стрижку");
  await app.idle();
  assert.equal(an.requests.length, 1);
  assert.equal(an.requests[0].body.messages.at(-1).content, "Здравствуйте\nхочу на стрижку");
  assert.equal(tg.sentTo(502).length, 1);
});

// ---------- передача мастеру ----------

test("низкая уверенность: клиенту ничего, мастеру карточка с черновиком; черновик уходит по кнопке", async () => {
  const app = await makeApp();
  an.respond = () => final({ reply: "Думаю, с собакой можно 🙂", confidence: 0.3, handoff: false, handoff_reason: "про животных в данных ничего" });
  await clientSays(app, 503, "Можно прийти с собакой?");
  await app.idle();

  assert.equal(tg.sentTo(503).length, 0);
  assert.equal(tg.of("sendChatAction", (p) => p.chat_id === 503).length, 0, "не «печатаем», если не отвечаем");
  const card = tg.sentTo(OWNER).at(-1);
  assert.match(card.params.text, /Нужен ответ мастера/);
  assert.match(card.params.text, /с собакой можно/);
  assert.match(card.params.text, /не уверен/);
  const conv = lastConv(app);
  assert.equal(conv.status, "waiting");
  const buttons = card.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes(`c:send:${conv.id}`));

  // Пока ждём мастера, бот молчит
  await clientSays(app, 503, "Ау?");
  await app.idle();
  assert.equal(an.requests.length, 1);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /Ау\?/);

  await press(app, `c:send:${conv.id}`);
  await app.idle();
  assert.equal(tg.sentTo(503).at(-1).params.text, "Думаю, с собакой можно 🙂");
  assert.equal(conv.status, "bot");
});

test("таймаут ИИ → мастеру, клиенту ничего; «бот, попробуй ещё» отвечает", async () => {
  const app = await makeApp();
  an.respond = () => ({ delayMs: 2500, response: confident("поздно") });
  await clientSays(app, 504, "Есть окно сегодня?");
  await app.idle();
  assert.equal(tg.sentTo(504).length, 0);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /таймаут/);
  const conv = lastConv(app);
  assert.equal(conv.status, "waiting");

  an.respond = () => confident("Сегодня есть 15:00 и 17:30. Записать?");
  await press(app, `c:retry:${conv.id}`);
  await app.idle();
  assert.equal(tg.sentTo(504).at(-1).params.text, "Сегодня есть 15:00 и 17:30. Записать?");
});

test("ошибка API и просьба позвать человека тоже уходят мастеру", async () => {
  const app = await makeApp();
  an.respond = () => ({ status: 400, error: "bad" });
  await clientSays(app, 505, "Привет");
  await app.idle();
  assert.equal(tg.sentTo(505).length, 0);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /ошибка запроса к ИИ/);

  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "клиент просит мастера" });
  await clientSays(app, 506, "Позовите живого человека");
  await app.idle();
  assert.equal(tg.sentTo(506).length, 0);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /клиент просит мастера/);
});

test("голосовое → сразу мастеру, без ИИ", async () => {
  const app = await makeApp();
  await clientSays(app, 507, undefined, { voice: { file_id: "v1", duration: 3 } });
  await app.idle();
  assert.equal(an.requests.length, 0);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /голосовое/);
});

// ---------- запись ----------

test("запись через инструменты: свободные слоты → запись → уведомление мастеру", async () => {
  const app = await makeApp();
  let chosen;
  an.respond = (body, n) => {
    if (n === 1) return toolUse("get_free_slots", { service_id: "s4", date_from: "2026-11-06", days: 1, staff_id: null });
    if (n === 2) {
      const result = JSON.parse(body.messages.at(-1).content[0].content);
      chosen = result.days[0].staff[0];
      return toolUse("create_booking", {
        service_id: "s4",
        date: "2026-11-06",
        time: chosen.times[0],
        staff_id: chosen.staff_id,
        client_name: "Иван",
        phone: "+79001234567",
        comment: null,
      });
    }
    const booked = JSON.parse(body.messages.at(-1).content[0].content);
    assert.equal(booked.ok, true);
    return confident(`Готово! Записал вас на ${booked.booking.when}, мастер ${booked.booking.master}.`);
  };
  await clientSays(app, 508, "Запишите на стрижку с бородой на завтра, Иван, +79001234567");
  await app.idle();

  assert.equal(chosen.times[0], "10:00");
  const b = app.state.bookings[0];
  assert.equal(b.serviceId, "s4");
  assert.equal(b.slots, 3);
  assert.equal(b.durationMin, 90);
  assert.equal(b.client.phone, "+79001234567");
  assert.match(tg.sentTo(508).at(-1).params.text, /Готово/);
  assert.ok(tg.sentTo(OWNER).some((m) => /Новая запись/.test(m.params.text) && /Стрижка \+ борода/.test(m.params.text)));
  assert.equal(lastConv(app).session.booked, true);
  // Это время теперь занято у этого мастера
  const again = await import("../bot/schedule.js").then((m) =>
    m.freeStarts(app.state, app.shop, { date: "2026-11-06", staffId: b.staffId, slots: 1, now: clock })
  );
  assert.ok(!again.includes(600) && !again.includes(630) && !again.includes(660));

  // Напоминание за 2 часа
  clock = Date.parse("2026-11-06T05:30:00Z"); // пт 08:30 МСК, запись в 10:00
  await app.checkReminders();
  await app.idle();
  assert.match(tg.sentTo(508).at(-1).params.text, /Напоминаю/);
});

// ---------- перехват мастером ----------

test("мастер перехватывает диалог, пишет клиенту и возвращает боту", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 509, "Добрый день");
  await app.idle();
  const conv = lastConv(app);

  await press(app, `c:take:${conv.id}`);
  assert.equal(conv.status, "admin");
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /Вы ведёте диалог/);

  await clientSays(app, 509, "Можно скидку?");
  await app.idle();
  assert.equal(an.requests.length, 1, "бот молчит, пока ведёт мастер");
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /Можно скидку/);

  await adminSays(app, "Для вас — 10% 🙂");
  await app.idle();
  assert.equal(tg.sentTo(509).at(-1).params.text, "Для вас — 10% 🙂");
  assert.equal(conv.messages.at(-1).role, "admin");

  an.respond = () => confident("Отлично, ждём вас!");
  await press(app, `c:bot:${conv.id}`);
  await app.idle();
  assert.equal(conv.status, "bot");
  assert.equal(an.requests.length, 1, "последним писал мастер — боту отвечать не на что");
  await clientSays(app, 509, "Спасибо!");
  await app.idle();
  assert.equal(tg.sentTo(509).at(-1).params.text, "Отлично, ждём вас!");
  assert.match(an.requests.at(-1).body.messages.at(-2).content, /\[ответил мастер\] Для вас — 10%/);
});

test("ответ реплаем на уведомление уходит этому клиенту; свой чат перехватить нельзя", async () => {
  const app = await makeApp();
  an.respond = () => final({ reply: "", confidence: 0.2, handoff: true, handoff_reason: "жалоба" });
  await clientSays(app, 510, "Мне не понравилась стрижка");
  await app.idle();
  // message_id карточки — из ответа фейкового сервера
  const ref = Object.entries(app.state.consoleRefs).find(([, v]) => v === lastConv(app).id)[0].split(":")[1];
  await adminSays(app, "Извините! Переделаем бесплатно.", "main", { reply_to_message: { message_id: Number(ref) } });
  await app.idle();
  assert.equal(tg.sentTo(510).at(-1).params.text, "Извините! Переделаем бесплатно.");
  assert.equal(lastConv(app).status, "admin");

  // Мастер пишет боту как клиент (проверка) — это обычный клиентский диалог
  await press(app, `c:bot:${lastConv(app).id}`);
  an.respond = () => confident("Здравствуйте, мастер!");
  await adminSays(app, "Проверка как клиент");
  await app.idle();
  const own = lastConv(app);
  assert.equal(own.chatId, OWNER);
  await press(app, `c:take:${own.id}`);
  assert.equal(own.status, "bot");
  assert.match(tg.of("answerCallbackQuery").at(-1).params.text, /собственный чат/);
});

// ---------- Telegram Business ----------

test("Business: читает только когда отвечает; ответ мастера из своего Telegram ставит бота на паузу", async () => {
  const app = await makeApp();
  await app.handleUpdate({
    update_id: upd++,
    business_connection: {
      id: "bc1",
      user: user(OWNER, "Мастер"),
      user_chat_id: OWNER,
      date: 0,
      rights: { can_reply: true, can_read_messages: true },
      is_enabled: true,
    },
  });
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /Бот подключён/);

  const biz = (id, text, from = user(601, "Пётр", "petr"), extra = {}) =>
    app.handleUpdate({
      update_id: upd++,
      business_message: { message_id: upd, business_connection_id: "bc1", chat: { id: 601, type: "private", first_name: "Пётр" }, from, date: 0, text, ...extra },
    });

  an.respond = () => confident("Завтра есть 12:00 и 16:30. Записать?");
  await biz(601, "Есть время завтра?");
  await app.idle();
  const read = tg.of("readBusinessMessage");
  const action = tg.of("sendChatAction", (p) => p.chat_id === 601);
  const sent = tg.sentTo(601);
  assert.equal(read.length, 1);
  assert.equal(read[0].params.business_connection_id, "bc1");
  assert.equal(action[0].params.business_connection_id, "bc1");
  assert.equal(sent[0].params.business_connection_id, "bc1");
  assert.ok(read[0].at <= action[0].at && action[0].at <= sent[0].at, "прочитал → печатает → ответил");

  // Не уверен — сообщение остаётся непрочитанным
  an.respond = () => final({ reply: "черновик", confidence: 0.2, handoff: false, handoff_reason: "" });
  await biz(601, "А вы делаете тату?");
  await app.idle();
  assert.equal(tg.of("readBusinessMessage").length, 1, "второе сообщение не прочитано");
  assert.equal(tg.sentTo(601).length, 1);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /непрочитанным/);

  // Мастер ответил сам из своего аккаунта → бот на паузе
  await biz(601, "Тату не делаем, но подскажу хороший салон", user(OWNER, "Мастер"));
  await app.idle();
  const conv = lastConv(app);
  assert.equal(conv.status, "admin");
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /Вы ответили/);
  await biz(601, "Спасибо!");
  await app.idle();
  assert.equal(an.requests.length, 2, "бот не вмешивается");

  // Вернули боту — он отвечает на «Спасибо!»; эхо его же сообщений не считается ручным ответом мастера
  an.respond = () => confident("Пожалуйста! Ждём вас 💈");
  await press(app, `c:bot:${conv.id}`);
  await app.idle();
  assert.equal(tg.sentTo(601).at(-1).params.text, "Пожалуйста! Ждём вас 💈");
  assert.equal(tg.of("readBusinessMessage").length, 2);
  await biz(601, "эхо", user(OWNER, "Мастер"), { sender_business_bot: { id: 1, is_bot: true, first_name: "bot" } });
  assert.equal(conv.status, "bot");
});

test("Business: чужой аккаунт подключить нельзя", async () => {
  const app = await makeApp();
  await app.handleUpdate({
    update_id: upd++,
    business_connection: { id: "bc2", user: user(777, "Чужой"), user_chat_id: 777, date: 0, rights: { can_reply: true }, is_enabled: true },
  });
  assert.match(tg.sentTo(777).at(-1).params.text, /другой точки/);
  await app.handleUpdate({
    update_id: upd++,
    business_message: { message_id: 5, business_connection_id: "bc2", chat: { id: 778, type: "private" }, from: user(778), date: 0, text: "Привет" },
  });
  await app.idle();
  assert.equal(an.requests.length, 0);
});

// ---------- настройка точки ----------

const ORG_HTML = `<html><head><title>Барбершоп Тест — Яндекс Карты</title></head><body>
<h1>Барбершоп Тест</h1><div>Барбершоп · Мужская парикмахерская</div><div>Ул. Ленина, 5, Казань</div><div>Ежедневно, 10:00–20:00</div><div>+7 (843) 000-11-22</div><div>Оплата картой и наличными</div></body></html>`;
const PRICES_HTML = `<html><body><div>Мужская стрижка</div><div>1 500 ₽</div><div>1 ч</div><div>Борода</div><div>900 ₽</div><div>30 мин</div></body></html>`;

async function fakeYandexFetch(url) {
  const html = /prices/.test(url) ? PRICES_HTML : ORG_HTML;
  return { status: 200, url: url.replace("/maps/-/abc", "/maps/org/barbershop_test/1234567890/"), text: async () => html };
}

const importedShop = {
  name: "Барбершоп Тест",
  city: "Казань",
  address: "ул. Ленина, 5",
  phone: "+7 (843) 000-11-22",
  site: "",
  description: "",
  slot_minutes: 30,
  hours: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => ({ day, closed: false, open: "10:00", close: "20:00" })),
  staff: ["Руслан"],
  services: [
    { name: "Мужская стрижка", price: "1 500 ₽", duration_minutes: 60, slots: 2, description: "" },
    { name: "Борода", price: "900 ₽", duration_minutes: 30, slots: 1, description: "" },
  ],
  knowledge: ["Оплата картой и наличными"],
  changes: ["Мастер в карточке не указан — проверьте имя"],
};

test("настройка: импорт с Яндекс.Карт → предпросмотр → сохранить; правка словами", async () => {
  const app = await makeApp();
  an.respond = () => final(importedShop);
  await press(app, "s:yandex");
  assert.equal(app.state.admins[OWNER].mode, "await_yandex");
  await adminSays(app, "Вот: https://yandex.ru/maps/-/abc");
  await app.idle();
  assert.equal(an.requests.length, 1);
  const importReq = an.requests[0].body;
  assert.deepEqual(importReq.output_config.format.schema, LLM_SHOP_SCHEMA);
  assert.match(importReq.messages[0].content, /Ул\. Ленина, 5/);
  assert.match(importReq.messages[0].content, /Вкладка «Цены»/);
  assert.match(importReq.messages[0].content, /Борода\n900 ₽/);
  const preview = tg.sentTo(OWNER).at(-1);
  assert.match(preview.params.text, /Проверьте, что получилось/);
  assert.match(preview.params.text, /Барбершоп Тест/);
  assert.match(preview.params.text, /проверьте имя/);
  assert.equal(app.shop.demo, true, "до подтверждения ничего не меняется");

  await press(app, "s:save");
  assert.equal(app.shop.name, "Барбершоп Тест");
  assert.equal(app.shop.demo, false);
  assert.equal(app.shop.services.length, 2);
  assert.equal(app.shop.services[0].slots, 2);
  assert.match(app.shop.yandexUrl, /1234567890/);
  assert.equal(app.state.admins[OWNER].mode, null);

  // Клиент сразу получает ответы по новой точке
  an.respond = () => confident("Ок");
  await clientSays(app, 520, "Привет");
  await app.idle();
  assert.match(an.requests.at(-1).body.system[0].text, /Барбершоп Тест/);

  // Правка словами
  an.respond = (body) => {
    const text = body.messages[0].content.at(-1).text;
    const cur = JSON.parse(text.match(/\(JSON\):\n(.*)\n\nСообщение/s)[1]);
    cur.hours = cur.hours.map((h) => (h.day === "sun" ? { ...h, closed: true } : h));
    return final({ ...cur, changes: ["Воскресенье — выходной"] });
  };
  await press(app, "s:edit");
  await adminSays(app, "по воскресеньям выходной");
  await app.idle();
  assert.match(an.requests.at(-1).body.messages[0].content.at(-1).text, /по воскресеньям выходной/);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /Воскресенье — выходной/);
  await press(app, "s:save");
  assert.equal(app.shop.hours.sun, null);
  assert.deepEqual(app.shop.hours.sat, ["10:00", "20:00"]);
});

test("настройка: если Яндекс показал капчу — просим скриншоты или текст", async () => {
  const app = await makeApp({ env: { YANDEX_WEB_FETCH: "off" } });
  app.fetchImpl = async (url) => ({ status: 200, url: "https://yandex.ru/showcaptcha?x", text: async () => "captcha" });
  await press(app, "s:yandex");
  await adminSays(app, "https://yandex.ru/maps/org/x/123456789/");
  await app.idle();
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /капчу/);
  assert.equal(app.state.admins[OWNER].mode, "await_edit");
  assert.equal(an.requests.length, 0);
});

test("знания: заметка сохраняется как есть и попадает в промпт", async () => {
  const app = await makeApp();
  await press(app, "s:kadd");
  await adminSays(app, "Студентам скидка 10% по студенческому");
  await app.idle();
  assert.ok(app.shop.knowledge.some((k) => k.text === "Студентам скидка 10% по студенческому"));
  an.respond = () => confident("Да, 10%");
  await clientSays(app, 521, "Есть скидки студентам?");
  await app.idle();
  assert.match(an.requests.at(-1).body.system[0].text, /Студентам скидка 10%/);
});

test("приглашение мастера и отдельный бот для панели", async () => {
  const app = await makeApp({ adminBot: true });
  await press(app, "m:invite", "console");
  const inviteMsg = tg.calls.filter((c) => c.token === "admin-token" && c.method === "sendMessage").at(-1);
  const code = inviteMsg.params.text.match(/start=adm_([\w-]+)/)[1];
  assert.match(inviteMsg.params.text, /t\.me\/test_admin_bot/);

  await app.handleUpdate(
    { update_id: upd++, message: { message_id: 9, chat: { id: 700, type: "private" }, from: user(700, "Руслан"), date: 0, text: `/start adm_${code}` } },
    "console"
  );
  assert.equal(app.role(700), "admin");
  assert.equal(app.state.admins[700].mode, "await_yandex");
  assert.ok(tg.calls.some((c) => c.token === "admin-token" && c.params.chat_id === 700 && /настроим вашу точку/.test(c.params.text)));
  assert.ok(tg.calls.some((c) => c.token === "admin-token" && c.params.chat_id === OWNER && /принял приглашение/.test(c.params.text)));

  // Повторно ссылка не работает
  await app.handleUpdate(
    { update_id: upd++, message: { message_id: 10, chat: { id: 701, type: "private" }, from: user(701), date: 0, text: `/start adm_${code}` } },
    "console"
  );
  assert.equal(app.role(701), null);

  // Клиентский бот: мастер в нём — обычный клиент, уведомления идут через бота панели
  an.respond = () => final({ reply: "", confidence: 0.1, handoff: true, handoff_reason: "тест" });
  await clientSays(app, 702, "Вопрос");
  await app.idle();
  assert.ok(tg.calls.some((c) => c.token === "admin-token" && c.params.chat_id === 700 && /Нужен ответ мастера/.test(c.params.text)));
  assert.ok(!tg.calls.some((c) => c.token === "main-token" && c.params.chat_id === 700));
});

test("панель: списки текущих и незавершённых переписок", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 530, "Сколько стоит бритьё?");
  await app.idle();
  await press(app, "m:panel");
  const panel = tg.of("editMessageText").at(-1);
  assert.match(panel.params.text, /Панель мастера/);
  await press(app, "m:list:unfinished");
  const list = tg.of("editMessageText").at(-1);
  assert.match(list.params.text, /Незавершённые/);
  assert.match(list.params.text, /Сколько стоит бритьё|Здравствуйте/);
  await press(app, `c:open:${lastConv(app).id}`);
  const card = tg.of("editMessageText").at(-1);
  assert.match(card.params.text, /ведёт бот/);
  assert.ok(card.params.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === `c:take:${lastConv(app).id}`));
});

test("long polling: апдейты доходят до бота, offset сдвигается", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  tg.updates["main-token"] = [
    { update_id: 50, message: { message_id: 1, chat: { id: 540, type: "private" }, from: user(540), date: 0, text: "Привет" } },
  ];
  let offset = 0;
  const poller = new Poller(app.api, (u) => app.handleUpdate(u, "main"), { log: quiet, timeoutSec: 0, getOffset: () => offset, setOffset: (id) => (offset = id) });
  await poller.start();
  while (!tg.sentTo(540).length) await new Promise((r) => setTimeout(r, 20));
  poller.stop();
  await app.idle();
  assert.equal(offset, 50);
  assert.equal(tg.sentTo(540)[0].params.text, "Здравствуйте!");
  assert.ok(tg.of("getUpdates").some((c) => c.params.offset === 51));
  assert.ok(tg.of("deleteWebhook").length >= 1);
});

test("защита от спама: после лимита бот зовёт мастера", async () => {
  const app = await makeApp({ env: { LLM_CALLS_PER_HOUR: "2" } });
  an.respond = () => confident("Ок");
  for (const t of ["раз", "два", "три"]) {
    await clientSays(app, 541, t);
    await app.idle();
  }
  assert.equal(an.requests.length, 2);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /слишком часто/);
});
