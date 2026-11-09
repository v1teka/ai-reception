// Сквозные сценарии: настоящий App + TelegramApi + Anthropic SDK против фейковых серверов.
const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeTelegram, FakeAnthropic, final, toolUse, message, tmpFile } = require("./fakes");
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

async function makeApp({ adminBot = false, env = {}, dataFile = tmpFile() } = {}) {
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
    dataFile,
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

// Сообщение от другого мастера (не владельца)
async function masterSays(app, id, text) {
  await app.handleUpdate({
    update_id: upd++,
    message: { message_id: upd, chat: { id, type: "private" }, from: user(id, "Руслан", "ruslan"), date: 0, text },
  });
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
  assert.match(req.body.system[0].text, /\[s1\] Мужская стрижка — 1 800 ₽/); // данные точки, а не пример из правил
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

// Ждать условия, но не дольше ms: зависший тест должен упасть, а не держать CI и автодеплой
const waitFor = async (cond, ms = 5000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor: условие так и не выполнилось");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("клиент дописал, пока бот «печатал», — бот бросает устаревший ответ и переписывает его с учётом нового", async () => {
  const app = await makeApp();
  app.cfg.typing = { ...app.cfg.typing, minMs: 1000, maxMs: 1000 };
  let n = 0;
  an.respond = () => confident(n++ ? "Стрижка с бородой — 2 700 ₽. Записать вас?" : "Мужская стрижка — 1 800 ₽. Записать вас?");
  await clientSays(app, 509, "Сколько стоит стрижка?");
  await waitFor(() => tg.of("sendChatAction", (p) => p.chat_id === 509).length);
  const t = Date.now();
  await clientSays(app, 509, "Ой, с бородой");
  await app.idle();

  // Устаревший ответ клиент так и не увидел — только новый
  assert.deepEqual(tg.sentTo(509).map((m) => m.params.text), ["Стрижка с бородой — 2 700 ₽. Записать вас?"]);
  // Второй запрос: неотправленный ответ стоит в истории там, где был бы, с пометкой — ИИ решит,
  // дописать к нему или ответить заново. Слова клиента в системный промпт не попадают.
  const req = an.requests[1].body;
  assert.deepEqual(
    req.messages.map((m) => [m.role, m.content]),
    [
      ["user", "Сколько стоит стрижка?"],
      ["assistant", "[не отправлено] Мужская стрижка — 1 800 ₽. Записать вас?"],
      ["user", "Ой, с бородой"],
    ]
  );
  assert.match(req.system[1].text, /пометкой \[не отправлено\] клиент не видел/);
  assert.doesNotMatch(req.system[1].text, /бородой/);
  assert.ok(an.requests[1].at - t < 600, "«печатает» бросили сразу, а не допечатали устаревший ответ");
  assert.deepEqual(lastConv(app).messages.map((m) => m.role), ["client", "client", "bot"]);
});

test("клиент дописал про другое — бот отправляет начатый ответ и дописывает ответ на новое", async () => {
  const app = await makeApp();
  app.cfg.typing = { ...app.cfg.typing, minMs: 300, maxMs: 300 };
  an.respond = (body, n) =>
    confident(n === 1 ? "Мужская стрижка — 1 800 ₽." : "Мужская стрижка — 1 800 ₽.\n\nМы на ул. Примерной, 1.");
  await clientSays(app, 510, "Сколько стоит стрижка?");
  await waitFor(() => tg.of("sendChatAction", (p) => p.chat_id === 510).length);
  await clientSays(app, 510, "А где вы находитесь?");
  await app.idle();

  // Выглядит так, будто бот ответил на первый вопрос и дописал второй
  assert.deepEqual(tg.sentTo(510).map((m) => m.params.text), ["Мужская стрижка — 1 800 ₽.", "Мы на ул. Примерной, 1."]);
  assert.equal(an.requests.length, 2);
});

test("клиент дописал, пока ИИ думал, — ответ переписывается, а не уходит устаревшим", async () => {
  const app = await makeApp();
  an.respond = (body, n) => (n === 1 ? { delayMs: 300, response: confident("На какой день вас записать?") } : confident("Завтра есть 12:00 и 15:30. Какое удобно?"));
  await clientSays(app, 511, "Хочу на стрижку");
  await waitFor(() => an.requests.length === 1);
  await clientSays(app, 511, "завтра после обеда");
  await app.idle();

  assert.deepEqual(tg.sentTo(511).map((m) => m.params.text), ["Завтра есть 12:00 и 15:30. Какое удобно?"]);
  assert.deepEqual(
    an.requests[1].body.messages.map((m) => m.content),
    ["Хочу на стрижку", "[не отправлено] На какой день вас записать?", "завтра после обеда"]
  );
});

test("клиент дописал, а ИИ на новом круге дал сбой — начатый ответ всё равно уходит, мастеру карточка", async () => {
  const app = await makeApp();
  app.cfg.typing = { ...app.cfg.typing, minMs: 400, maxMs: 400 };
  an.respond = (body, n) => (n === 1 ? confident("Мужская стрижка — 1 800 ₽.") : { status: 400, error: "bad" });
  await clientSays(app, 550, "Сколько стоит стрижка?");
  await waitFor(() => tg.of("sendChatAction", (p) => p.chat_id === 550).length);
  await clientSays(app, 550, "А в субботу работаете?");
  await app.idle();

  assert.deepEqual(tg.sentTo(550).map((m) => m.params.text), ["Мужская стрижка — 1 800 ₽."]);
  const conv = lastConv(app);
  assert.equal(conv.status, "waiting");
  assert.equal(conv.handoff.question, "А в субботу работаете?");
  assert.deepEqual(conv.messages.map((m) => m.role), ["client", "bot", "client"]);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /ошибка запроса к ИИ/);
});

test("клиент дописал то, на что нужен мастер, — «уточню» с тем, что уже было готово, уходит одним сообщением", async () => {
  const app = await makeApp();
  app.cfg.typing = { ...app.cfg.typing, minMs: 400, maxMs: 400 };
  an.respond = (body, n) =>
    n === 1
      ? confident("Мужская стрижка — 1 800 ₽.")
      : final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "скидки решает мастер", hold: "Мужская стрижка — 1 800 ₽. Про скидку уточню и скоро отвечу." });
  await clientSays(app, 551, "Сколько стоит стрижка?");
  await waitFor(() => tg.of("sendChatAction", (p) => p.chat_id === 551).length);
  await clientSays(app, 551, "А студентам скидка есть?");
  await app.idle();

  assert.deepEqual(tg.sentTo(551).map((m) => m.params.text), ["Мужская стрижка — 1 800 ₽. Про скидку уточню и скоро отвечу."]);
  assert.match(an.requests[1].body.system[1].text, /напиши в hold то, что из того ответа ещё верно/);
  // начатый ответ клиент уже получил внутри «уточню» — мастеру его отдельным черновиком не предлагаем
  const card = tg.sentTo(OWNER).at(-1);
  assert.match(card.params.text, /Клиенту пишу: «Мужская стрижка — 1 800 ₽\. Про скидку уточню и скоро отвечу\.»/);
  assert.doesNotMatch(card.params.text, /Черновик бота/);
  assert.ok(!JSON.stringify(card.params.reply_markup).includes("c:send"));
  assert.deepEqual(lastConv(app).messages.map((m) => [m.role, Boolean(m.hold)]), [["client", false], ["client", false], ["bot", true]]);
});

test("фото, пока бот «печатал», ответ не сбивает: ответ уходит, фото — мастеру", async () => {
  const app = await makeApp();
  app.cfg.typing = { ...app.cfg.typing, minMs: 300, maxMs: 300 };
  an.respond = () => confident("Мужская стрижка — 1 800 ₽.");
  await clientSays(app, 512, "Сколько стоит стрижка?");
  await waitFor(() => tg.of("sendChatAction", (p) => p.chat_id === 512).length);
  await clientSays(app, 512, undefined, { photo: [{ file_id: "p1", width: 10, height: 10 }], caption: "Вот так сможете?" });
  await app.idle();

  assert.equal(an.requests.length, 1);
  assert.deepEqual(tg.sentTo(512).map((m) => m.params.text), ["Мужская стрижка — 1 800 ₽.", "Посмотрю и скоро отвечу"]);
  // «печатает» не обрывалось и не начиналось заново: один раз на ответ, один на «посмотрю»
  assert.equal(tg.of("sendChatAction", (p) => p.chat_id === 512).length, 2);
  assert.equal(lastConv(app).status, "waiting");
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /фото/);
});

test("ответ о сделанной записи уходит, даже если клиент дописал", async () => {
  const app = await makeApp();
  app.cfg.typing = { ...app.cfg.typing, minMs: 300, maxMs: 300 };
  an.respond = (body, n) => {
    if (n === 1)
      return toolUse("create_booking", {
        service_id: "s2",
        date: "2026-11-06",
        time: "12:00",
        staff_id: "m1",
        client_name: "Иван",
        phone: null,
        comment: null,
      });
    if (n === 2) return confident("Готово! Записал вас на завтра, 12:00.");
    return confident("Да, Артём.");
  };
  await clientSays(app, 513, "Запишите на машинку завтра в 12, Иван");
  await waitFor(() => tg.of("sendChatAction", (p) => p.chat_id === 513).length);
  await clientSays(app, 513, "А мастер Артём?");
  await app.idle();

  assert.deepEqual(tg.sentTo(513).map((m) => m.params.text), ["Готово! Записал вас на завтра, 12:00.", "Да, Артём."]);
  assert.equal(app.state.bookings.length, 1);
});

