// Несколько заведений в одном боте: Platform с настоящими App, TelegramApi и Anthropic SDK против фейковых серверов.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PassThrough } = require("stream");

const { FakeTelegram, FakeAnthropic, final, tmpDir } = require("./fakes");
const { loadConfig } = require("../bot/config");
const { Store } = require("../bot/store");
const { Llm } = require("../bot/llm");
const { Platform, parseVenueData } = require("../bot/platform");
const { startControl } = require("../bot/control");
const { runCli, parseArgs } = require("../bot/cli");
const { slugify } = require("../bot/util");
const { untag, tagMarkup } = require("../bot/telegram");

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

// Данные заведения так, как их кладёт в venues/<slug>.json Claude (формат импорта с Яндекс.Карт)
const seedData = (over = {}) => ({
  ...importedShop,
  name: "Барбершоп «Бородач»",
  city: "Москва",
  address: "Тверская, 1",
  source: "https://yandex.ru/maps/org/borodach/111/",
  changes: [],
  ...over,
});

async function makePlatform({ dir = tmpDir(), env = {}, adminBot = false, keep = false } = {}) {
  if (!keep) {
    tg.reset();
    an.reset();
    clock = Date.parse("2026-11-05T10:00:00Z"); // чт 13:00 МСК
  }
  const cfg = {
    ...loadConfig({ OWNER_IDS: String(OWNER), DATA_DIR: dir, VENUES_DIR: "off", CONTROL_SOCKET: "off", ...env }),
    telegramToken: "main-token",
    adminBotToken: adminBot ? "admin-token" : "",
    telegramApiBase: tg.url,
    anthropicBaseUrl: an.url,
    anthropicApiKey: "test-key",
    debounceMs: 30,
    llmTimeoutMs: 15000,
    setupTimeoutMs: 3000,
    typing: { baseMs: 0, perCharMs: 1, minMs: 20, maxMs: 100, pauseMs: 5 },
  };
  const llm = new Llm({ apiKey: "test-key", baseURL: an.url, model: cfg.model, fallbacks: true, log: quiet });
  const p = new Platform({ cfg, llm, log: quiet, now: () => clock, fetchImpl: fakeYandexFetch });
  p.dir = dir;
  await p.init();
  return p;
}

const user = (id, first_name = "Иван") => ({ id, is_bot: false, first_name });

async function says(p, id, text, { source = "main", name, ...extra } = {}) {
  const mid = ++upd;
  await p.handleShared({ update_id: mid, message: { message_id: mid, chat: { id, type: "private" }, from: user(id, name), date: 0, text, ...extra } }, source);
  return mid;
}

async function press(p, id, data, { source = "main", message_id = 1 } = {}) {
  await p.handleShared({ update_id: ++upd, callback_query: { id: `cq${upd}`, from: user(id), data, message: { message_id, chat: { id, type: "private" } } } }, source);
}

// Всё, что бот показал человеку: новые сообщения и отредактированные экраны
const shown = (id) => tg.calls.filter((c) => ["sendMessage", "editMessageText"].includes(c.method) && String(c.params.chat_id) === String(id)).map((c) => c.params);
const lastShown = (id) => shown(id).at(-1) || { text: "" };
const texts = (id) => tg.sentTo(id).map((m) => m.params.text);
const lastTo = (id) => tg.sentTo(id).at(-1)?.params.text || "";
const buttons = (params) => params.reply_markup?.inline_keyboard?.flat() || [];
const inviteIn = (text) => text.match(/https:\/\/t\.me\/\w+\?start=adm_[\w-]+/)?.[0];
const confident = (reply) => final({ reply, confidence: 0.95, handoff: false, handoff_reason: "" });
const needsMaster = () => final({ reply: "", confidence: 0.9, handoff: true, handoff_reason: "скидки решает мастер", hold: "Уточню и скоро отвечу" });
const cardsTo = (id) => tg.sentTo(id).filter((m) => /Нужен ответ мастера/.test(m.params.text));
// Сообщение заведения мастеру о переписке — на него отвечают реплаем
const refTo = (app, adminId, conv) =>
  Number(
    Object.entries(app.state.consoleRefs)
      .filter(([k, v]) => v === conv.id && k.startsWith(`${adminId}:`))
      .at(-1)[0]
      .split(":")[1]
  );
const convOf = (app, chatId) => app.convByKey(`d:${chatId}`);

// Владелец создаёт заведение по карточке → { rec, app, done (текст «Заведение создано»), invite }
async function createByUrl(p, shop = importedShop) {
  an.respond = () => final(shop);
  await says(p, OWNER, "/new https://yandex.ru/maps/-/abc");
  await p.idle();
  const done = tg.sentTo(OWNER).filter((m) => /Заведение создано/.test(m.params.text)).at(-1);
  assert.ok(done, "владелец получил ссылки заведения");
  const rec = p.venueList().at(-1);
  return { rec, app: p.apps.get(rec.id), done: done.params, invite: inviteIn(done.params.text) };
}

async function join(p, invite, id, name = "Руслан") {
  await says(p, id, `/start ${invite.split("start=")[1]}`, { name });
  await p.idle();
}

// ---------- первый запуск после обновления ----------

test("данные прежней версии — первое заведение: файл на месте, владелец, offset и старые кнопки работают", async () => {
  const dir = tmpDir();
  // Так данные лежали до нескольких заведений: одна точка в state.json, владелец — по ссылке own_
  const old = new Store(path.join(dir, "state.json"), { log: quiet });
  old.load();
  Object.assign(old.state.shop, { name: "Барбершоп «Бородач»", city: "Москва", demo: false });
  old.state.admins[555] = { id: 555, role: "owner", name: "Олег", notify: true, mode: null };
  old.state.businessConnections.bc1 = { id: "bc1", userId: 555, userChatId: 555, rights: { can_reply: true }, enabled: true, allowed: true, name: "Олег", at: 0 };
  old.state.offsets = { main: 4242 };
  old.flush();

  const p = await makePlatform({ dir, env: { OWNER_IDS: "" } });
  const rec = p.state.venues.v1;
  assert.deepEqual([rec.legacy, rec.file, rec.slug], [true, "state.json", "borodach"]);
  assert.equal(p.state.defaultVenue, "v1");
  assert.deepEqual(p.ownerIds(), [555], "владелец прежней версии — владелец платформы");
  assert.equal(p.state.offsets.main, 4242, "общий бот продолжает с того же апдейта");
  assert.ok(fs.existsSync(path.join(dir, "platform.json")));
  assert.equal(p.apps.get("v1").shop.name, "Барбершоп «Бородач»");
  assert.ok(!p.state.ownerClaimCode, "владелец есть — ссылка «стать владельцем» не нужна");

  // Клиент без ссылки заведения попадает в первое — как раньше
  an.respond = () => confident("Здравствуйте! Чем помочь?");
  await says(p, 501, "Здравствуйте");
  await p.idle();
  assert.equal(lastTo(501), "Здравствуйте! Чем помочь?");
  assert.ok(convOf(p.apps.get("v1"), 501));

  // Ссылка с чужим параметром (реклама, старая метка) и просто /start — приветствие этой же точки, как раньше
  await says(p, 502, "/start promo");
  await says(p, 503, "/start");
  await p.idle();
  assert.match(lastTo(502), /Это Барбершоп «Бородач»/);
  assert.match(lastTo(503), /Это Барбершоп «Бородач»/);

  // Клиент пишет мастеру в личку, а отвечает бот через Telegram Business, подключённый прежней версией
  await p.handleShared({
    update_id: ++upd,
    business_message: { business_connection_id: "bc1", message_id: 7001, chat: { id: 607, type: "private", first_name: "Анна" }, from: user(607, "Анна"), date: 0, text: "Есть время завтра?" },
  });
  await p.idle();
  const biz = tg.of("sendMessage", (q) => q.business_connection_id === "bc1" && q.chat_id === 607).at(-1);
  assert.equal(biz?.params.text, "Здравствуйте! Чем помочь?");

  // Кнопка из сообщения, отправленного прежней версией (без пометки заведения), — тоже в первое заведение
  await press(p, 555, "m:panel");
  assert.match(lastShown(555).text, /Панель мастера<\/b> · Барбершоп «Бородач»/);
  // Новые кнопки помечены заведением
  assert.ok(buttons(lastShown(555)).filter((b) => b.callback_data && !b.callback_data.startsWith("P:")).every((b) => b.callback_data.startsWith("v1|")));

  // Данные по-прежнему в state.json: откат на прежнюю версию найдёт их там же
  await p.stop(1000);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(raw.shop.name, "Барбершоп «Бородач»");
  assert.ok(Object.values(raw.conversations).some((c) => c.chatId === 501));
});

test("без владельца: одна ссылка own_ на все заведения, владелец получает меню заведений", async () => {
  const p = await makePlatform({ env: { OWNER_IDS: "" } });
  const code = p.state.ownerClaimCode;
  assert.ok(code);
  await says(p, 300, "/start own_wrong");
  assert.equal(lastTo(300), "Ссылка владельца недействительна.");
  await says(p, 300, `/start own_${code}`);
  assert.match(lastTo(300), /вы владелец бота/);
  assert.deepEqual(p.ownerIds(), [300]);
  assert.equal(p.apps.get("v1").role(300), "owner");
  const menu = tg.of("setMyCommands", (q) => q.scope?.chat_id === 300).at(-1);
  assert.deepEqual(menu.params.commands.map((c) => c.command), ["panel", "chats", "bookings", "settings", "help", "venues", "new"]);
  // Ссылка одноразовая
  await says(p, 301, `/start own_${code}`);
  assert.equal(lastTo(301), "Ссылка владельца недействительна.");
});

// ---------- заведение по карточке ----------