test("после перезапуска бот отвечает тем, кому не успел ответить", async () => {
  const before = await makeApp();
  // Сообщение пришло, а ответить бот не успел (процесс перезапустили)
  const fresh = before.getConv({ kind: "direct", chatId: 510 }, user(510));
  before.pushMessage(fresh, { role: "client", text: "Есть время сегодня?", mid: 1 });
  fresh.lastClientAt = clock;
  // Без ответа больше часа — уже не трогаем
  const stale = before.getConv({ kind: "direct", chatId: 511 }, user(511));
  before.pushMessage(stale, { role: "client", text: "Привет", mid: 1 });
  stale.lastClientAt = clock - 2 * 3600000;
  before.store.flush();

  an.respond = () => confident("Да, сегодня есть 15:00 и 17:30.");
  const after = await makeApp({ dataFile: before.cfg.dataFile });
  await after.idle();
  assert.equal(tg.sentTo(510).at(-1)?.params.text, "Да, сегодня есть 15:00 и 17:30.");
  assert.equal(tg.sentTo(511).length, 0);
  assert.equal(an.requests.length, 1);
});

// ---------- передача мастеру ----------

test("низкая уверенность: клиенту «уточню и отвечу», мастеру карточка с черновиком; черновик уходит по кнопке", async () => {
  const app = await makeApp();
  an.respond = () =>
    final({ reply: "Думаю, с собакой можно 🙂", confidence: 0.3, handoff: false, handoff_reason: "про животных в данных ничего", hold: "С собакой можно, уточню детали" });
  await clientSays(app, 503, "Можно прийти с собакой?");
  await app.idle();

  // Догадку клиент не видит ни в ответе, ни в «уточню» — только стандартную фразу без фактов
  assert.deepEqual(tg.sentTo(503).map((m) => m.params.text), ["Уточню и скоро вам отвечу"]);
  const card = tg.sentTo(OWNER).at(-1);
  assert.match(card.params.text, /Нужен ответ мастера/);
  assert.match(card.params.text, /с собакой можно/);
  assert.match(card.params.text, /не уверен/);
  assert.match(card.params.text, /Клиенту пишу: «Уточню и скоро вам отвечу»/);
  const conv = lastConv(app);
  assert.equal(conv.status, "waiting");
  const buttons = card.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes(`c:send:${conv.id}`));
  // В списке «Ждут ответа» — вопрос клиента, а не «уточню»
  await press(app, "m:list:waiting");
  assert.match(tg.of("editMessageText").at(-1).params.text, /«Можно прийти с собакой\?»/);

  // Пока ждём мастера, бот молчит и второй раз «уточню» не пишет
  await clientSays(app, 503, "Ау?");
  await app.idle();
  assert.equal(an.requests.length, 1);
  assert.equal(tg.sentTo(503).length, 1);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /Ау\?/);

  await press(app, `c:send:${conv.id}`);
  await app.idle();
  assert.equal(tg.sentTo(503).at(-1).params.text, "Думаю, с собакой можно 🙂");
  assert.equal(conv.status, "bot");
});

test("не знает ответа: «уточню» пишет сам ИИ; «Бот, попробуй ещё» отвечает на вопрос и не повторяет «уточню»", async () => {
  const app = await makeApp();
  an.respond = () =>
    final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "про парковку в данных ничего", hold: "Уточню про парковку и скоро напишу 🙂" });
  await clientSays(app, 514, "Есть парковка?");
  await app.idle();
  assert.deepEqual(tg.sentTo(514).map((m) => m.params.text), ["Уточню про парковку и скоро напишу 🙂"]);
  const conv = lastConv(app);
  assert.equal(conv.handoff.question, "Есть парковка?");
  assert.equal(conv.messages.at(-1).hold, true);

  // Бот снова не справился — второй раз не обещает
  await press(app, `c:retry:${conv.id}`);
  await app.idle();
  assert.equal(tg.sentTo(514).length, 1);
  // Вопрос по-прежнему последний в истории, а про «уточню» ИИ знает
  const req = an.requests.at(-1).body;
  assert.deepEqual(req.messages, [{ role: "user", content: "Есть парковка?" }]);
  assert.match(req.system[1].text, /Клиенту уже ушло: «Уточню про парковку и скоро напишу 🙂»/);

  an.respond = () => confident("Да, бесплатная во дворе.");
  await press(app, `c:retry:${conv.id}`);
  await app.idle();
  assert.equal(tg.sentTo(514).at(-1).params.text, "Да, бесплатная во дворе.");
  assert.equal(conv.status, "bot");
});

test("мастер вернул диалог боту, ничего не ответив после «уточню», — бот отвечает на вопрос", async () => {
  const app = await makeApp();
  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "нет данных", hold: "Уточню и скоро отвечу" });
  await clientSays(app, 515, "Делаете тату?");
  await app.idle();
  const conv = lastConv(app);
  await press(app, `c:take:${conv.id}`);
  an.respond = () => confident("Тату не делаем.");
  await press(app, `c:bot:${conv.id}`);
  await app.idle();
  assert.equal(tg.sentTo(515).at(-1).params.text, "Тату не делаем.");
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

test("ошибка API — мастеру молча; просьба позвать человека — мастеру, клиенту ответ ИИ", async () => {
  const app = await makeApp();
  an.respond = () => ({ status: 400, error: "bad" });
  await clientSays(app, 505, "Привет");
  await app.idle();
  assert.equal(tg.sentTo(505).length, 0, "при сбое неизвестно, что обещать клиенту");
  assert.equal(tg.of("sendChatAction", (p) => p.chat_id === 505).length, 0, "не «печатаем», если не отвечаем");
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /ошибка запроса к ИИ/);
  assert.doesNotMatch(tg.sentTo(OWNER).at(-1).params.text, /Клиенту пишу/);

  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "клиент просит мастера", hold: "Хорошо, позову мастера — он скоро ответит" });
  await clientSays(app, 506, "Позовите живого человека");
  await app.idle();
  assert.deepEqual(tg.sentTo(506).map((m) => m.params.text), ["Хорошо, позову мастера — он скоро ответит"]);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /клиент просит мастера/);
});

test("голосовое → сразу мастеру, без ИИ; клиенту «послушаю и скоро отвечу»", async () => {
  const app = await makeApp();
  await clientSays(app, 507, undefined, { voice: { file_id: "v1", duration: 3 } });
  await app.idle();
  assert.equal(an.requests.length, 0);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /голосовое/);
  assert.deepEqual(tg.sentTo(507).map((m) => m.params.text), ["Послушаю и скоро отвечу"]);
});

test("гифка → мастеру, без «посмотрю и скоро отвечу»", async () => {
  const app = await makeApp();
  // У гифки Telegram заполняет и animation, и document
  await clientSays(app, 552, undefined, { animation: { file_id: "a1", duration: 2 }, document: { file_id: "a1", mime_type: "video/mp4" } });
  await app.idle();
  assert.equal(an.requests.length, 0);
  assert.equal(tg.sentTo(552).length, 0);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /гифку/);
});

test("мастер взял диалог, пока бот «печатал» «уточню», — «уточню» не уходит", async () => {
  const app = await makeApp();
  app.cfg.typing = { ...app.cfg.typing, minMs: 400, maxMs: 400 };
  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "нет данных", hold: "Уточню и скоро отвечу" });
  await clientSays(app, 516, "Делаете тату?");
  await waitFor(() => tg.sentTo(OWNER).some((m) => /Нужен ответ мастера/.test(m.params.text)));
  await press(app, `c:take:${lastConv(app).id}`);
  await app.idle();
  assert.equal(tg.sentTo(516).length, 0);
});

test("«Бот, попробуй ещё», пока бот «печатал» «уточню», — клиент получает одно «уточню», а не два", async () => {
  const app = await makeApp();
  app.cfg.typing = { ...app.cfg.typing, minMs: 400, maxMs: 400 };
  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "нет данных", hold: "Уточню и скоро отвечу" });
  await clientSays(app, 553, "Делаете тату?");
  await waitFor(() => tg.sentTo(OWNER).some((m) => /Нужен ответ мастера/.test(m.params.text)));
  await press(app, `c:retry:${lastConv(app).id}`);
  await app.idle();
  assert.equal(an.requests.length, 2);
  assert.deepEqual(tg.sentTo(553).map((m) => m.params.text), ["Уточню и скоро отвечу"]);
});

test("после «Завершить диалог» новый вопрос — новый разговор: снова «уточню», в карточке только новый вопрос", async () => {
  const app = await makeApp();
  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "нет данных", hold: "Уточню и скоро отвечу" });
  await clientSays(app, 554, "Делаете тату?");
  await app.idle();
  const conv = lastConv(app);
  await press(app, `c:close:${conv.id}`);
  assert.equal(conv.status, "bot");

  clock += 2 * 86400000;
  await clientSays(app, 554, "А скидка для студентов есть?");
  await app.idle();
  assert.deepEqual(tg.sentTo(554).map((m) => m.params.text), ["Уточню и скоро отвечу", "Уточню и скоро отвечу"]);
  assert.equal(conv.handoff.question, "А скидка для студентов есть?");
});

test("клиент заблокировал бота — бот не повторяет ответ по кругу: один запрос к ИИ, одно предупреждение", async () => {
  const app = await makeApp();
  tg.fail = (method, p) => method === "sendMessage" && p.chat_id === 555 && { code: 403, description: "Forbidden: bot was blocked by the user" };
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 555, "Привет");
  await app.idle();
  assert.equal(an.requests.length, 1);
  assert.equal(tg.sentTo(OWNER).filter((m) => /Не удалось отправить/.test(m.params.text)).length, 1);
  assert.equal(lastConv(app).status, "bot");
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

test("напоминание уходит, даже если диалог ведёт мастер, и ответом на вопрос клиента не считается", async () => {
  const app = await makeApp();
  an.respond = (body, n) =>
    n === 1
      ? toolUse("create_booking", { service_id: "s2", date: "2026-11-06", time: "12:00", staff_id: "m1", client_name: "Иван", phone: null, comment: null })
      : confident("Готово! Записал вас на завтра, 12:00.");
  await clientSays(app, 556, "Запишите на машинку завтра в 12, Иван");
  await app.idle();
  const conv = lastConv(app);

  // Вопрос, на который нужен мастер: он взял диалог и не ответил
  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "нет данных", hold: "Уточню и скоро отвечу" });
  await clientSays(app, 556, "А парковка есть?");
  await app.idle();
  await press(app, `c:take:${conv.id}`);

  clock = Date.parse("2026-11-06T07:30:00Z"); // пт 10:30 МСК, запись в 12:00
  await app.checkReminders();
  await app.idle();
  assert.match(tg.sentTo(556).at(-1).params.text, /Напоминаю/);
  assert.equal(conv.status, "admin");
  // В списках панели — вопрос клиента, а не напоминание и не «уточню»
  await press(app, "m:list:mine");
  const mine = tg.of("editMessageText").at(-1).params.text;
  assert.match(mine, /«А парковка есть\?»/);
  assert.doesNotMatch(mine, /Напоминаю|Уточню/);

  // Вернули боту — он отвечает на вопрос, который так и ждал ответа
  an.respond = () => confident("Да, бесплатная во дворе.");
  await press(app, `c:bot:${conv.id}`);
  await app.idle();
  assert.equal(tg.sentTo(556).at(-1).params.text, "Да, бесплатная во дворе.");
  const req = an.requests.at(-1).body;
  assert.equal(req.messages.at(-1).content, "А парковка есть?");
  assert.match(req.system[1].text, /Клиенту уже ушло: «Уточню и скоро отвечу», «Напоминаю/);
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

const refTo = (app, conv) => Number(Object.entries(app.state.consoleRefs).find(([, v]) => v === conv.id)[0].split(":")[1]);

test("незаконченная настройка точки не перехватывает ответ клиенту: «Взять диалог» и реплай", async () => {
  const app = await makeApp();
  // Мастер начал править точку и бросил
  await press(app, "s:edit");
  assert.equal(app.state.admins[OWNER].mode, "await_edit");

  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "скидки решает мастер", hold: "Уточню и скоро отвечу" });
  await clientSays(app, 517, "Можно скидку?");
  await app.idle();
  const conv = lastConv(app);
  const before = an.requests.length;

  await press(app, `c:take:${conv.id}`);
  await adminSays(app, "Для вас — 10% 🙂");
  await app.idle();
  assert.equal(tg.sentTo(517).at(-1).params.text, "Для вас — 10% 🙂");
  assert.equal(an.requests.length, before, "ответ клиенту не ушёл в ИИ как правка точки");
  assert.ok(!tg.sentTo(OWNER).some((m) => /Обновляю/.test(m.params.text)));

  // Снова открыл настройку — обычные сообщения идут в неё, а реплай на сообщение о переписке — клиенту
  await press(app, "s:edit");
  await adminSays(app, "Ждём вас в субботу!", "main", { reply_to_message: { message_id: refTo(app, conv) } });
  await app.idle();
  assert.equal(tg.sentTo(517).at(-1).params.text, "Ждём вас в субботу!");
  assert.equal(an.requests.length, before);

  an.respond = () => final({ ...importedShop, changes: ["Парковка во дворе"] });
  await adminSays(app, "есть парковка во дворе");
  await app.idle();
  assert.equal(an.requests.length, before + 1);
  assert.ok(tg.sentTo(OWNER).some((m) => /Обновляю настройки точки/.test(m.params.text)));
  assert.equal(tg.sentTo(517).at(-1).params.text, "Ждём вас в субботу!", "правка точки клиенту не ушла");
});

test("залипший режим настройки из старой версии не мешает диалогу с клиентом", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 518, "Добрый день");
  await app.idle();
  const conv = lastConv(app);
  await press(app, `c:take:${conv.id}`);
  // Так было у владельца до исправления: режим настройки остался, а диалог он взял раньше
  Object.assign(app.state.admins[OWNER], { mode: "await_edit", focus: undefined });
  await adminSays(app, "Сейчас подскажу");
  await app.idle();
  assert.equal(tg.sentTo(518).at(-1).params.text, "Сейчас подскажу");
  assert.equal(an.requests.length, 1);
});

test("мастер ведёт диалог и открыл «Изменить словами» — правка идёт в настройку, после «Отменить» — снова клиенту", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 519, "Добрый день");
  await app.idle();
  const conv = lastConv(app);
  await press(app, `c:take:${conv.id}`);

  await press(app, "s:edit");
  an.respond = () => final({ ...importedShop, changes: [] });
  await adminSays(app, "стрижка теперь 2000");
  await app.idle();
  assert.equal(an.requests.length, 2);
  assert.equal(tg.sentTo(519).length, 1, "правка точки клиенту не ушла");

  await press(app, "s:cancel");
  await adminSays(app, "Чем могу помочь?");
  await app.idle();
  assert.equal(tg.sentTo(519).at(-1).params.text, "Чем могу помочь?");
});

test("пока загружалась точка, мастер вернулся к клиенту — его сообщения уходят клиенту, черновик ждёт", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 520, "Добрый день");
  await app.idle();
  const conv = lastConv(app);
  await press(app, `c:take:${conv.id}`);

  await press(app, "s:yandex");
  an.respond = () => ({ delayMs: 300, response: final(importedShop) });
  await adminSays(app, "https://yandex.ru/maps/-/abc");
  await waitFor(() => an.requests.length === 2);
  await press(app, `c:write:${conv.id}`);
  await app.idle();

  const preview = tg.sentTo(OWNER).filter((m) => /Проверьте, что получилось/.test(m.params.text)).at(-1);
  assert.match(preview.params.text, /сообщения уходят клиенту/);
  assert.ok(preview.params.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "s:focus"));
  await adminSays(app, "Записал вас на завтра");
  await app.idle();
  assert.equal(tg.sentTo(520).at(-1).params.text, "Записал вас на завтра");
  assert.equal(an.requests.length, 2);

  // «Писать в настройку» — поправка идёт в черновик точки, а не клиенту; черновик не потерялся
  await press(app, "s:focus");
  an.respond = () => final({ ...importedShop, name: "Барбершоп Тест 2", changes: ["Новое название"] });
  await adminSays(app, "название — Барбершоп Тест 2");
  await app.idle();
  assert.equal(an.requests.length, 3);
  assert.equal(tg.sentTo(520).at(-1).params.text, "Записал вас на завтра");
  await press(app, "s:save");
  assert.equal(app.shop.name, "Барбершоп Тест 2");
});

test("настройка не удалась, пока мастер писал клиенту, — подсказка «Писать в настройку»; данные точки клиенту не уходят", async () => {
  const app = await makeApp({ env: { YANDEX_WEB_FETCH: "off" } });
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 557, "Добрый день");
  await app.idle();
  const conv = lastConv(app);
  await press(app, `c:take:${conv.id}`);

  await press(app, "s:yandex");
  app.fetchImpl = async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { status: 200, url: "https://yandex.ru/showcaptcha?x", text: async () => "captcha" };
  };
  await adminSays(app, "https://yandex.ru/maps/org/x/123456789/");
  await waitFor(() => tg.sentTo(OWNER).some((m) => /Загружаю карточку/.test(m.params.text)));
  await press(app, `c:write:${conv.id}`);
  await app.idle();

  const ask = tg.sentTo(OWNER).filter((m) => /Не получилось прочитать карточку/.test(m.params.text)).at(-1);
  assert.match(ask.params.text, /сообщения уходят клиенту/);
  assert.ok(ask.params.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "s:focus"));

  await press(app, "s:focus");
  an.respond = () => final({ ...importedShop, changes: ["Заполнено из текста"] });
  await adminSays(app, "Барбершоп Тест, Казань, ул. Ленина 5, стрижка 1500 ₽ час");
  await app.idle();
  assert.deepEqual(tg.sentTo(557).map((m) => m.params.text), ["Здравствуйте!"], "данные точки клиенту не ушли");
  assert.ok(tg.sentTo(OWNER).some((m) => /Проверьте, что получилось/.test(m.params.text)));
});

test("реплай клиенту посреди настройки точки не сбивает настройку: обычные сообщения по-прежнему идут в неё", async () => {
  const app = await makeApp();
  await press(app, "s:edit");
  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "скидки решает мастер", hold: "Уточню и скоро отвечу" });
  await clientSays(app, 558, "Можно скидку?");
  await app.idle();
  const conv = lastConv(app);

  // Ответил реплаем на карточку, не взяв диалог
  await adminSays(app, "Да, 10% 🙂", "main", { reply_to_message: { message_id: refTo(app, conv) } });
  await app.idle();
  assert.equal(tg.sentTo(558).at(-1).params.text, "Да, 10% 🙂");
  assert.equal(conv.status, "admin");
  const hint = tg.sentTo(OWNER).filter((m) => /Вы ведёте диалог/.test(m.params.text)).at(-1);
  assert.match(hint.params.text, /в настройке точки/);
  assert.ok(hint.params.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === `c:write:${conv.id}`));

  const before = an.requests.length;
  an.respond = () => final({ ...importedShop, changes: ["Укладка 700 ₽"] });
  await adminSays(app, "добавь услугу укладка 700 ₽ на 30 минут");
  await app.idle();
  assert.equal(an.requests.length, before + 1, "правка ушла в настройку");
  assert.equal(tg.sentTo(558).at(-1).params.text, "Да, 10% 🙂", "и не ушла клиенту");

  // «Писать сюда» — обычные сообщения снова уходят клиенту
  await press(app, `c:write:${conv.id}`);
  await adminSays(app, "Ждём вас!");
  await app.idle();
  assert.equal(tg.sentTo(558).at(-1).params.text, "Ждём вас!");
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

  // Не уверен — клиенту «уточню» от имени мастера, но сам бот сообщение прочитанным не отмечает
  an.respond = () => final({ reply: "черновик", confidence: 0.2, handoff: false, handoff_reason: "", hold: "" });
  await biz(601, "А вы делаете тату?");
  await app.idle();
  assert.equal(tg.of("readBusinessMessage").length, 1, "второе сообщение бот не читал");
  assert.deepEqual(tg.sentTo(601).map((m) => m.params.text), ["Завтра есть 12:00 и 16:30. Записать?", "Уточню и скоро вам отвечу"]);
  assert.equal(tg.sentTo(601).at(-1).params.business_connection_id, "bc1");
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /Ответить можно прямо в своём Telegram/);
  assert.doesNotMatch(tg.sentTo(OWNER).at(-1).params.text, /непрочитанным/);
  // ИИ знает, что пишет из личного аккаунта мастера, и не обещает «позвать мастера»
  assert.match(an.requests.at(-1).body.system[1].text, /личном Telegram мастера/);

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