test("владелец присылает карточку с Яндекс.Карт — заведение со своими данными и ссылками; клиент по ссылке попадает в него", async () => {
  const p = await makePlatform();
  const { rec, app, done, invite } = await createByUrl(p);
  assert.deepEqual([rec.id, rec.slug, app.shop.name], ["v2", "test", "Барбершоп Тест"]);
  assert.match(done.text, /Ссылка для клиентов<\/b> — её можно публиковать:\nhttps:\/\/t\.me\/test_bot\?start=test/);
  assert.ok(invite, "в сообщении есть одноразовая ссылка администратора");
  assert.match(done.text, /проверьте имя/, "что проверить после импорта");
  assert.ok(fs.existsSync(path.join(p.dir, "venues", "v2", "state.json")), "у заведения свой файл данных");
  assert.equal(p.apps.get("v1").shop.demo, true, "первое заведение не тронуто");

  // Клиент по ссылке: приветствие и ответы — от этого заведения
  await says(p, 501, "/start test");
  await p.idle();
  assert.match(lastTo(501), /Это Барбершоп Тест/);
  an.respond = () => confident("Мужская стрижка — 1 500 ₽");
  await says(p, 501, "Сколько стоит стрижка?");
  await p.idle();
  assert.equal(lastTo(501), "Мужская стрижка — 1 500 ₽");
  const prompt = JSON.stringify(an.requests.at(-1).body.system);
  assert.match(prompt, /Барбершоп Тест/);
  assert.doesNotMatch(prompt, /Бритва/, "в подсказке ИИ нет данных другого заведения");
  assert.ok(convOf(app, 501));
  assert.equal(convOf(p.apps.get("v1"), 501), null);

  // Не ссылка заведения — обычный /start там, где человек сейчас, а у нового человека — в основном заведении
  await says(p, 501, "/start nope");
  await says(p, 502, "/start nope");
  await p.idle();
  assert.match(lastTo(501), /Это Барбершоп Тест/);
  assert.ok(texts(502).some((t) => /Это Демо-барбершоп «Бритва»/.test(t)));
  assert.equal(p.userVenue(502), "v1");
});

test("карточка не загрузилась — владелец видит причину и может создать пустое заведение", async () => {
  const p = await makePlatform();
  an.respond = () => ({ status: 500, error: "overloaded" });
  await says(p, OWNER, "/new https://yandex.ru/maps/-/abc");
  await p.idle();
  const msg = lastShown(OWNER);
  assert.match(msg.text, /Не получилось создать заведение по карточке/);
  assert.match(msg.text, /Причина:/);
  assert.deepEqual(buttons(msg).map((b) => b.callback_data), ["P:empty", "P:new"]);
  assert.equal(p.venueList().length, 1, "заведение не создано");
});

test("/new без ссылки ждёт карточку; описание словами — пустое заведение, после сохранения у него появляются ссылки", async () => {
  const p = await makePlatform();
  await says(p, OWNER, "/new");
  assert.match(lastTo(OWNER), /Новое заведение/);
  assert.equal(p.mode(OWNER), "await_venue");
  await says(p, OWNER, "привет");
  assert.match(lastTo(OWNER), /Пришлите ссылку на карточку/, "короткое сообщение — не описание");
  // Команда — владелец занялся другим: ссылку больше не ждём
  await says(p, OWNER, "/panel");
  assert.equal(p.mode(OWNER), null);
  assert.match(lastShown(OWNER).text, /Панель мастера/);
  await says(p, OWNER, "/new");

  // Описание словами: создаётся пустое заведение, а описание сразу разбирает его настройка точки
  an.respond = () => final({ ...importedShop, changes: ["Заполнено из описания"] });
  await says(p, OWNER, "Барбершоп Тест, Казань, ул. Ленина 5, каждый день 10–20, стрижка 1500, борода 900");
  await p.idle();
  const rec = p.state.venues.v2;
  assert.ok(rec.slugPending);
  assert.equal(rec.slug, "new-2");
  const preview = lastShown(OWNER);
  assert.match(preview.text, /Проверьте, что получилось/);
  const save = buttons(preview).find((b) => /s:save$/.test(b.callback_data || ""));
  assert.equal(save.callback_data, "v2|s:save");

  await press(p, OWNER, save.callback_data);
  await p.idle();
  assert.equal(p.apps.get("v2").shop.name, "Барбершоп Тест");
  assert.equal(rec.slug, "test", "ссылка — по названию");
  assert.equal(rec.slugPending, false);
  const ready = lastTo(OWNER);
  assert.match(ready, /Заведение готово/);
  assert.ok(ready.includes("https://t.me/test_bot?start=test"));
  assert.ok(inviteIn(ready));
});

// ---------- администратор заведения ----------