test("Business: при сбое ИИ бот молчит и не читает сообщение", async () => {
  const app = await makeApp();
  await app.handleUpdate({
    update_id: upd++,
    business_connection: { id: "bc3", user: user(OWNER, "Мастер"), user_chat_id: OWNER, date: 0, rights: { can_reply: true, can_read_messages: true }, is_enabled: true },
  });
  an.respond = () => ({ status: 500, error: "down" });
  await app.handleUpdate({
    update_id: upd++,
    business_message: { message_id: upd, business_connection_id: "bc3", chat: { id: 603, type: "private", first_name: "Анна" }, from: user(603, "Анна"), date: 0, text: "Привет" },
  });
  await app.idle();
  assert.equal(tg.sentTo(603).length, 0);
  assert.equal(tg.of("readBusinessMessage").length, 0);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /непрочитанным/);
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

test("настройка: причину сбоя видит владелец бота, а мастер — только просьбу прислать данные иначе", async () => {
  const MASTER = 300;
  const app = await makeApp({ env: { YANDEX_WEB_FETCH: "off", ADMIN_IDS: String(MASTER) } });
  app.fetchImpl = async () => ({ status: 200, url: "https://yandex.ru/showcaptcha?cc=1", text: async () => "SmartCaptcha" });
  await press(app, "s:yandex", "main", MASTER);
  await masterSays(app, MASTER, "https://maps.yandex.ru/org/x/123456789/");
  await app.idle();

  const toMaster = tg.sentTo(MASTER).at(-1).params.text;
  assert.match(toMaster, /Не получилось прочитать карточку/);
  assert.match(toMaster, /Пришлите скриншоты/);
  assert.doesNotMatch(toMaster, /капч|HTTP|Причина/i);
  assert.equal(app.state.admins[MASTER].mode, "await_edit");

  const toOwner = tg.sentTo(OWNER).at(-1).params.text;
  assert.match(toOwner, /Не получилось загрузить точку с Яндекс\.Карт/);
  assert.match(toOwner, /Руслан @ruslan \(id 300\)/);
  assert.match(toOwner, /maps\.yandex\.ru\/org\/x\/123456789/);
  assert.match(toOwner, /Причина:<\/b> Яндекс показал капчу/);
  assert.match(toOwner, /Карточка: HTTP 200, 12 Б, итоговый адрес https:\/\/yandex\.ru\/showcaptcha\?cc=1, капча/);
  assert.match(toOwner, /выключен \(YANDEX_WEB_FETCH=off\)/);
  assert.equal(an.requests.length, 0);
});

test("настройка: владелец видит ошибку ИИ и ответ web_fetch, а не «не получилось разобрать»", async () => {
  const app = await makeApp();
  an.respond = (body) => {
    if (!body.tools) return { status: 400, error: "bad request" }; // разбор страницы
    return message(
      [
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_fetch", input: { url: "https://yandex.ru/maps/org/x/123456789/" } },
        { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_1", content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } },
        { type: "text", text: JSON.stringify({ ...importedShop, name: "", services: [], changes: [] }) },
      ],
      "end_turn"
    );
  };
  await press(app, "s:yandex");
  await adminSays(app, "https://yandex.ru/maps/org/x/123456789/");
  await app.idle();
  assert.equal(an.requests.length, 2);
  const text = tg.sentTo(OWNER).at(-1).params.text;
  assert.match(text, /Пришлите скриншоты/);
  assert.match(text, /видны только владельцу/);
  assert.match(text, /Причина:<\/b> не получилось разобрать карточку \(ошибка запроса к ИИ\)/);
  assert.match(text, /Карточка: HTTP 200/);
  assert.match(text, /Вкладка «Цены»: HTTP 200/);
  assert.match(text, /Разбор страницы ИИ: ошибка запроса к ИИ \(400 .*bad request/);
  assert.match(text, /Запасной путь \(ИИ сам открывает ссылку\): ИИ не получил данных со страницы; https:\/\/yandex\.ru\/maps\/org\/x\/123456789\/ → ошибка url_not_accessible/);
  // Владелец сам загружал — отдельного уведомления ему нет
  assert.equal(tg.sentTo(OWNER).filter((m) => /Не получилось загрузить точку/.test(m.params.text)).length, 0);
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
  await waitFor(() => tg.sentTo(540).length);
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

test("кнопки мастера не задерживают другие сообщения, пока бот думает или «печатает»", async () => {
  const app = await makeApp();
  app.cfg.typing = { ...app.cfg.typing, minMs: 400, maxMs: 400 };
  an.respond = () => final({ reply: "Черновик ответа", confidence: 0.3, handoff: false, handoff_reason: "" });
  await clientSays(app, 542, "Можно с ребёнком?");
  await app.idle();
  const conv = lastConv(app);
  assert.equal(conv.status, "waiting");

  let t = Date.now();
  await press(app, `c:send:${conv.id}`);
  assert.ok(Date.now() - t < 300, "отправка черновика не держит обработку апдейтов");
  await app.idle();
  assert.equal(tg.sentTo(542).at(-1).params.text, "Черновик ответа");
  assert.equal(conv.status, "bot");

  // «Бот, попробуй ещё» ждёт ИИ в фоне
  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "клиент просит мастера" });
  await clientSays(app, 542, "Позовите мастера");
  await app.idle();
  an.respond = () => ({ delayMs: 600, response: confident("Мастер скоро ответит 🙂") });
  t = Date.now();
  await press(app, `c:retry:${conv.id}`);
  assert.ok(Date.now() - t < 300, "повтор не держит обработку апдейтов");
  await app.idle();
  assert.equal(tg.sentTo(542).at(-1).params.text, "Мастер скоро ответит 🙂");
});

// ---------- гонки и границы: клиент дописал, «уточню», лимиты ----------

const texts = (id) => tg.sentTo(id).map((m) => m.params.text);
const cards = () => tg.sentTo(OWNER).filter((m) => /Нужен ответ мастера/.test(m.params.text));
const typingCalls = (id) => tg.of("sendChatAction", (p) => p.chat_id === id).length;
const slowTyping = (app, ms) => (app.cfg.typing = { ...app.cfg.typing, minMs: ms, maxMs: ms });

test("клиент дописал, а лимит запросов к ИИ исчерпан — начатый ответ уходит, мастеру карточка", async () => {
  const app = await makeApp({ env: { LLM_CALLS_PER_HOUR: "1" } });
  slowTyping(app, 400);
  an.respond = () => confident("Мужская стрижка — 1 800 ₽.");
  await clientSays(app, 560, "Сколько стоит стрижка?");
  await waitFor(() => typingCalls(560));
  await clientSays(app, 560, "А в субботу работаете?");
  await app.idle();

  assert.equal(an.requests.length, 1);
  assert.deepEqual(texts(560), ["Мужская стрижка — 1 800 ₽."]);
  assert.equal(lastConv(app).status, "waiting");
  assert.match(cards().at(-1).params.text, /слишком часто/);
  assert.deepEqual(lastConv(app).messages.map((m) => m.role), ["client", "bot", "client"]);
});

test("клиент дописал текст и следом фото — начатый ответ уходит, ИИ заново не зовём", async () => {
  const app = await makeApp();
  slowTyping(app, 400);
  an.respond = () => confident("Мужская стрижка — 1 800 ₽.");
  await clientSays(app, 561, "Сколько стоит стрижка?");
  await waitFor(() => typingCalls(561));
  await clientSays(app, 561, "А так сможете?");
  await clientSays(app, 561, undefined, { photo: [{ file_id: "p1", width: 10, height: 10 }] });
  await app.idle();

  assert.equal(an.requests.length, 1);
  assert.deepEqual(texts(561), ["Мужская стрижка — 1 800 ₽.", "Посмотрю и скоро отвечу"]);
  assert.equal(lastConv(app).status, "waiting");
  assert.match(cards().at(-1).params.text, /фото/);
});

test("мастер взял диалог, пока уходил начатый ответ, — карточка «нужен мастер» уже не приходит", async () => {
  const app = await makeApp();
  slowTyping(app, 400);
  an.respond = (body, n) => (n === 1 ? confident("Мужская стрижка — 1 800 ₽.") : { status: 400, error: "bad" });
  await clientSays(app, 562, "Сколько стоит стрижка?");
  await waitFor(() => typingCalls(562));
  await clientSays(app, 562, "А в субботу работаете?");
  await waitFor(() => an.requests.length === 2);
  await waitFor(() => typingCalls(562) >= 2);
  const before = cards().length;
  await press(app, `c:take:${lastConv(app).id}`);
  await app.idle();

  assert.equal(lastConv(app).status, "admin");
  assert.equal(cards().length, before);
  assert.deepEqual(texts(562), []);
});

test("ответ из двух сообщений, клиент дописал на втором — ИИ видит, что ушло, а что нет", async () => {
  const app = await makeApp();
  slowTyping(app, 400);
  an.respond = (body, n) =>
    confident(n === 1 ? "Мужская стрижка — 1 800 ₽.\n\nМы на ул. Примерной, 1." : "Мы на ул. Примерной, 1.\n\nВ субботу работаем.");
  await clientSays(app, 563, "Сколько стоит стрижка и где вы?");
  await waitFor(() => tg.sentTo(563).length === 1);
  await clientSays(app, 563, "А в субботу работаете?");
  await app.idle();

  assert.deepEqual(
    an.requests[1].body.messages.map((m) => [m.role, m.content]),
    [
      ["user", "Сколько стоит стрижка и где вы?"],
      ["assistant", "Мужская стрижка — 1 800 ₽.\n[не отправлено] Мы на ул. Примерной, 1."],
      ["user", "А в субботу работаете?"],
    ]
  );
  assert.deepEqual(texts(563), ["Мужская стрижка — 1 800 ₽.", "Мы на ул. Примерной, 1.", "В субботу работаем."]);
  assert.deepEqual(lastConv(app).messages.map((m) => m.role), ["client", "bot", "client", "bot", "bot"]);
});

test("клиент перебивает каждый круг — на четвёртом ответ уходит как есть, бот не зацикливается", async () => {
  const app = await makeApp();
  slowTyping(app, 300);
  an.respond = (body, n) => confident(`Ответ ${n}`);
  await clientSays(app, 564, "Вопрос 0");
  for (let i = 1; i <= 4; i++) {
    await waitFor(() => typingCalls(564) >= i);
    await clientSays(app, 564, `Вопрос ${i}`);
  }
  await app.idle();

  assert.equal(texts(564)[0], "Ответ 4");
  // пятый запрос — уже про «Вопрос 4», и отправленный «Ответ 4» в его истории есть
  assert.match(an.requests[4].body.messages.map((m) => m.content).join("\n"), /Ответ 4/);
  assert.equal(lastConv(app).status, "bot");
});

test("ИИ вернул пометку «[не отправлено]» в ответе — клиенту она не попадает", async () => {
  const app = await makeApp();
  slowTyping(app, 400);
  an.respond = (body, n) =>
    confident(n === 1 ? "Мужская стрижка — 1 800 ₽." : "[не отправлено] Мужская стрижка — 1 800 ₽.\n\nВ субботу работаем.");
  await clientSays(app, 565, "Сколько стоит стрижка?");
  await waitFor(() => typingCalls(565));
  await clientSays(app, 565, "А в субботу работаете?");
  await app.idle();

  assert.deepEqual(texts(565), ["Мужская стрижка — 1 800 ₽.", "В субботу работаем."]);
});

test("ИИ отказался отвечать — клиенту ничего не обещаем, мастеру карточка", async () => {
  const app = await makeApp();
  an.respond = () => message([{ type: "text", text: "" }], "refusal");
  await clientSays(app, 566, "Вопрос");
  await app.idle();

  assert.equal(lastConv(app).status, "waiting");
  assert.deepEqual(texts(566), []);
  assert.match(cards().at(-1).params.text, /ИИ отказался отвечать/);
});

test("слишком длинное «уточню» от ИИ заменяется стандартной фразой", async () => {
  const app = await makeApp();
  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "нет данных", hold: "Уточню. ".repeat(100) });
  await clientSays(app, 567, "Вопрос");
  await app.idle();

  assert.deepEqual(texts(567), ["Уточню и скоро вам отвечу"]);
});

test("«Вернуть боту» после напоминания: отвечать не на что — бот молчит и мастера не зовёт", async () => {
  const app = await makeApp();
  an.respond = (body, n) =>
    n === 1
      ? toolUse("create_booking", { service_id: "s2", date: "2026-11-06", time: "12:00", staff_id: "m1", client_name: "Иван", phone: null, comment: null })
      : confident("Готово! Записал вас на завтра, 12:00.");
  await clientSays(app, 568, "Запишите на машинку завтра в 12, Иван");
  await app.idle();
  const conv = lastConv(app);
  clock = Date.parse("2026-11-06T07:30:00Z");
  await app.checkReminders();
  await app.idle();
  assert.match(texts(568).at(-1), /Напоминаю/);

  await press(app, `c:take:${conv.id}`);
  await press(app, `c:bot:${conv.id}`);
  await app.idle();
  assert.equal(conv.status, "bot");
  assert.equal(cards().length, 0);
  assert.equal(an.requests.length, 2);
});

test("ответ встаёт в историю перед тем, что клиент дописал позже, даже если между ними напоминание", async () => {
  const app = await makeApp();
  slowTyping(app, 600);
  an.respond = (body, n) => {
    if (n === 1)
      return toolUse("create_booking", { service_id: "s2", date: "2026-11-05", time: "16:00", staff_id: "m1", client_name: "Иван", phone: null, comment: null });
    if (n === 2) return confident("Готово! Записал вас на сегодня, 16:00.");
    return confident("Да, Артём. Парковка во дворе.");
  };
  await clientSays(app, 569, "Запишите на машинку сегодня в 16, Иван");
  await waitFor(() => typingCalls(569));
  // Пока бот «печатает» ответ о записи: клиент дописал, пришло время напоминания, клиент дописал ещё
  slowTyping(app, 60);
  await clientSays(app, 569, "А мастер Артём?");
  clock = Date.parse("2026-11-05T11:30:00Z"); // 14:30 МСК, запись в 16:00
  await app.checkReminders();
  await waitFor(() => texts(569).some((t) => /Напоминаю/.test(t)));
  await clientSays(app, 569, "И парковка есть?");
  await app.idle();

  const conv = lastConv(app);
  // Ответ о записи написан до обоих вопросов — в истории он перед ними, и оба вопроса бот считает неотвеченными
  assert.deepEqual(
    conv.messages.map((m) => (m.notice ? "напоминание" : `${m.role}: ${m.text}`)),
    [
      "client: Запишите на машинку сегодня в 16, Иван",
      "bot: Готово! Записал вас на сегодня, 16:00.",
      "client: А мастер Артём?",
      "напоминание",
      "client: И парковка есть?",
      "bot: Да, Артём. Парковка во дворе.",
    ]
  );
  // ИИ видит то же самое: напоминание стоит там, где клиент его получил, и ответом не считается
  const req = an.requests.at(-1).body;
  assert.deepEqual(
    req.messages.slice(-4).map((m) => [m.role, m.content.replace(/^Напоминаю.*/s, "Напоминаю…")]),
    [
      ["assistant", "Готово! Записал вас на сегодня, 16:00."],
      ["user", "А мастер Артём?"],
      ["assistant", "Напоминаю…"],
      ["user", "И парковка есть?"],
    ]
  );
  assert.match(req.system[1].text, /Клиенту уже ушло: «Напоминаю/);
});

test("после «Завершить диалог» и перезапуска бот не отвечает на старый вопрос", async () => {
  const before = await makeApp();
  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "нет данных", hold: "Уточню и скоро отвечу" });
  await clientSays(before, 570, "А парковка есть?");
  await before.idle();
  const conv = lastConv(before);
  await press(before, `c:close:${conv.id}`);
  await before.idle();
  assert.equal(conv.status, "bot");
  assert.equal(before.pendingClientMessages(conv).length, 1);
  before.store.flush();

  an.respond = () => confident("Да, во дворе.");
  const after = await makeApp({ dataFile: before.cfg.dataFile });
  await after.idle();
  assert.equal(an.requests.length, 0);
  assert.equal(tg.sentTo(570).length, 0);
});