test("администратор по приглашению сразу видит свою точку, уведомления о её клиентах — ему, а не владельцу", async () => {
  const p = await makePlatform();
  const { app, invite } = await createByUrl(p);
  await join(p, invite, 700);

  const welcome = lastTo(700);
  assert.match(welcome, /Данные вашей точки уже загружены/);
  assert.match(welcome, /Барбершоп Тест/);
  assert.equal(app.role(700), "admin");
  assert.equal(p.apps.get("v1").role(700), null, "в другом заведении он никто");
  assert.equal(app.state.admins[700].mode, null, "настройка не открыта: точка уже загружена");
  assert.match(lastTo(OWNER), /Руслан принял приглашение и стал мастером/);
  assert.match(lastTo(OWNER), /теперь получает он/);
  assert.equal(app.state.admins[OWNER].notify, false);
  assert.ok(tg.of("setMyCommands", (q) => q.scope?.chat_id === 700).length, "мастеру — меню панели");

  // Ссылка одноразовая
  await join(p, invite, 701, "Пётр");
  assert.match(lastTo(701), /недействительна или уже использована/);
  assert.equal(app.role(701), null);

  // Клиент заведения ждёт мастера: карточка — администратору заведения, кнопки помечены заведением
  await says(p, 501, "/start test");
  an.respond = () => needsMaster();
  await says(p, 501, "Можно скидку?");
  await p.idle();
  const card = cardsTo(700).at(-1);
  assert.ok(card, "карточка мастеру заведения");
  assert.equal(cardsTo(OWNER).length, 0, "владельцу — нет");
  assert.ok(buttons(card.params).filter((b) => b.callback_data).every((b) => b.callback_data.startsWith("v2|")));

  // Ответ реплаем уходит клиенту этого заведения
  await says(p, 700, "Для вас — 10% 🙂", { reply_to_message: { message_id: refTo(app, 700, convOf(app, 501)) } });
  await p.idle();
  assert.equal(lastTo(501), "Для вас — 10% 🙂");

  // Его панель — про его заведение
  await says(p, 700, "/panel");
  assert.match(lastShown(700).text, /Панель мастера<\/b> · Барбершоп Тест/);
});

test("отдельный бот панели (ADMIN_BOT_TOKEN): приглашение и панель — в нём, даже когда мастер пишет другому заведению как клиент", async () => {
  const p = await makePlatform({ adminBot: true });
  const { app, invite } = await createByUrl(p);
  assert.match(invite, /^https:\/\/t\.me\/test_admin_bot\?start=adm_/);
  await says(p, 700, `/start ${invite.split("start=")[1]}`, { source: "console", name: "Руслан" });
  await p.idle();
  assert.equal(app.role(700), "admin");
  assert.match(lastTo(700), /Данные вашей точки уже загружены/);

  await says(p, 700, "/start demo");
  await p.idle();
  assert.equal(p.userVenue(700), "v1", "в клиентском боте он клиент первого заведения");
  await says(p, 700, "привет", { source: "console" });
  const reply = tg.of("sendMessage", (q) => q.chat_id === 700).at(-1);
  assert.equal(reply.token, "admin-token");
  assert.match(reply.params.text, /Сейчас вы не ведёте диалог/, "бот панели ответил как панель его заведения");
  assert.equal(p.userVenue(700), "v2");
});

test("владелец не тратит ссылку администратора, если открыл её сам", async () => {
  const p = await makePlatform();
  const { app, invite } = await createByUrl(p);
  await join(p, invite, OWNER);
  assert.match(lastTo(OWNER), /перешлите её ему/);
  const code = invite.split("adm_")[1];
  assert.ok(!app.state.invites[code].usedBy);
  await join(p, invite, 700);
  assert.equal(app.role(700), "admin");
});

test("мастер пишет другому заведению как клиент, а команды панели — по-прежнему про его заведение", async () => {
  const p = await makePlatform();
  const { app, invite } = await createByUrl(p);
  await join(p, invite, 700);

  await says(p, 700, "/start demo");
  await p.idle();
  assert.ok(texts(700).some((t) => /Это Демо-барбершоп/.test(t)), "в первом заведении он клиент");
  an.respond = () => confident("Да, работаем");
  await says(p, 700, "Вы работаете сегодня?");
  await p.idle();
  assert.equal(lastTo(700), "Да, работаем");
  assert.ok(convOf(p.apps.get("v1"), 700));

  await says(p, 700, "/panel");
  assert.match(lastShown(700).text, /Панель мастера<\/b> · Барбершоп Тест/);
  assert.equal(p.userVenue(700), app.venueId);
});

test("владелец в нескольких заведениях: над уведомлением — заведение, реплай уходит туда, откуда уведомление", async () => {
  const p = await makePlatform();
  const { app } = await createByUrl(p);
  const first = p.apps.get("v1");
  an.respond = () => needsMaster();
  await says(p, 501, "/start test");
  await says(p, 501, "Можно скидку?");
  await p.idle();
  await says(p, 502, "А скидки бывают?"); // без ссылки — первое заведение
  await p.idle();

  const [c1, c2] = cardsTo(OWNER);
  assert.match(c1.params.text, /^🏪 <b>Барбершоп Тест<\/b>\n/);
  assert.match(c2.params.text, /^🏪 <b>Демо-барбершоп «Бритва»<\/b>\n/);

  // Сейчас владелец «в» первом заведении (последнее нажатие — там), а отвечает на карточку второго
  p.enter(OWNER, "v1");
  await says(p, OWNER, "Да, 10%", { reply_to_message: { message_id: refTo(app, OWNER, convOf(app, 501)) } });
  await p.idle();
  assert.equal(lastTo(501), "Да, 10%");
  assert.equal(texts(502).includes("Да, 10%"), false);
  await says(p, OWNER, "Бывают по будням", { reply_to_message: { message_id: refTo(first, OWNER, convOf(first, 502)) } });
  await p.idle();
  assert.equal(lastTo(502), "Бывают по будням");
});