// ---------- Business: что считается прочитанным ----------

async function bizConnect(app, id = "bcX") {
  await app.handleUpdate({
    update_id: upd++,
    business_connection: { id, user: user(OWNER, "Мастер"), user_chat_id: OWNER, date: 0, rights: { can_reply: true, can_read_messages: true }, is_enabled: true },
  });
}

// Сообщение клиента в чате Business; возвращает его message_id
async function bizSays(app, chat, text, { connId = "bcX", from = user(chat, "Анна", "anna"), extra = {} } = {}) {
  const update_id = upd++;
  const mid = upd++;
  await app.handleUpdate({
    update_id,
    business_message: { message_id: mid, business_connection_id: connId, chat: { id: chat, type: "private", first_name: "Анна" }, from, date: 0, text, ...extra },
  });
  return mid;
}

test("Business: начатый ответ ушёл, а на новое бот не ответил — новое остаётся непрочитанным", async () => {
  const app = await makeApp();
  await bizConnect(app);
  slowTyping(app, 400);
  an.respond = (body, n) => (n === 1 ? confident("Мужская стрижка — 1 800 ₽.") : { status: 400, error: "bad" });
  const q1 = await bizSays(app, 604, "Сколько стоит стрижка?");
  await waitFor(() => typingCalls(604));
  const q2 = await bizSays(app, 604, "А в субботу работаете?");
  await app.idle();

  assert.deepEqual(texts(604), ["Мужская стрижка — 1 800 ₽."]);
  assert.deepEqual(tg.of("readBusinessMessage").map((c) => c.params.message_id), [q1]);
  assert.deepEqual(lastConv(app).unread, [q2]);
  assert.match(cards().at(-1).params.text, /Сообщение осталось непрочитанным/);
});

test("Business: клиент дописал, пока ИИ думал, а новый круг не удался — прочитано только то, на что бот ответил", async () => {
  const app = await makeApp();
  await bizConnect(app);
  an.respond = (body, n) => (n === 1 ? { delayMs: 300, response: confident("Мужская стрижка — 1 800 ₽.") } : { status: 400, error: "bad" });
  const q1 = await bizSays(app, 605, "Сколько стоит стрижка?");
  await waitFor(() => an.requests.length === 1);
  const q2 = await bizSays(app, 605, "А в субботу работаете?");
  await app.idle();

  assert.deepEqual(texts(605), ["Мужская стрижка — 1 800 ₽."]);
  assert.deepEqual(tg.of("readBusinessMessage").map((c) => c.params.message_id), [q1]);
  assert.deepEqual(lastConv(app).unread, [q2]);
});