// ---------- экраны владельца ----------

test("/venues: список заведений и карточка заведения с ссылками; убрать администратора", async () => {
  const p = await makePlatform();
  const { app, invite } = await createByUrl(p);
  await join(p, invite, 700);

  await says(p, OWNER, "/venues");
  const list = lastShown(OWNER);
  assert.match(list.text, /Заведения<\/b> · 2/);
  assert.match(list.text, /Барбершоп Тест<\/b> · \?start=test · админов: 1/);
  assert.match(list.text, /Демо-барбершоп «Бритва»<\/b> · основное/);
  assert.ok(buttons(list).some((b) => b.callback_data === "P:v:v2"));

  await press(p, OWNER, "P:v:v2");
  const card = lastShown(OWNER);
  assert.match(card.text, /Администраторы: Руслан/);
  assert.match(card.text, /Для клиентов: https:\/\/t\.me\/test_bot\?start=test/);

  await press(p, OWNER, "P:inv:v2");
  const fresh = inviteIn(lastTo(OWNER));
  assert.ok(fresh && fresh !== invite, "новая ссылка администратора");

  await press(p, OWNER, "P:rm:v2:700");
  assert.match(lastShown(OWNER).text, /Убрать <b>Руслан<\/b>/);
  await press(p, OWNER, "P:rm2:v2:700");
  await p.idle();
  assert.equal(app.role(700), null);
  assert.match(lastTo(700), /больше не администратор <b>Барбершоп Тест<\/b>/);
  assert.ok(tg.of("deleteMyCommands", (q) => q.scope?.chat_id === 700).length, "меню панели убрано");

  // Не владелец этих экранов не видит: /venues для него — обычное сообщение заведению
  an.respond = () => confident("Чем помочь?");
  await press(p, 700, "P:list");
  assert.equal(tg.of("answerCallbackQuery").at(-1).params.text, "Нет доступа");
});

test("удалённое заведение: клиенты узнают, что оно больше не работает, данные — в архиве", async () => {
  const p = await makePlatform();
  const { app } = await createByUrl(p);
  an.respond = () => confident("Здравствуйте!");
  await says(p, 501, "/start test");
  await says(p, 501, "Добрый день");
  await p.idle();
  const oldButton = "v2|c:open:1";

  await press(p, OWNER, "P:del:v2");
  assert.match(lastShown(OWNER).text, /Удалить Барбершоп Тест\?/);
  await press(p, OWNER, "P:del2:v2");
  await p.idle();
  assert.equal(p.state.venues.v2, undefined);
  assert.ok(!fs.existsSync(path.join(p.dir, "venues", "v2")));
  const archived = fs.readdirSync(path.join(p.dir, "venues", "_deleted"));
  assert.equal(archived.length, 1);
  assert.ok(JSON.parse(fs.readFileSync(path.join(p.dir, "venues", "_deleted", archived[0], "state.json"), "utf8")).conversations);
  assert.ok(app.store.closed, "файл удалённого заведения больше не пишется");

  await says(p, 501, "Ау?");
  assert.match(lastTo(501), /больше не работает в этом боте/);
  await press(p, 501, oldButton);
  assert.match(tg.of("answerCallbackQuery").at(-1).params.text, /больше не работает/);
  // Дальше он, как и все без ссылки, пишет основному заведению — без ответа не остаётся
  an.respond = () => confident("Здравствуйте, это «Бритва»!");
  await says(p, 501, "Ау?");
  await p.idle();
  assert.equal(lastTo(501), "Здравствуйте, это «Бритва»!");
  // Ссылка удалённого заведения ведёт в основное
  await says(p, 503, "/start test");
  await p.idle();
  assert.ok(texts(503).some((t) => /Это Демо-барбершоп «Бритва»/.test(t)));

  // Основное заведение удалить нельзя
  await press(p, OWNER, "P:del2:v1");
  assert.match(tg.of("answerCallbackQuery").at(-1).params.text, /основное заведение/);
});

// ---------- свой бот у заведения ----------

const OWN_TOKEN = `5550001:${"A".repeat(35)}`;

test("свой бот по токену: клиенты пишут в него, общий бот подсказывает новый адрес; вернуть в общий — бот в запас", async () => {
  const p = await makePlatform();
  const { rec, app, invite } = await createByUrl(p);
  await join(p, invite, 700);
  an.respond = () => confident("Здравствуйте!");
  await says(p, 501, "/start test");
  await p.idle();

  await press(p, OWNER, "P:bot:v2");
  assert.match(lastShown(OWNER).text, /Отдельный бот для Барбершоп Тест/);
  assert.ok(!buttons(lastShown(OWNER)).some((b) => b.url?.includes("/newbot/")), "Managed Bots выключены — кнопки «создать» нет");
  await press(p, OWNER, "P:tok:v2");
  const tokenMsg = await says(p, OWNER, OWN_TOKEN);
  await p.idle();
  assert.ok(tg.of("deleteMessage", (q) => q.message_id === tokenMsg).length, "сообщение с токеном удалено");
  assert.match(lastTo(OWNER), /Бот @venue5550001_bot подключён к <b>Барбершоп Тест<\/b>/);
  assert.equal(rec.bot.mode, "own");
  assert.equal(p.clientLink(rec), "https://t.me/venue5550001_bot");
  assert.ok(tg.of("setMyDescription", (q) => /Барбершоп Тест/.test(q.description)).length, "описание бота — про заведение");
  const moved = tg.sentTo(700).at(-1);
  assert.match(moved.params.text, /теперь свой бот @venue5550001_bot/, "мастеру сказали, куда переехала панель");
  assert.equal(moved.token, "main-token");
  assert.equal(buttons(moved.params)[0].url, "https://t.me/venue5550001_bot?start=panel");

  // Клиент пишет в общий бот — ему подсказывают новый адрес
  await says(p, 501, "Есть время завтра?");
  assert.match(lastTo(501), /теперь отвечает в своём боте: @venue5550001_bot/);
  // А в своём боте ему отвечает заведение — с той же перепиской
  an.respond = () => confident("Есть, в 12:00");
  await p.handleOwn("v2", { update_id: ++upd, message: { message_id: upd, chat: { id: 501, type: "private" }, from: user(501), date: 0, text: "Есть время завтра?" } });
  await p.idle();
  const reply = tg.of("sendMessage", (q) => q.chat_id === 501).at(-1);
  assert.equal(reply.params.text, "Есть, в 12:00");
  assert.equal(reply.token, OWN_TOKEN, "ответ ушёл из своего бота");
  assert.deepEqual(convOf(app, 501).messages.filter((m) => m.role === "client").map((m) => m.text), ["/start", "Есть время завтра?"]);

  // Тот же бот другому заведению не подключить
  await assert.rejects(p.attachBot("v1", OWN_TOKEN), /уже работает у заведения v2/);

  await press(p, OWNER, "P:unbot2:v2");
  await p.idle();
  assert.equal(rec.bot.mode, "shared");
  const back = tg.sentTo(700).at(-1);
  assert.match(back.params.text, /снова в общем боте @test_bot/);
  assert.equal(back.token, OWN_TOKEN, "сказал его прежний бот — там мастер сейчас");
  assert.deepEqual(p.state.pool.map((b) => b.username), ["venue5550001_bot"]);
  assert.equal(p.clientLink(rec), "https://t.me/test_bot?start=test");

  // Из запаса бот подключается другому заведению и получает его название
  await p.assignFromPool("v1");
  assert.equal(p.state.venues.v1.bot.username, "venue5550001_bot");
  assert.equal(p.state.pool.length, 0);
  assert.ok(tg.of("setMyName", (q) => q.name === "Демо-барбершоп «Бритва»").length);
});

test("свой бот переживает перезапуск; недоступный бот — заведение работает через общий", async () => {
  const dir = tmpDir();
  let p = await makePlatform({ dir });
  await createByUrl(p);
  await p.attachBot("v2", OWN_TOKEN);
  await p.stop(1000);

  p = await makePlatform({ dir, keep: true });
  assert.ok(p.ownBots.has("v2"), "свой бот снова подключён");
  assert.equal(p.apps.get("v2").me.username, "venue5550001_bot");
  await p.stop(1000);

  // Токен отозвали — заведение не пропадает, а работает через общий бот
  tg.fail = (method, params, token) => (method === "getMe" && token === OWN_TOKEN ? { code: 401, description: "Unauthorized" } : null);
  p = await makePlatform({ dir, keep: true });
  assert.ok(!p.ownBots.has("v2"));
  assert.match(p.state.venues.v2.bot.error, /401/);
  assert.equal(p.clientLink(p.state.venues.v2), "https://t.me/test_bot?start=test");
  an.respond = () => confident("Здравствуйте!");
  await says(p, 501, "/start test");
  await p.idle();
  assert.match(lastTo(501), /Это Барбершоп Тест/);
  tg.fail = null;
});