test("Business: бот ответил на оба сообщения — оба прочитаны, по очереди", async () => {
  const app = await makeApp();
  await bizConnect(app);
  slowTyping(app, 400);
  an.respond = (body, n) => confident(n === 1 ? "Мужская стрижка — 1 800 ₽." : "Мужская стрижка — 1 800 ₽.\n\nВ субботу работаем с 10 до 20.");
  const q1 = await bizSays(app, 606, "Сколько стоит стрижка?");
  await waitFor(() => typingCalls(606));
  const q2 = await bizSays(app, 606, "А в субботу работаете?");
  await app.idle();

  assert.deepEqual(texts(606), ["Мужская стрижка — 1 800 ₽.", "В субботу работаем с 10 до 20."]);
  assert.deepEqual(tg.of("readBusinessMessage").map((c) => c.params.message_id), [q1, q2]);
  assert.deepEqual(lastConv(app).unread, []);
});

test("Business: напоминание о записи не помечает новое сообщение клиента прочитанным", async () => {
  const app = await makeApp();
  await bizConnect(app);
  an.respond = (body, n) =>
    n === 1
      ? toolUse("create_booking", { service_id: "s2", date: "2026-11-06", time: "12:00", staff_id: "m1", client_name: "Анна", phone: null, comment: null })
      : confident("Готово! Записал вас на завтра, 12:00.");
  await bizSays(app, 607, "Запишите на машинку завтра в 12, Анна");
  await app.idle();
  const conv = lastConv(app);
  await press(app, `c:take:${conv.id}`);
  const q2 = await bizSays(app, 607, "А можно на 13?");
  await app.idle();
  const reads = tg.of("readBusinessMessage").length;

  clock = Date.parse("2026-11-06T07:30:00Z");
  await app.checkReminders();
  await app.idle();
  assert.match(texts(607).at(-1), /Напоминаю/);
  assert.equal(tg.of("readBusinessMessage").length, reads);
  assert.deepEqual(conv.unread, [q2]);
});

// ---------- начатый ответ и передача мастеру ----------

test("клиент дописал, а в новом ответе бот не уверен — начатый ответ уходит, за ним «уточню»; в черновике мастеру только новое", async () => {
  const app = await makeApp();
  slowTyping(app, 400);
  an.respond = (body, n) =>
    n === 1
      ? confident("Мужская стрижка — 1 800 ₽.")
      : final({ reply: "Мужская стрижка — 1 800 ₽.\n\nДумаю, студентам скидка 10%.", confidence: 0.3, handoff: false, handoff_reason: "про скидки в данных ничего", hold: "" });
  await clientSays(app, 571, "Сколько стоит стрижка?");
  await waitFor(() => typingCalls(571));
  await clientSays(app, 571, "А студентам скидка есть?");
  await app.idle();

  assert.deepEqual(texts(571), ["Мужская стрижка — 1 800 ₽.", "Уточню и скоро вам отвечу"]);
  const conv = lastConv(app);
  assert.equal(conv.status, "waiting");
  assert.deepEqual(conv.messages.map((m) => [m.role, Boolean(m.hold)]), [["client", false], ["bot", false], ["client", false], ["bot", true]]);
  // То, что клиент уже получил, мастеру повторно не предлагаем: в черновике — только догадка про скидку
  assert.equal(conv.handoff.draft, "Думаю, студентам скидка 10%.");
  assert.equal(conv.handoff.question, "А студентам скидка есть?");
  const card = cards().at(-1).params.text;
  assert.match(card, /Черновик бота: «Думаю, студентам скидка 10%\.»/);
  assert.match(card, /Клиенту пишу: «Уточню и скоро вам отвечу»/);

  // «Отправить черновик» досылает только новое
  await press(app, `c:send:${conv.id}`);
  await app.idle();
  assert.deepEqual(texts(571), ["Мужская стрижка — 1 800 ₽.", "Уточню и скоро вам отвечу", "Думаю, студентам скидка 10%."]);
});

test("клиент дописал, а на новое ИИ отказался отвечать — начатый ответ уходит, обещаний нет, мастеру карточка", async () => {
  const app = await makeApp();
  slowTyping(app, 400);
  an.respond = (body, n) => (n === 1 ? confident("Мужская стрижка — 1 800 ₽.") : message([{ type: "text", text: "" }], "refusal"));
  await clientSays(app, 572, "Сколько стоит стрижка?");
  await waitFor(() => typingCalls(572));
  await clientSays(app, 572, "А что-нибудь покрепче есть?");
  await app.idle();

  assert.deepEqual(texts(572), ["Мужская стрижка — 1 800 ₽."]);
  const conv = lastConv(app);
  assert.equal(conv.status, "waiting");
  assert.equal(conv.handoff.question, "А что-нибудь покрепче есть?");
  assert.deepEqual(conv.messages.map((m) => m.role), ["client", "bot", "client"]);
  assert.match(cards().at(-1).params.text, /ИИ отказался отвечать/);
  assert.doesNotMatch(cards().at(-1).params.text, /Клиенту пишу/);
});

test("«Бот, попробуй ещё» после «уточню»: клиент дописал, на новое снова нужен мастер — ответ на первый вопрос уходит, на второй бот обещает уточнить", async () => {
  const app = await makeApp();
  an.respond = (body, n) => {
    if (n === 1) return final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "нет данных", hold: "Про парковку уточню и скоро отвечу." });
    if (n === 2) return confident("Парковка есть, во дворе.");
    return final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "скидки решает мастер", hold: "Парковка есть, во дворе. Про скидку уточню." });
  };
  await clientSays(app, 573, "А парковка есть?");
  await app.idle();
  assert.deepEqual(texts(573), ["Про парковку уточню и скоро отвечу."]);

  const conv = lastConv(app);
  slowTyping(app, 400);
  const typed = typingCalls(573);
  await press(app, `c:retry:${conv.id}`);
  await waitFor(() => typingCalls(573) > typed);
  await clientSays(app, 573, "А студентам скидка есть?");
  await app.idle();

  // Своё «уточню» с повтором ответа бот не пишет (одно обещание клиент уже получил):
  // готовый ответ уходит как есть, а про новое — короткое «уточню»
  assert.deepEqual(texts(573), ["Про парковку уточню и скоро отвечу.", "Парковка есть, во дворе.", "Уточню и скоро вам отвечу"]);
  assert.equal(conv.status, "waiting");
  assert.equal(conv.handoff.question, "А студентам скидка есть?");
  assert.deepEqual(conv.messages.map((m) => [m.role, Boolean(m.hold)]), [
    ["client", false],
    ["bot", true],
    ["bot", false],
    ["client", false],
    ["bot", true],
  ]);
});

// ---------- «Отправить черновик» ----------

test("«Отправить черновик», а мастер взял диалог, пока бот «печатал», — черновик не уходит, мастеру об этом сказано", async () => {
  const app = await makeApp();
  an.respond = () => final({ reply: "Думаю, с собакой можно 🙂", confidence: 0.3, handoff: false, handoff_reason: "про животных в данных ничего", hold: "" });
  await clientSays(app, 574, "Можно прийти с собакой?");
  await app.idle();
  const conv = lastConv(app);
  assert.deepEqual(texts(574), ["Уточню и скоро вам отвечу"]);

  slowTyping(app, 400);
  const typed = typingCalls(574);
  await press(app, `c:send:${conv.id}`);
  await waitFor(() => typingCalls(574) > typed);
  await press(app, `c:take:${conv.id}`);
  await app.idle();

  assert.deepEqual(texts(574), ["Уточню и скоро вам отвечу"]);
  assert.equal(conv.status, "admin");
  assert.equal(an.requests.length, 1);
  const owner = tg.sentTo(OWNER).map((m) => m.params.text);
  assert.ok(owner.some((t) => /Черновик для <b>Иван<\/b> не отправлен: диалог взял мастер/.test(t)));
  assert.ok(!owner.some((t) => /Черновик отправлен/.test(t)));
});

test("«Отправить черновик», а сообщение не дошло — мастеру предупреждение, «отправлен» не пишем, ИИ заново не зовём", async () => {
  const app = await makeApp();
  an.respond = () => final({ reply: "Думаю, с собакой можно 🙂", confidence: 0.3, handoff: false, handoff_reason: "про животных в данных ничего", hold: "" });
  await clientSays(app, 575, "Можно прийти с собакой?");
  await app.idle();
  const conv = lastConv(app);

  tg.fail = (method, p) => (method === "sendMessage" && String(p.chat_id) === "575" ? { code: 403, description: "Forbidden: bot was blocked by the user" } : null);
  await press(app, `c:send:${conv.id}`);
  await app.idle();

  assert.equal(texts(575).filter((t) => /собакой/.test(t)).length, 1); // попытка была одна
  assert.equal(an.requests.length, 1);
  const owner = tg.sentTo(OWNER).map((m) => m.params.text);
  assert.ok(owner.some((t) => /Не удалось отправить сообщение клиенту <b>Иван<\/b>/.test(t)));
  assert.ok(!owner.some((t) => /Черновик отправлен/.test(t)));
});

// ---------- куда уходят сообщения мастера: настройка точки и несколько диалогов ----------

const lastRefTo = (app, conv) => Number(Object.entries(app.state.consoleRefs).filter(([, v]) => v === conv.id).at(-1)[0].split(":")[1]);
const buttons = (m) => m.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
const takeoverHint = () => tg.sentTo(OWNER).filter((m) => /Вы ведёте диалог/.test(m.params.text)).at(-1);