test("Managed Bots: кнопка «создать бота» с подставленными именем и адресом, созданный бот подключается к заведению сам", async () => {
  const dir = tmpDir();
  tg.reset();
  tg.canManageBots = true;
  const p = await makePlatform({ dir, keep: true });
  an.reset();
  clock = Date.parse("2026-11-05T10:00:00Z");
  const { rec } = await createByUrl(p);

  await press(p, OWNER, "P:bot:v2");
  const create = buttons(lastShown(OWNER)).find((b) => b.url?.includes("/newbot/"));
  assert.equal(create.url, `https://t.me/newbot/test_bot/test_zapis_bot?name=${encodeURIComponent("Барбершоп Тест")}`);

  // Владелец создал бота по ссылке: Telegram присылает общему боту managed_bot, токен бот берёт сам
  const token = `5550002:${"B".repeat(35)}`;
  tg.managedTokens[5550002] = token;
  tg.bots[token] = { id: 5550002, is_bot: true, first_name: "Барбершоп Тест", username: "test_zapis_bot" };
  await p.handleShared({ update_id: ++upd, managed_bot: { user: user(OWNER), bot: { id: 5550002, is_bot: true, first_name: "Барбершоп Тест", username: "test_zapis_bot" } } });
  await p.idle();
  assert.equal(rec.bot.mode, "own");
  assert.equal(rec.bot.managed, true);
  assert.equal(p.clientLink(rec), "https://t.me/test_zapis_bot");
  assert.match(lastTo(OWNER), /Бот @test_zapis_bot подключён к <b>Барбершоп Тест<\/b>/);

  // Telegram сменил токен (replaceManagedBotToken) — бот переподключается с новым
  const token2 = `5550002:${"C".repeat(35)}`;
  tg.managedTokens[5550002] = token2;
  tg.bots[token2] = tg.bots[token];
  await p.handleShared({ update_id: ++upd, managed_bot: { user: user(OWNER), bot: { id: 5550002, is_bot: true, first_name: "Барбершоп Тест", username: "test_zapis_bot" } } });
  await p.idle();
  assert.equal(rec.bot.token, token2);

  // Бот, созданный не владельцем, к заведениям не подключается
  tg.managedTokens[5550003] = `5550003:${"D".repeat(35)}`;
  await p.handleShared({ update_id: ++upd, managed_bot: { user: user(999), bot: { id: 5550003, is_bot: true, first_name: "X", username: "x_bot" } } });
  await p.idle();
  assert.equal(p.state.pool.length, 0);
  assert.ok(!p.venueList().some((v) => v.bot?.id === 5550003));
});

// ---------- заведения из папки venues/ и управление с сервера ----------

test("файлы venues/*.json: заведение создаётся при запуске один раз, ссылки приходят владельцу", async () => {
  const dir = tmpDir();
  const seeds = tmpDir();
  fs.writeFileSync(path.join(seeds, "borodach.json"), JSON.stringify(seedData()));
  fs.writeFileSync(path.join(seeds, "broken.json"), "{ не json");
  let p = await makePlatform({ dir, env: { VENUES_DIR: seeds } });
  const rec = p.venueBySlug("borodach");
  assert.ok(rec, "ссылка — по имени файла");
  assert.equal(p.apps.get(rec.id).shop.name, "Барбершоп «Бородач»");
  assert.equal(p.apps.get(rec.id).shop.yandexUrl, "https://yandex.ru/maps/org/borodach/111/");
  const note = tg.sentTo(OWNER).find((m) => /Заведение создано/.test(m.params.text));
  assert.match(note.params.text, /файл venues\/borodach\.json/);
  assert.ok(note.params.text.includes("https://t.me/test_bot?start=borodach"));
  assert.ok(inviteIn(note.params.text));
  assert.equal(p.venueList().length, 2, "сломанный файл пропущен");
  await p.stop(1000);

  // Перезапуск — второго «Бородача» нет; удалили — по тому же файлу не вернётся
  p = await makePlatform({ dir, env: { VENUES_DIR: seeds } });
  assert.equal(p.venueList().length, 2);
  await p.deleteVenue(rec.id);
  await p.stop(1000);
  p = await makePlatform({ dir, env: { VENUES_DIR: seeds } });
  assert.equal(p.venueList().length, 1);
  await p.stop(1000);
});

// Вывод команды CLI
async function cli(argv, { socket, stdin = "" } = {}) {
  const out = new PassThrough();
  const err = new PassThrough();
  let stdout = "";
  let stderr = "";
  out.on("data", (c) => (stdout += c));
  err.on("data", (c) => (stderr += c));
  const input = new PassThrough();
  input.end(stdin);
  const code = await runCli(socket ? [...argv, "--socket", socket] : argv, { env: {}, stdout: out, stderr: err, stdin: input });
  return { code, stdout, stderr };
}