test("клиент пишет, пока мастер правит точку, — в его сообщении сказано, куда идут ответы, и есть «Писать сюда»", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 576, "Добрый день");
  await app.idle();
  const conv = lastConv(app);
  await press(app, `c:take:${conv.id}`);
  await press(app, "s:edit");

  await clientSays(app, 576, "А скидка есть?");
  await app.idle();
  const fwd = tg.sentTo(OWNER).at(-1);
  assert.match(fwd.params.text, /<b>Иван<\/b>: А скидка есть\?/);
  assert.match(fwd.params.text, /Обычные сообщения сейчас идут в настройку точки\. Ответьте реплаем на это сообщение или нажмите «Писать сюда»\./);
  assert.equal(fwd.params.reply_markup.inline_keyboard[0][0].callback_data, `c:write:${conv.id}`);

  // Реплай на это сообщение уходит клиенту, а настройка остаётся открытой: обычное сообщение — в неё
  await adminSays(app, "Да, 10% 🙂", "main", { reply_to_message: { message_id: lastRefTo(app, conv) } });
  await app.idle();
  assert.equal(texts(576).at(-1), "Да, 10% 🙂");
  const before = an.requests.length;
  an.respond = () => final({ ...importedShop, changes: ["Парковка во дворе"] });
  await adminSays(app, "есть парковка во дворе");
  await app.idle();
  assert.equal(an.requests.length, before + 1, "правка ушла в настройку");
  assert.equal(texts(576).at(-1), "Да, 10% 🙂", "и не ушла клиенту");
});

test("настройку точки открыли и забыли: через 15 минут сообщение клиента возвращает ответы мастера в диалог", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 577, "Добрый день");
  await app.idle();
  const conv = lastConv(app);
  await press(app, `c:take:${conv.id}`);
  await press(app, "s:edit");
  clock += 16 * 60 * 1000;

  await clientSays(app, 577, "А скидка есть?");
  await app.idle();
  const fwd = tg.sentTo(OWNER).at(-1);
  assert.match(fwd.params.text, /<b>Иван<\/b>: А скидка есть\?/);
  assert.match(fwd.params.text, /Настройка точки не закончена, но обычные сообщения теперь снова уходят этому клиенту\./);
  assert.ok(buttons(fwd).includes("s:focus"));
  assert.ok(!buttons(fwd).includes(`c:write:${conv.id}`));

  const before = an.requests.length;
  await adminSays(app, "Да, 10% 🙂");
  await app.idle();
  assert.equal(texts(577).at(-1), "Да, 10% 🙂");
  assert.equal(an.requests.length, before, "ответ клиенту не ушёл в ИИ как правка точки");
  assert.equal(app.state.admins[OWNER].mode, "await_edit", "настройка не закрыта — к ней можно вернуться");

  // «Писать в настройку» возвращает к настройке
  await press(app, "s:focus");
  an.respond = () => final({ ...importedShop, changes: ["Парковка во дворе"] });
  await adminSays(app, "есть парковка во дворе");
  await app.idle();
  assert.equal(an.requests.length, before + 1);
  assert.equal(texts(577).at(-1), "Да, 10% 🙂");
});

test("настройку точки открыли и забыли: реплай клиенту через 15 минут — дальше обычные сообщения идут этому клиенту", async () => {
  const app = await makeApp();
  await press(app, "s:edit");
  clock += 16 * 60 * 1000;
  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "скидки решает мастер", hold: "Уточню и скоро отвечу" });
  await clientSays(app, 584, "Можно скидку?");
  await app.idle();
  const conv = lastConv(app);
  const before = an.requests.length;

  await adminSays(app, "Да, 10% 🙂", "main", { reply_to_message: { message_id: refTo(app, conv) } });
  await app.idle();
  assert.equal(texts(584).at(-1), "Да, 10% 🙂");
  assert.match(takeoverHint().params.text, /Пишите сюда — я передам клиенту/);
  assert.match(takeoverHint().params.text, /Настройка точки не закончена: чтобы вернуться к ней, нажмите «Писать в настройку»\./);
  assert.ok(buttons(takeoverHint()).includes("s:focus"));

  await adminSays(app, "Ждём вас в субботу!");
  await app.idle();
  assert.equal(texts(584).at(-1), "Ждём вас в субботу!");
  assert.equal(an.requests.length, before, "в настройку точки ничего не ушло");
});

test("мастер ведёт два диалога: в сообщении от другого клиента сказано, кому сейчас уходят ответы", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 578, "Добрый день");
  await app.idle();
  const first = lastConv(app);
  await clientSays(app, 585, "Здравствуйте", { from: user(585, "Пётр", "petr") });
  await app.idle();
  const second = lastConv(app);
  assert.notEqual(first.id, second.id);
  await press(app, `c:take:${first.id}`);
  await press(app, `c:take:${second.id}`);

  await clientSays(app, 578, "А скидка есть?");
  await app.idle();
  const fwd = tg.sentTo(OWNER).at(-1);
  assert.match(fwd.params.text, /Обычные сообщения сейчас уходят клиенту <b>Пётр<\/b>\. Ответьте реплаем на это сообщение или нажмите «Писать сюда»\./);
  assert.equal(fwd.params.reply_markup.inline_keyboard[0][0].callback_data, `c:write:${first.id}`);

  // Обычное сообщение уходит тому, кого мастер выбрал последним; после «Писать сюда» — первому
  await adminSays(app, "Пётр, ждём вас!");
  await app.idle();
  assert.equal(texts(585).at(-1), "Пётр, ждём вас!");
  await press(app, `c:write:${first.id}`);
  await adminSays(app, "Да, 10% 🙂");
  await app.idle();
  assert.equal(texts(578).at(-1), "Да, 10% 🙂");
  assert.equal(texts(585).at(-1), "Пётр, ждём вас!");

  // Сообщение от клиента, которому мастер пишет сейчас, приходит без подсказки
  await clientSays(app, 578, "Спасибо!");
  await app.idle();
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /<b>Иван<\/b>: Спасибо!/);
  assert.doesNotMatch(tg.sentTo(OWNER).at(-1).params.text, /Обычные сообщения сейчас/);
});

test("карточка переписки сменилась другим экраном — реплай на это сообщение клиенту уже не уходит", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 579, "Добрый день");
  await app.idle();
  const conv = lastConv(app);

  // Одно и то же сообщение панели: переписка → меню → настройки
  await press(app, `c:open:${conv.id}`);
  assert.equal(app.state.consoleRefs[`${OWNER}:1`], conv.id);
  await press(app, "m:panel");
  await press(app, "m:settings");
  assert.equal(app.state.consoleRefs[`${OWNER}:1`], undefined);
  await press(app, "s:edit");

  const before = an.requests.length;
  an.respond = () => final({ ...importedShop, changes: ["Стрижка — 2 000 ₽"] });
  await adminSays(app, "стрижка теперь 2000 ₽, длится час", "main", { reply_to_message: { message_id: 1 } });
  await app.idle();
  assert.deepEqual(texts(579), ["Здравствуйте!"]);
  assert.equal(conv.status, "bot");
  assert.equal(an.requests.length, before + 1, "правка ушла в настройку точки");
});

test("мастер ведёт диалог: настройки, меню и «Отменить» напоминают, что его сообщения уходят клиенту", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 580, "Добрый день");
  await app.idle();
  const conv = lastConv(app);
  const note = /Сейчас ваши сообщения уходят клиенту <b>Иван<\/b>\./;

  // Пока диалог ведёт бот, таких подсказок нет
  await press(app, "m:settings");
  assert.doesNotMatch(tg.of("editMessageText").at(-1).params.text, /уходят клиенту/);
  await adminSays(app, "/start");
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /Чтобы проверить бота как клиент, просто напишите ему обычное сообщение/);

  await press(app, `c:take:${conv.id}`);
  await press(app, "m:settings");
  assert.match(tg.of("editMessageText").at(-1).params.text, note);
  await adminSays(app, "/start");
  assert.match(tg.sentTo(OWNER).at(-1).params.text, note);
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /Чтобы проверить бота как клиент, сначала верните этот диалог боту/);

  await press(app, "s:edit");
  await press(app, "s:cancel");
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /Отменено, данные точки не менялись\. Сейчас ваши сообщения уходят клиенту <b>Иван<\/b>\./);
  await press(app, "s:edit");
  await adminSays(app, "/cancel");
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /Отменено\. Сейчас ваши сообщения уходят клиенту <b>Иван<\/b>\./);

  // Команды диалог не бросают: обычное сообщение по-прежнему уходит клиенту
  await adminSays(app, "Чем могу помочь?");
  await app.idle();
  assert.equal(texts(580).at(-1), "Чем могу помочь?");
  assert.equal(an.requests.length, 1);
});

test("мастер взял диалог при открытой настройке точки — в подсказке сказано, как вернуться к настройке", async () => {
  const app = await makeApp();
  await press(app, "s:edit");
  an.respond = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "скидки решает мастер", hold: "Уточню и скоро отвечу" });
  await clientSays(app, 581, "Можно скидку?");
  await app.idle();
  const conv = lastConv(app);

  await press(app, `c:take:${conv.id}`);
  assert.match(takeoverHint().params.text, /Пишите сюда — я передам клиенту/);
  assert.match(takeoverHint().params.text, /Настройка точки не закончена: чтобы вернуться к ней, нажмите «Писать в настройку»\./);
  assert.ok(buttons(takeoverHint()).includes("s:focus"));
  assert.ok(!buttons(takeoverHint()).includes(`c:write:${conv.id}`));

  // «Писать в настройку» — обычные сообщения идут в настройку, клиенту — только реплаем
  await press(app, "s:focus");
  assert.match(tg.sentTo(OWNER).at(-1).params.text, /Теперь ваши сообщения идут в настройку точки/);
  const before = an.requests.length;
  an.respond = () => final({ ...importedShop, changes: ["Парковка во дворе"] });
  await adminSays(app, "есть парковка во дворе");
  await app.idle();
  assert.equal(an.requests.length, before + 1);
  assert.deepEqual(texts(581), ["Уточню и скоро отвечу"]);
});