test("управление с сервера: добавить заведение из файла, ссылки, администратор, удалить", async () => {
  const p = await makePlatform();
  const socket = path.join(p.dir, "control.sock");
  const server = startControl(p, socket, { log: quiet });
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  try {
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600, "сокет — только владельцу");
    const file = path.join(p.dir, "borodach.json");
    fs.writeFileSync(file, JSON.stringify(seedData({ slug: "borodach" })));

    // Проверка файла — без бота
    let r = await cli(["check", file]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Файл в порядке: Барбершоп «Бородач»/);
    assert.match(r.stdout, /\?start=borodach/);

    r = await cli(["add", file], { socket });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Заведение создано: v2 · Барбершоп «Бородач»/);
    assert.match(r.stdout, /Ссылка для клиентов: https:\/\/t\.me\/test_bot\?start=borodach/);
    const invite = inviteIn(r.stdout);
    assert.ok(invite);
    // Ссылки пришли и владельцу в Telegram — та же ссылка администратора
    assert.ok(lastTo(OWNER).includes(invite));

    r = await cli(["list", "--json"], { socket });
    const list = JSON.parse(r.stdout);
    assert.deepEqual(list.map((v) => [v.id, v.slug]), [["v1", "demo"], ["v2", "borodach"]]);

    r = await cli(["admin", "бородач", "800", "Пётр"], { socket });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(p.apps.get("v2").role(800), "admin");
    assert.match(lastTo(800), /Вас назначили мастером <b>Барбершоп «Бородач»<\/b>/);

    r = await cli(["invite", "borodach"], { socket });
    assert.ok(inviteIn(r.stdout) && inviteIn(r.stdout) !== invite);

    r = await cli(["slug", "v2", "Borodach-Msk"], { socket });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(p.state.venues.v2.slug, "borodach-msk");
    r = await cli(["slug", "v2", "venues"], { socket });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /занимает сам бот/);

    r = await cli(["show", "нет такого"], { socket });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Нет заведения «нет такого»/);

    r = await cli(["delete", "v2"], { socket });
    assert.match(r.stdout, /Повторите с --yes/);
    assert.ok(p.state.venues.v2);
    r = await cli(["delete", "v2", "--yes"], { socket });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(p.state.venues.v2, undefined);

    // Токен — со стандартного ввода, в аргументах его нет
    r = await cli(["bot", "v1", "-"], { socket, stdin: `${OWN_TOKEN}\n` });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /теперь в своём боте @venue5550001_bot/);

    r = await cli(["status"], { socket });
    assert.match(r.stdout, /Общий бот: @test_bot/);
    assert.match(r.stdout, /Managed Bots\): выключено/);
  } finally {
    server.close();
  }
  assert.ok(!fs.existsSync(socket), "сокет убран");
  const down = await cli(["list"], { socket });
  assert.equal(down.code, 1);
  assert.match(down.stderr, /Бот не запущен/);
});

test("управление с сервера: заведение по ссылке на карточку", async () => {
  const p = await makePlatform();
  const socket = path.join(p.dir, "control.sock");
  const server = startControl(p, socket, { log: quiet });
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  try {
    an.respond = () => final(importedShop);
    let r = await cli(["add", "https://yandex.ru/maps/-/abc", "--slug", "kazan-test", "--quiet"], { socket });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /https:\/\/t\.me\/test_bot\?start=kazan-test/);
    assert.match(r.stdout, /проверьте имя/);
    assert.ok(!tg.sentTo(OWNER).some((m) => /Заведение создано/.test(m.params.text)), "--quiet: владельцу не пишем");

    an.respond = () => ({ status: 500, error: "overloaded" });
    r = await cli(["add", "https://yandex.ru/maps/-/abc"], { socket });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Не получилось загрузить карточку/);
  } finally {
    server.close();
  }
});

// ---------- мелочи ----------

test("ссылки заведений: латиница из названия, без «барбершоп», одинаковые различаются", async () => {
  assert.equal(slugify("Барбершоп «Бородач»"), "borodach");
  assert.equal(slugify("Chop-Chop Barbershop"), "chop-chop");
  assert.equal(slugify("Салон красоты «Ёлка»"), "elka");
  assert.equal(slugify("Барбершоп"), "barbershop");
  assert.equal(slugify("ОченьДлинноеНазваниеЗаведенияКотороеНеВлезает"), "ochendlinnoenazvaniezave");
  const p = await makePlatform();
  await p.createVenue({ shop: parseVenueData(seedData()).shop });
  await p.createVenue({ shop: parseVenueData(seedData()).shop });
  await p.createVenue({ shop: parseVenueData(seedData({ city: "" })).shop });
  assert.deepEqual(p.venueList().map((v) => v.slug), ["demo", "borodach", "borodach-moskva", "borodach-2"]);
  assert.throws(() => p.checkSlug("new"), /занимает сам бот/);
  assert.throws(() => p.checkSlug("Плохая"), /только латиница/);
});

test("данные заведения из файла: понятные ошибки", () => {
  assert.throws(() => parseVenueData([]), /не объект/);
  assert.throws(() => parseVenueData({ services: [] }), /Нет названия/);
  assert.throws(() => parseVenueData({ name: "X", slug: "Bad Slug" }), /slug/);
  const { shop, notes } = parseVenueData({ name: "Пустой" });
  assert.equal(shop.name, "Пустой");
  assert.equal(shop.demo, false);
  assert.match(notes.join(), /нет ни одной услуги/);
});

test("пометка заведения в кнопках: дописывается один раз и снимается", () => {
  const kb = { inline_keyboard: [[{ text: "a", callback_data: "c:open:5" }, { text: "u", url: "https://x" }], [{ text: "b", callback_data: "v3|m:panel" }]] };
  const tagged = tagMarkup(kb, "v2");
  assert.deepEqual(tagged.inline_keyboard.flat().map((b) => b.callback_data), ["v2|c:open:5", undefined, "v3|m:panel"]);
  assert.deepEqual(untag("v2|c:open:5"), { venue: "v2", data: "c:open:5" });
  assert.deepEqual(untag("m:panel"), { venue: null, data: "m:panel" });
  assert.deepEqual(parseArgs(["add", "x.json", "--slug", "s", "--quiet", "--json"]), { args: ["add", "x.json"], opts: { slug: "s", quiet: true, json: true } });
});