test("«Писать сюда» на старом сообщении, когда диалог уже вернули боту, — мастер снова ведёт диалог, бот молчит", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 582, "Добрый день");
  await app.idle();
  const conv = lastConv(app);
  await press(app, `c:take:${conv.id}`);
  await press(app, `c:bot:${conv.id}`);
  assert.equal(conv.status, "bot");

  await press(app, `c:write:${conv.id}`);
  assert.equal(conv.status, "admin");
  assert.equal(conv.handledBy, OWNER);
  assert.equal(tg.of("answerCallbackQuery").at(-1).params.text, "Пишите — сообщения уйдут этому клиенту");
  assert.match(takeoverHint().params.text, /Вы ведёте диалог с <b>Иван<\/b>\. Бот в этом чате молчит/);

  await adminSays(app, "Чем могу помочь?");
  await clientSays(app, 582, "А скидка есть?");
  await app.idle();
  assert.deepEqual(texts(582), ["Здравствуйте!", "Чем могу помочь?"]);
  assert.equal(an.requests.length, 1, "бот не отвечает, пока диалог ведёт мастер");
});

test("другой мастер вернул диалог боту — тому, кто его вёл, об этом сказано; сам себе мастер такого не пишет", async () => {
  const MASTER = 200;
  const app = await makeApp({ env: { ADMIN_IDS: String(MASTER) } });
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 583, "Добрый день");
  await app.idle();
  const conv = lastConv(app);
  const returned = /Диалог с <b>Иван<\/b> вернули боту — ваши сообщения этому клиенту больше не уходят\./;

  await press(app, `c:take:${conv.id}`);
  let told = tg.sentTo(OWNER).length;
  await press(app, `c:bot:${conv.id}`, "main", MASTER);
  await app.idle();
  assert.equal(conv.status, "bot");
  let toOwner = tg.sentTo(OWNER).slice(told);
  assert.equal(toOwner.length, 1);
  assert.match(toOwner[0].params.text, returned);
  assert.doesNotMatch(toOwner[0].params.text, /настройку точки/);
  assert.ok(buttons(toOwner[0]).includes(`c:take:${conv.id}`));
  assert.equal(app.state.admins[OWNER].relayTo, null);
  // Тому, кто нажал, — обычное подтверждение
  const toMaster = tg.sentTo(MASTER).map((m) => m.params.text);
  assert.ok(toMaster.some((t) => /Бот снова ведёт диалог с <b>Иван<\/b>/.test(t)));
  assert.ok(!toMaster.some((t) => returned.test(t)));

  // У владельца открыта настройка точки — ему сказано, куда теперь пойдут обычные сообщения
  await press(app, "s:edit");
  await press(app, `c:take:${conv.id}`);
  told = tg.sentTo(OWNER).length;
  await press(app, `c:bot:${conv.id}`, "main", MASTER);
  await app.idle();
  toOwner = tg.sentTo(OWNER).slice(told);
  assert.equal(toOwner.length, 1);
  assert.match(toOwner[0].params.text, returned);
  assert.match(toOwner[0].params.text, /Обычные сообщения теперь идут в настройку точки\./);

  // Вернул сам — только «Бот снова ведёт диалог»
  await press(app, `c:take:${conv.id}`);
  told = tg.sentTo(OWNER).length;
  await press(app, `c:bot:${conv.id}`);
  await app.idle();
  toOwner = tg.sentTo(OWNER).slice(told).map((m) => m.params.text);
  assert.ok(toOwner.some((t) => /Бот снова ведёт диалог с <b>Иван<\/b>/.test(t)));
  assert.ok(!toOwner.some((t) => returned.test(t)));
});

// ——— пустой ответ ИИ ———

test("ИИ уверенно ничего не ответил — клиенту ни «уточню», ни пустого сообщения; мастеру карточка", async () => {
  const app = await makeApp();
  an.respond = () => final({ reply: "", confidence: 0.9, handoff: false, handoff_reason: "", hold: "" });
  await clientSays(app, 586, "ок");
  await app.idle();

  assert.deepEqual(texts(586), []);
  assert.equal(typingCalls(586), 0, "и «печатает» клиент не видел");
  const conv = lastConv(app);
  assert.equal(conv.status, "waiting");
  assert.equal(conv.handoff.hold, "");
  assert.equal(cards().length, 1);
  assert.match(cards()[0].params.text, /бот не нашёл, что ответить/);
  assert.doesNotMatch(cards()[0].params.text, /Клиенту пишу|Черновик бота/);
  assert.ok(!buttons(cards()[0]).includes(`c:send:${conv.id}`), "отправлять нечего — кнопки «Отправить черновик» нет");
  assert.equal(an.requests.length, 1);
});

test("ИИ ничего не ответил и сам не уверен — клиенту «уточню и скоро отвечу», мастеру карточка", async () => {
  const app = await makeApp();
  an.respond = () => final({ reply: "", confidence: 0.3, handoff: false, handoff_reason: "", hold: "Кажется, красим, уточню" });
  await clientSays(app, 587, "А бороду хной красите?");
  await app.idle();

  // Фразу ИИ не берём: мастера позвал сам бот, и в ней может быть догадка
  assert.deepEqual(texts(587), ["Уточню и скоро вам отвечу"]);
  const conv = lastConv(app);
  assert.equal(conv.status, "waiting");
  assert.equal(cards().length, 1);
  assert.match(cards()[0].params.text, /бот не нашёл, что ответить/);
  assert.match(cards()[0].params.text, /Клиенту пишу: «Уточню и скоро вам отвечу»/);
  assert.doesNotMatch(cards()[0].params.text, /Черновик бота|красим/);
});

test("мастер ведёт диалог, открыл настройку точки и забыл: реплай клиенту через 15 минут — дальше обычные сообщения идут клиенту", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 588, "Добрый день");
  await app.idle();
  const conv = lastConv(app);
  await press(app, `c:take:${conv.id}`);
  await press(app, "s:edit");
  clock += 16 * 60 * 1000;
  const before = an.requests.length;

  // Клиент больше не писал: мастер сам вернулся к разговору и ответил реплаем на прежнее уведомление
  await adminSays(app, "Кстати, у нас сегодня скидка 10%", "main", { reply_to_message: { message_id: lastRefTo(app, conv) } });
  await app.idle();
  assert.equal(texts(588).at(-1), "Кстати, у нас сегодня скидка 10%");
  const note = tg.sentTo(OWNER).filter((m) => /Настройка точки не закончена/.test(m.params.text)).at(-1);
  assert.match(note.params.text, /обычные сообщения теперь снова уходят клиенту <b>Иван<\/b>\. Чтобы вернуться к настройке, нажмите «Писать в настройку»\./);
  assert.deepEqual(buttons(note), ["s:focus"]);

  // Следующее обычное сообщение — клиенту, а не в «Обновляю настройки точки…»
  await adminSays(app, "Ждём вас в субботу!");
  await app.idle();
  assert.equal(texts(588).at(-1), "Ждём вас в субботу!");
  assert.equal(an.requests.length, before, "в настройку точки ничего не ушло");
  assert.ok(!tg.sentTo(OWNER).some((m) => /Обновляю настройки точки/.test(m.params.text)));
  assert.equal(app.state.admins[OWNER].mode, "await_edit", "настройка не закрыта — к ней можно вернуться");
  // Второй раз о незаконченной настройке не напоминаем: обычные сообщения уже идут клиенту
  assert.equal(tg.sentTo(OWNER).filter((m) => /Настройка точки не закончена, но/.test(m.params.text)).length, 1);

  // «Писать в настройку» возвращает к настройке, и свежую настройку реплай клиенту уже не сбивает
  await press(app, "s:focus");
  await adminSays(app, "И приходите пораньше", "main", { reply_to_message: { message_id: lastRefTo(app, conv) } });
  await app.idle();
  assert.equal(texts(588).at(-1), "И приходите пораньше");
  an.respond = () => final({ ...importedShop, changes: ["Парковка во дворе"] });
  await adminSays(app, "есть парковка во дворе");
  await app.idle();
  assert.equal(an.requests.length, before + 1, "правка ушла в настройку");
  assert.equal(texts(588).at(-1), "И приходите пораньше", "и не ушла клиенту");
});

test("мастер ведёт два диалога без настройки точки: реплай одному клиенту не переключает обычные сообщения с другого", async () => {
  const app = await makeApp();
  an.respond = () => confident("Здравствуйте!");
  await clientSays(app, 589, "Добрый день");
  await app.idle();
  const first = lastConv(app);
  await clientSays(app, 590, "Здравствуйте", { from: user(590, "Пётр", "petr") });
  await app.idle();
  const second = lastConv(app);
  await press(app, `c:take:${first.id}`);
  await press(app, `c:take:${second.id}`);
  clock += 16 * 60 * 1000;

  await adminSays(app, "Иван, ждём вас!", "main", { reply_to_message: { message_id: lastRefTo(app, first) } });
  await app.idle();
  assert.equal(texts(589).at(-1), "Иван, ждём вас!");
  assert.ok(!tg.sentTo(OWNER).some((m) => /Настройка точки не закончена/.test(m.params.text)));
  await adminSays(app, "Пётр, и вас тоже!");
  await app.idle();
  assert.equal(texts(590).at(-1), "Пётр, и вас тоже!");
  assert.equal(texts(589).at(-1), "Иван, ждём вас!");
});
