// Несколько заведений в одном процессе. Каждое заведение — свой App со своими данными (data/venues/<id>/state.json),
// а Platform решает, какому заведению отдать апдейт Telegram:
// - общий бот (MVP): клиент попадает в заведение по ссылке t.me/<бот>?start=<slug>, администратор — по приглашению
//   adm_<код>; кнопки помечены заведением (TaggedApi), реплай уходит туда, откуда пришло сообщение;
// - свой бот у заведения (токен от @BotFather, бот из запаса или созданный через Telegram Managed Bots):
//   всё, что пришло в этот бот, — этому заведению.
// Владельцы платформы (OWNER_IDS или по ссылке own_…) — владельцы каждого заведения: создают заведения, назначают
// администраторов, видят технические причины сбоев. Экраны владельца — в venues-ui.js, управление с сервера — control.js.
const fs = require("fs");
const path = require("path");
const { App, ADMIN_COMMANDS } = require("./app");
const { Store } = require("./store");
const { TelegramApi, TaggedApi, Poller, untag } = require("./telegram");
const { normalizeShop, emptyShop, fromLlmShop } = require("./shop");
const { importFromYandex } = require("./setup");
const { esc, plain, truncate, randomCode, slugify, sleep: realSleep } = require("./util");

const DAY = 86400000;
const OWNER_COMMANDS = [
  { command: "venues", description: "Заведения" },
  { command: "new", description: "Новое заведение по карточке" },
];
// Этими словами начинаются служебные ссылки бота — заведению такую не дать
const RESERVED_SLUGS = new Set(["venues", "new", "start", "help", "panel", "settings", "admin"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
// Сколько ждать от владельца ссылку на карточку или токен бота после нажатия кнопки
const MODE_TTL_MS = 15 * 60 * 1000;
// Команды панели: мастер пишет их, даже если сейчас он в чужом заведении как клиент
const PANEL_COMMAND_RE = /^\/(panel|menu|chats|bookings|settings|help|cancel)(@\w+)?(\s|$)/i;

function defaultPlatformState() {
  return {
    version: 1,
    venues: {}, // id -> { id, slug, file, createdAt, createdBy, legacy?, slugPending?, bot: { mode: "shared" } | { mode: "own", id, username, token, … } }
    defaultVenue: null, // куда попадает тот, кто открыл общий бот без ссылки заведения
    legacyVenue: null, // заведение из данных прежней версии: кнопки без пометки заведения — из него
    owners: [], // владельцы, получившие права по ссылке own_ (и перенесённые из прежней версии); плюс OWNER_IDS
    ownerClaimCode: null,
    users: {}, // telegram id -> { venue, admin, at, mode, modeAt } — в каком заведении человек сейчас (общий бот)
    business: {}, // id подключения Telegram Business -> заведение
    pool: [], // свободные боты: { id, username, token, managed, creatorId, addedAt }
    managedRequests: {}, // telegram id владельца -> { venue, username, at }: ждём бота, созданного по ссылке t.me/newbot
    seeded: {}, // имя файла из venues/ (без .json) -> { at, venue }: по файлу заведение создаётся один раз
    commands: {}, // "id бота:id чата" -> команды меню, которые уже стоят: после перезапуска не ставим заново
    offsets: {}, // последний update_id: main, console, b<id своего бота>
    seq: { venue: 0 },
  };
}

function normalizePlatform(state, raw) {
  state.seq = { venue: 0, ...(raw.seq || {}) };
  state.owners = [...new Set((state.owners || []).map(Number).filter(Number.isFinite))];
  for (const v of Object.values(state.venues)) v.bot ||= { mode: "shared" };
  return state;
}

// Данные заведения в формате импорта с Яндекс.Карт (LLM_SHOP_SCHEMA) плюс необязательные slug, source, timezone,
// demo_busy и notes: так их пишет Claude в venues/<slug>.json и так их принимает `node bot/cli.js add <файл>`.
// → { shop, slug, notes } или исключение с понятной причиной.
function parseVenueData(obj, { file = "" } = {}) {
  const where = file ? ` (${file})` : "";
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`Данные заведения — не объект JSON${where}`);
  if (!String(obj.name || "").trim()) throw new Error(`Нет названия заведения (name)${where}`);
  if (obj.services != null && !Array.isArray(obj.services)) throw new Error(`services — не список${where}`);
  if (obj.slug != null && !SLUG_RE.test(obj.slug)) throw new Error(`slug «${obj.slug}»: только латиница в нижнем регистре, цифры и дефис, 2–40 символов${where}`);
  const base = { ...emptyShop(), yandexUrl: String(obj.source || obj.yandexUrl || "") };
  if (obj.timezone != null) {
    const tz = String(obj.timezone).trim();
    try {
      new Intl.DateTimeFormat("ru-RU", { timeZone: tz });
    } catch {
      throw new Error(`timezone «${tz}» — не часовой пояс вида Europe/Moscow${where}`);
    }
    base.timezone = tz;
  }
  if (obj.demo_busy != null) base.demoBusy = Boolean(obj.demo_busy);
  const shop = fromLlmShop({ ...obj, services: obj.services || [], knowledge: obj.knowledge || [], hours: obj.hours || [] }, base);
  const notes = [...(Array.isArray(obj.changes) ? obj.changes : []), ...(Array.isArray(obj.notes) ? obj.notes : [])].map(String);
  if (!shop.services.length) notes.push("В данных нет ни одной услуги — записывать клиентов будет не на что");
  return { shop, slug: obj.slug || null, notes };
}

// Ссылка заведения из файла venues/<имя>.json: slug из файла или само имя файла (borodach.json → ?start=borodach).
// null — имя файла для ссылки не годится: ссылку придумаем по названию.
function seedSlug(key, seed) {
  return seed.slug || (SLUG_RE.test(key) && !RESERVED_SLUGS.has(key) ? key : null);
}

function readVenueFile(file) {
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Не удалось прочитать ${path.basename(file)}: ${e.message}`);
  }
  return parseVenueData(obj, { file: path.basename(file) });
}

class Platform {
  constructor({ cfg, llm, log = console, now = () => Date.now(), sleep, fetchImpl, makeApi }) {
    this.cfg = cfg;
    this.llm = llm;
    this.log = log;
    this.now = now;
    this.sleep = sleep;
    this.fetchImpl = fetchImpl;
    this.makeApi = makeApi || ((token) => new TelegramApi(token, { base: cfg.telegramApiBase, log }));
    this.dataDir = cfg.dataDir || path.dirname(cfg.dataFile);
    this.store = new Store(path.join(this.dataDir, "platform.json"), { log, defaults: defaultPlatformState, normalize: normalizePlatform });
    this.apps = new Map(); // id заведения -> App
    this.ownBots = new Map(); // id заведения -> { api, me, token, poller } — у заведения свой бот
    this.pollers = [];
    this.tasks = new Set();
    this.running = false;
  }

  get state() {
    return this.store.state;
  }
  save() {
    this.store.save();
  }

  // ---------- запуск и остановка ----------

  async init() {
    this.store.load();
    this.shared = this.makeApi(this.cfg.telegramToken);
    this.sharedMe = await this.shared.getMe();
    if (this.cfg.adminBotToken) {
      this.sharedConsole = this.makeApi(this.cfg.adminBotToken);
      this.sharedConsoleMe = await this.sharedConsole.getMe();
    }
    const fresh = !Object.keys(this.state.venues).length;
    if (fresh) this.addLegacyVenue();
    for (const rec of this.venueList()) {
      try {
        await this.startVenue(rec);
      } catch (e) {
        this.log.error(`Заведение ${rec.id} не запустилось:`, e);
      }
    }
    if (fresh) this.adoptLegacy();
    await this.importSeeds();
    if (!this.ownerIds().length) {
      this.state.ownerClaimCode ||= randomCode(9);
      this.log.info(`\n👑 Владельца ещё нет. Откройте ссылку, чтобы стать владельцем бота:\n   ${this.ownerLink()}\n`);
    }
    await this.syncAllCommands();
    this.store.flush(); // реестр заведений — на диск сразу: после обновления прежние данные уже в нём
  }

  // Первое заведение — данные прежней версии (одна точка в data/state.json) или демо, если их нет. Файл остаётся
  // на месте: если выкладка откатится на прежнюю версию, она найдёт свои данные там же, где оставила.
  addLegacyVenue() {
    const id = this.nextVenueId();
    this.state.venues[id] = { id, slug: null, file: this.relFile(this.cfg.dataFile), createdAt: this.now(), legacy: true, bot: { mode: "shared" } };
    this.state.defaultVenue = id;
    this.state.legacyVenue = id;
  }

  // Владельцы, ссылка «стать владельцем» и offset общего бота переезжают из прежних данных в реестр платформы
  adoptLegacy() {
    const rec = this.state.venues[this.state.legacyVenue];
    const app = rec && this.apps.get(rec.id);
    if (!app) return;
    rec.slug = this.uniqueSlug(app.shop.demo ? "demo" : app.shop.name, { city: app.shop.city, except: rec.id });
    const owners = Object.values(app.state.admins).filter((a) => a.role === "owner").map((a) => Number(a.id));
    this.state.owners = [...new Set([...this.state.owners, ...owners])];
    this.state.ownerClaimCode ||= app.state.ownerClaimCode || null;
    this.state.offsets = { ...(app.state.offsets || {}), ...this.state.offsets };
    this.log.info(`Данные прежней версии — заведение ${rec.id} «${app.shop.name || "без названия"}», ссылка для клиентов: ${this.clientLink(rec)}`);
  }

  async startVenue(rec, init = null) {
    const file = path.resolve(this.dataDir, rec.file);
    if (!init && !rec.legacy && !fs.existsSync(file)) this.log.warn(`Нет данных заведения ${rec.id} (${file}) — оно начнёт с демо-точки`);
    const store = new Store(file, { log: this.log });
    store.load();
    if (init) {
      Object.assign(store.state, init);
      store.flush();
    }
    const { api, consoleApi } = await this.transport(rec);
    const app = new App({
      cfg: this.venueCfg(rec),
      store,
      api,
      consoleApi,
      llm: this.llm,
      log: this.venueLog(rec),
      now: this.now,
      sleep: this.sleep,
      fetchImpl: this.fetchImpl,
      platform: this,
      venueId: rec.id,
    });
    this.apps.set(rec.id, app);
    await app.init();
    return app;
  }

  // Настройки — общие, кроме владельцев (живой список платформы) и ADMIN_IDS (только у прежней точки)
  venueCfg(rec) {
    const platform = this;
    return {
      ...this.cfg,
      adminIds: rec.legacy ? this.cfg.adminIds : [],
      get ownerIds() {
        return platform.ownerIds();
      },
    };
  }

  // В логе видно, из какого заведения строка
  venueLog(rec) {
    const tag = `[${rec.id}]`;
    return { info: (...a) => this.log.info(tag, ...a), warn: (...a) => this.log.warn(tag, ...a), error: (...a) => this.log.error(tag, ...a) };
  }

  // Через какой бот заведение говорит с людьми: свой (если подключён и доступен) или общий с пометкой кнопок
  async transport(rec) {
    if (rec.bot?.mode === "own") {
      try {
        const own = await this.connectOwnBot(rec);
        return { api: own.api, consoleApi: null };
      } catch (e) {
        rec.bot.error = e.message;
        this.log.error(`Свой бот заведения ${rec.id} (@${rec.bot.username || "?"}) недоступен, работаю через общий:`, e.message);
      }
    }
    return {
      api: new TaggedApi(this.shared, rec.id),
      consoleApi: this.sharedConsole ? new TaggedApi(this.sharedConsole, rec.id) : null,
    };
  }

  async connectOwnBot(rec) {
    const known = this.ownBots.get(rec.id);
    if (known && known.token === rec.bot.token) return known;
    const api = this.makeApi(rec.bot.token);
    const me = await api.getMe();
    const own = { api, me, token: rec.bot.token, poller: null };
    this.ownBots.set(rec.id, own);
    Object.assign(rec.bot, { id: me.id, username: me.username });
    delete rec.bot.error;
    this.save();
    return own;
  }

  async startPolling() {
    this.running = true;
    const offsets = this.state.offsets;
    const make = (api, key, onUpdate) =>
      new Poller(api, onUpdate, {
        log: this.log,
        getOffset: () => offsets[key] || 0,
        setOffset: (id) => ((offsets[key] = id), this.save()),
      });
    this.pollers.push(make(this.shared, "main", (u) => this.handleShared(u, "main")));
    if (this.sharedConsole) this.pollers.push(make(this.sharedConsole, "console", (u) => this.handleShared(u, "console")));
    for (const p of this.pollers) await p.start();
    for (const id of this.ownBots.keys()) await this.startOwnPoller(id);
  }

  async startOwnPoller(venueId) {
    const own = this.ownBots.get(venueId);
    if (!own || own.poller || !this.running) return;
    const key = `b${own.me.id}`;
    const offsets = this.state.offsets;
    own.poller = new Poller(own.api, (u) => this.handleOwn(venueId, u), {
      log: this.log,
      getOffset: () => offsets[key] || 0,
      setOffset: (id) => ((offsets[key] = id), this.save()),
    });
    await own.poller.start();
  }

  stopOwnBot(venueId) {
    const own = this.ownBots.get(venueId);
    own?.poller?.stop();
    this.ownBots.delete(venueId);
  }

  async stop(maxMs = 7000) {
    this.running = false;
    for (const p of this.pollers) p.stop();
    for (const own of this.ownBots.values()) own.poller?.stop();
    await Promise.all([...this.apps.values()].map((a) => a.idle(maxMs))).catch(() => this.log.warn("Не все ответы успели уйти — отвечу после перезапуска."));
    this.flush();
  }

  flush() {
    this.store.flush();
    for (const a of this.apps.values()) a.store.flush();
  }

  checkReminders() {
    for (const app of this.apps.values()) app.run(() => app.checkReminders());
  }

  // Фоновые задачи платформы (создание заведения по карточке идёт до минуты — апдейты не ждут)
  run(fn) {
    const p = Promise.resolve()
      .then(fn)
      .catch((e) => this.log.error("Ошибка задачи платформы:", e));
    this.tasks.add(p);
    p.finally(() => this.tasks.delete(p));
    return p;
  }

  async idle(maxMs = 20000) {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      const apps = [...this.apps.values()];
      if (!this.tasks.size && apps.every((a) => a.quiet())) return;
      await Promise.race([...this.tasks, ...apps.flatMap((a) => [...a.tasks]), realSleep(10)]);
    }
    throw new Error("idle timeout");
  }

  // ---------- заведения ----------

  venueList() {
    return Object.values(this.state.venues).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  venueName(id) {
    return this.apps.get(id)?.shop.name || "Заведение без названия";
  }

  nextVenueId() {
    let id;
    do id = `v${++this.state.seq.venue}`;
    while (this.state.venues[id]);
    return id;
  }

  relFile(file) {
    const rel = path.relative(this.dataDir, file);
    return rel.startsWith("..") || path.isAbsolute(rel) ? path.resolve(file) : rel;
  }

  // Заведение по id (v2), ссылке (borodach) или названию (целиком или части, если она подходит одному заведению) —
  // для команд с сервера. Не нашлось или подходит нескольким — null.
  findVenue(ref) {
    const s = String(ref || "").trim().toLowerCase();
    if (!s) return null;
    const list = this.venueList();
    const name = (v) => this.venueName(v.id).toLowerCase();
    const exact = list.find((v) => v.id === s) || list.find((v) => v.slug === s) || list.find((v) => name(v) === s);
    if (exact) return exact;
    const partial = list.filter((v) => name(v).includes(s));
    return partial.length === 1 ? partial[0] : null;
  }

  venueBySlug(slug) {
    return this.venueList().find((v) => v.slug === slug) || null;
  }

  uniqueSlug(name, { city = "", except = null } = {}) {
    const base = slugify(name) || "venue";
    const taken = (s) => RESERVED_SLUGS.has(s) || this.venueList().some((v) => v.slug === s && v.id !== except);
    const c = slugify(city, { max: 16, keepGeneric: true });
    for (const s of [base, c && `${base}-${c}`]) if (s && !taken(s)) return s;
    for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
  }

  checkSlug(slug, { except = null } = {}) {
    if (!SLUG_RE.test(slug || "")) throw new Error(`Ссылка «${slug}»: только латиница в нижнем регистре, цифры и дефис, 2–40 символов`);
    if (RESERVED_SLUGS.has(slug)) throw new Error(`Ссылку «${slug}» занимает сам бот`);
    const other = this.venueList().find((v) => v.slug === slug && v.id !== except);
    if (other) throw new Error(`Ссылка «${slug}» уже у заведения ${other.id} «${this.venueName(other.id)}»`);
    return slug;
  }

  // Новая ссылка заведения для клиентов. Прежняя ссылка перестаёт вести в заведение (её может занять другое).
  setSlug(id, slug) {
    const rec = this.state.venues[id];
    if (!rec) throw new Error("Нет такого заведения");
    rec.slug = this.checkSlug(String(slug || "").trim().toLowerCase(), { except: id });
    rec.slugPending = false;
    this.save();
    return rec;
  }

  // Новое заведение со своими данными. shop — данные точки (как после normalizeShop или импорта); без названия —
  // временная ссылка new-<n>, настоящая появится, когда точку сохранят с названием (onShopSaved).
  async createVenue({ shop = emptyShop(), slug = null, by = null } = {}) {
    if (slug) this.checkSlug(slug);
    const id = this.nextVenueId();
    const named = Boolean(shop?.name);
    const rec = {
      id,
      slug: slug || (named ? this.uniqueSlug(shop.name, { city: shop.city }) : `new-${id.slice(1)}`),
      slugPending: !slug && !named,
      file: path.join("venues", id, "state.json"),
      createdAt: this.now(),
      createdBy: by,
      bot: { mode: "shared" },
    };
    this.state.venues[id] = rec;
    this.save();
    const app = await this.startVenue(rec, { shop: normalizeShop({ ...shop, demo: false, updatedAt: this.now() }) });
    this.log.info(`Новое заведение ${id} «${app.shop.name || "без названия"}», ссылка для клиентов: ${this.clientLink(rec)}`);
    return { rec, app };
  }

  // Заведение по карточке с Яндекс.Карт: та же загрузка и разбор, что в «Настройках точки»
  async importVenue({ url, by = null, slug = null }) {
    if (slug) this.checkSlug(slug);
    const r = await importFromYandex({ llm: this.llm, cfg: this.cfg, url, prevShop: null, fetchImpl: this.fetchImpl, log: this.log });
    if (!r.ok) return r;
    const { rec, app } = await this.createVenue({ shop: r.shop, slug, by });
    return { ok: true, rec, app, changes: r.changes || [], via: r.via };
  }

  // Заведения из папки venues/ репозитория: их готовит Claude по карточке (см. CLAUDE.md), и они приезжают
  // с выкладкой. Каждое создаётся один раз — удалённое заведение по тому же файлу заново не появится.
  async importSeeds() {
    const dir = this.cfg.venuesDir;
    if (!dir || !fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const key = path.basename(f, ".json");
      if (this.state.seeded[key]) continue;
      try {
        const seed = readVenueFile(path.join(dir, f));
        let slug = seedSlug(key, seed);
        // Ссылку по имени файла заняло другое заведение — придумаем по названию (slug, указанный в файле, — только он)
        if (slug && !seed.slug && this.venueBySlug(slug)) slug = null;
        const { rec, app } = await this.createVenue({ shop: seed.shop, slug, by: "seed" });
        this.state.seeded[key] = { at: this.now(), venue: rec.id };
        this.save();
        await this.announceVenue(rec, app, { notes: seed.notes, via: `файл venues/${f}` });
      } catch (e) {
        this.log.error(`Заведение из venues/${f} не создано:`, e.message);
      }
    }
  }

  async deleteVenue(id) {
    const rec = this.state.venues[id];
    if (!rec) throw new Error("Нет такого заведения");
    if (id === this.state.defaultVenue) throw new Error("Это основное заведение — сначала сделайте основным другое");
    const app = this.apps.get(id);
    if (app) {
      await app.idle(5000).catch(() => {});
      app.stop();
    }
    this.apps.delete(id);
    if (rec.bot?.mode === "own") this.toPool(rec.bot, { from: id });
    this.stopOwnBot(id);
    delete this.state.venues[id];
    for (const [conn, v] of Object.entries(this.state.business)) if (v === id) delete this.state.business[conn];
    // Данные не стираем: папка заведения переезжает в venues/_deleted, оттуда её можно вернуть вручную
    if (!rec.legacy) {
      const dir = path.dirname(path.resolve(this.dataDir, rec.file));
      const to = path.join(this.dataDir, "venues", "_deleted", `${id}-${this.now()}`);
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (fs.existsSync(dir)) fs.renameSync(dir, to);
      } catch (e) {
        this.log.warn(`Данные заведения ${id} остались в ${dir}:`, e.message);
      }
    }
    this.save();
    this.log.info(`Заведение ${id} удалено`);
  }

  setDefault(id) {
    if (!this.state.venues[id]) throw new Error("Нет такого заведения");
    this.state.defaultVenue = id;
    this.save();
  }

  // Ссылка для клиентов: у своего бота — сам бот, у общего — бот с адресом заведения
  clientLink(rec) {
    if (rec.bot?.mode === "own" && this.ownBots.has(rec.id)) return `https://t.me/${rec.bot.username}`;
    return `https://t.me/${this.sharedMe.username}?start=${rec.slug}`;
  }

  // Новая одноразовая ссылка администратора заведения (на 7 дней)
  adminInvite(id, by = null) {
    const app = this.apps.get(id);
    if (!app) throw new Error("Нет такого заведения");
    return app.inviteLink(by);
  }

  // У заведения появилось название (его создали пустым и описали словами) — даём ему настоящую ссылку.
  // true — ссылка появилась только что: тому, кто сохранил, её стоит прислать (sendVenueLinks).
  onShopSaved(app) {
    const rec = this.state.venues[app.venueId];
    if (!rec?.slugPending || !app.shop.name) return false;
    rec.slug = this.uniqueSlug(app.shop.name, { city: app.shop.city, except: rec.id });
    rec.slugPending = false;
    this.save();
    this.log.info(`Заведение ${rec.id} «${app.shop.name}» получило ссылку для клиентов: ${this.clientLink(rec)}`);
    return true;
  }

  // Ссылки заведения тому, кто его настроил: владельцу — для клиентов и одноразовая для администратора,
  // мастеру — для клиентов
  async sendVenueLinks(app, uid) {
    const rec = this.state.venues[app.venueId];
    if (!rec) return;
    if (this.isOwner(uid)) {
      const invite = this.adminInvite(rec.id, uid);
      return this.sendHtml(this.uiApi("console"), uid, this.createdText(rec, app, { invite, title: "Заведение готово" }), this.createdKeyboard(rec));
    }
    return app.sendHtml(uid, `🔗 <b>Ссылка для клиентов</b> — её можно публиковать:\n${esc(this.clientLink(rec))}`);
  }

  // Сводка заведения для CLI и списков
  describe(rec) {
    const app = this.apps.get(rec.id);
    const admins = app
      ? Object.values(app.state.admins)
          .filter((a) => app.role(a.id) === "admin")
          .map((a) => ({ id: Number(a.id), name: a.name || "", username: a.username || "" }))
      : [];
    return {
      id: rec.id,
      slug: rec.slug,
      name: this.venueName(rec.id),
      default: rec.id === this.state.defaultVenue,
      bot: rec.bot?.mode === "own" ? { mode: "own", username: rec.bot.username, connected: this.ownBots.has(rec.id) } : { mode: "shared", username: this.sharedMe.username },
      clientLink: this.clientLink(rec),
      admins,
      services: app?.shop.services.length || 0,
      conversations: app ? Object.keys(app.state.conversations).length : 0,
      bookings: app ? app.state.bookings.filter((b) => b.status === "active").length : 0,
      createdAt: rec.createdAt,
    };
  }

  // ---------- владельцы и администраторы ----------

  ownerIds() {
    return [...new Set([...this.cfg.ownerIds, ...this.state.owners].map(Number))];
  }

  isOwner(uid) {
    return uid != null && this.ownerIds().includes(Number(uid));
  }

  // Одноразовая ссылка «стать владельцем»; new — новая (прежняя перестаёт работать), например чтобы добавить второго
  ownerLink({ fresh = false } = {}) {
    if (fresh || !this.state.ownerClaimCode) {
      this.state.ownerClaimCode = randomCode(9);
      this.save();
    }
    return `https://t.me/${this.uiMe().username}?start=own_${this.state.ownerClaimCode}`;
  }

  async claimOwner(user, code, api) {
    if (!this.state.ownerClaimCode || code !== this.state.ownerClaimCode) return api.sendMessage(user.id, "Ссылка владельца недействительна.");
    this.state.ownerClaimCode = null;
    this.state.owners = [...new Set([...this.state.owners, Number(user.id)])];
    for (const app of this.apps.values()) app.ensureAdmin(user, "owner");
    this.save();
    await this.syncAllCommands();
    return this.sendHtml(
      api,
      user.id,
      "👑 Готово, вы владелец бота.\n\nЗдесь можно создавать заведения: пришлите <code>/new</code> и ссылку на карточку в Яндекс.Картах — бот загрузит данные и даст ссылки для клиентов и администратора.",
      [[this.btn("➕ Новое заведение", "new")], [this.btn("🏪 Заведения", "list")]]
    );
  }

  // Заведения общего бота, где человек — мастер (не владелец платформы)
  adminVenues(uid) {
    return this.sharedApps().filter((a) => a.state.admins[uid] && a.role(uid) === "admin");
  }

  async addAdmin(id, userId, { name = "" } = {}) {
    const app = this.apps.get(id);
    if (!app) throw new Error("Нет такого заведения");
    if (!Number.isFinite(Number(userId))) throw new Error("Нужен числовой Telegram ID");
    app.ensureAdmin({ id: Number(userId), ...(name ? { first_name: name } : {}) }, "admin");
    await app.setCommands();
    if (this.isShared(app)) this.enter(Number(userId), id);
    // Написать ему бот сможет, только если человек уже открывал этого бота
    const told = await app
      .sendHtml(Number(userId), `👤 Вас назначили мастером <b>${esc(app.shop.name || "точки")}</b>. Откройте /panel — там переписки с клиентами, записи и настройки точки.`)
      .then(() => true)
      .catch(() => false);
    return { told };
  }

  async removeAdmin(id, userId) {
    const app = this.apps.get(id);
    if (!app) throw new Error("Нет такого заведения");
    const ok = await app.removeAdmin(Number(userId));
    if (!ok) throw new Error("Такого мастера в заведении нет (владельца и ADMIN_IDS убрать нельзя)");
    // Больше нигде в этом боте не мастер — команды панели из меню убираем
    const bot = this.panelBot(app);
    const still = [...this.apps.values()].some((a) => a !== app && a.state.admins[userId] && this.panelBot(a) === bot);
    if (!still) {
      const botId = (app.separateConsole ? app.consoleMe : app.me)?.id;
      delete this.state.commands[`${botId}:${userId}`];
      this.save();
      await bot.call("deleteMyCommands", { scope: { type: "chat", chat_id: Number(userId) } }).catch(() => {});
    }
    return true;
  }

  // Мастер принял приглашение в заведение, созданное на платформе: владельцу больше не нужны уведомления о его
  // клиентах — их получает мастер. Технические сообщения (сбои импорта) владелец получает по-прежнему.
  // Возвращает приписку к сообщению владельцу «принял приглашение».
  onAdminJoined(app, user) {
    const rec = this.state.venues[app.venueId];
    if (!rec || rec.legacy) return ""; // прежняя точка: как раньше, уведомления не трогаем
    if (this.isShared(app)) this.enter(user.id, app.venueId);
    let muted = false;
    for (const a of Object.values(app.state.admins)) {
      if (!this.isOwner(a.id) || Number(a.id) === Number(user.id) || a.notify === false) continue;
      a.notify = false;
      muted = true;
    }
    app.save();
    return muted
      ? "\n\nУведомления о клиентах этого заведения теперь получает он, вам они больше не приходят. Включить снова — кнопка «Уведомления» в панели заведения."
      : "";
  }

  // ---------- общий бот: кто в каком заведении ----------

  isShared(app) {
    return app?.api instanceof TaggedApi;
  }

  sharedApps() {
    return [...this.apps.values()].filter((a) => this.isShared(a));
  }

  uiApi(source = "main") {
    return source === "console" && this.sharedConsole ? this.sharedConsole : this.shared;
  }

  uiMe() {
    return this.sharedConsoleMe || this.sharedMe;
  }

  // Заведение, в котором человек сейчас (последняя ссылка заведения, приглашение или нажатая кнопка),
  // иначе основное. null — заведения нет (удалили или основного нет).
  userVenue(uid) {
    const u = this.state.users[uid];
    if (u?.venue) return this.state.venues[u.venue] ? u.venue : null;
    return this.state.venues[this.state.defaultVenue] ? this.state.defaultVenue : null;
  }

  // Человек перешёл в заведение: дальше его обычные сообщения — туда. Начатое у владельца (ждём ссылку на карточку
  // или токен бота) отменяется: он занялся другим.
  enter(uid, venueId, { keepMode = false } = {}) {
    if (uid == null) return;
    const u = (this.state.users[uid] ||= {});
    u.venue = venueId;
    u.at = this.now();
    if (this.apps.get(venueId)?.state.admins[uid]) u.admin = venueId;
    if (!keepMode) u.mode = null;
    this.save();
  }

  setMode(uid, mode) {
    const u = (this.state.users[uid] ||= {});
    u.mode = mode;
    u.modeAt = this.now();
    this.save();
  }

  mode(uid) {
    const u = this.state.users[uid];
    if (!u?.mode || this.now() - (u.modeAt || 0) > MODE_TTL_MS) return null;
    return u.mode;
  }

  // Чьё это сообщение в чате с человеком: уведомление заведения мастеру (consoleRefs) или переписка заведения с ним
  venueOfMessage(uid, mid) {
    if (!mid) return null;
    const apps = this.sharedApps();
    return (
      apps.find((a) => a.state.consoleRefs[`${uid}:${mid}`]) ||
      apps.find((a) => {
        const c = a.convByKey(`d:${uid}`);
        return c && (c.sentMids?.includes(mid) || c.messages.some((m) => m.mid === mid));
      }) ||
      null
    );
  }

  // Заведение переехало в свой бот — в общем боте его клиентам говорим, куда писать
  movedTo(rec) {
    return rec?.bot?.mode === "own" && this.ownBots.has(rec.id) ? rec.bot.username : null;
  }

  async sayMoved(uid, rec, api) {
    const username = this.movedTo(rec);
    return api.sendMessage(uid, `${this.venueName(rec.id)} теперь отвечает в своём боте: @${username}`, {
      reply_markup: { inline_keyboard: [[{ text: `Открыть @${username}`, url: `https://t.me/${username}` }]] },
    });
  }

  async noVenue(uid, api, gone) {
    if (gone) delete this.state.users[uid].venue;
    this.save();
    return api.sendMessage(
      uid,
      gone
        ? "Заведение, с которым вы переписывались, больше не работает в этом боте. Чтобы написать другому заведению, откройте его ссылку."
        : "Здравствуйте! Это онлайн-администратор заведений. Чтобы записаться или задать вопрос, откройте ссылку своего заведения."
    );
  }

  // ---------- маршрутизация апдейтов ----------

  // Апдейт общего бота (source: "main" — клиентский бот, "console" — отдельный бот панели, ADMIN_BOT_TOKEN)
  async handleShared(u, source = "main") {
    if (u.managed_bot) return this.onManagedBot(u.managed_bot);
    if (u.callback_query) return this.routeCallback(u, source);
    if (u.message) return this.routeMessage(u, source);
    if (u.message_reaction) return this.routeReaction(u, source);
    if (u.business_connection) return this.routeBusinessConnection(u, source);
    if (u.business_message) return this.routeBusinessMessage(u, source);
  }

  // Апдейт своего бота заведения: всё — этому заведению
  async handleOwn(venueId, u) {
    const app = this.apps.get(venueId);
    if (!app) return;
    const msg = u.message;
    if (msg?.managed_bot_created) return;
    if (msg && this.isOwner(msg.from?.id) && /^\/(venues|new)(@\w+)?(\s|$)/i.test(msg.text || "")) {
      return app.api.sendMessage(msg.from.id, `Заведения настраиваются в общем боте @${this.sharedMe.username}.`, {
        reply_markup: { inline_keyboard: [[{ text: "🏪 Заведения", url: `https://t.me/${this.sharedMe.username}?start=venues` }]] },
      });
    }
    return app.handleUpdate(u, "main");
  }

  async routeCallback(u, source) {
    const cq = u.callback_query;
    const { venue, data } = untag(cq.data);
    if (data.startsWith("P:")) return this.onOwnerCallback(cq, data.slice(2), source);
    // Кнопка без пометки — из сообщения, отправленного до того, как заведений стало несколько
    const id = venue || this.state.legacyVenue;
    const app = this.apps.get(id);
    if (!app || !this.isShared(app)) {
      const moved = this.movedTo(this.state.venues[id]);
      const text = moved ? `Это заведение теперь в своём боте: @${moved}` : "Это заведение больше не работает в этом боте";
      return this.uiApi(source).call("answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: true }).catch(() => {});
    }
    this.enter(cq.from.id, id);
    return app.handleUpdate({ ...u, callback_query: { ...cq, data } }, source);
  }

  async routeMessage(u, source) {
    const msg = u.message;
    if (msg.chat?.type !== "private" || !msg.from || msg.from.is_bot) return;
    if (msg.managed_bot_created) return; // сервисное сообщение: самого бота подключит апдейт managed_bot
    const uid = msg.from.id;
    const api = this.uiApi(source);
    const text = msg.text || "";
    const payload = (text.match(/^\/start(?:@\w+)?\s+(\S+)/) || [])[1];
    if (payload) return this.routeStart(u, payload, source);
    if (this.isOwner(uid) && (await this.onOwnerCommand(msg, source))) return;

    // Реплай — ответ тому, о ком сообщение, в его заведении. Дальше обычные сообщения идут туда же, если только
    // человек не занят настройкой другого заведения прямо сейчас (как keepSetup в App.takeover).
    const replied = msg.reply_to_message ? this.venueOfMessage(uid, msg.reply_to_message.message_id) : null;
    if (replied) {
      const cur = this.apps.get(this.userVenue(uid));
      if (!(cur && cur !== replied && cur.setupFresh(cur.state.admins[uid]))) this.enter(uid, replied.venueId);
      return replied.handleUpdate(u, source);
    }
    if (this.isOwner(uid) && (await this.onOwnerInput(msg, source, u))) return;

    let id = this.userVenue(uid);
    let app = id ? this.apps.get(id) : null;
    // В боте панели (ADMIN_BOT_TOKEN) и по командам панели — заведение, где человек мастер, даже если сейчас
    // он пишет другому заведению как клиент
    if ((source === "console" || PANEL_COMMAND_RE.test(text)) && !app?.role(uid)) {
      const mine = this.panelVenue(uid);
      if (mine) {
        this.enter(uid, mine.venueId);
        [id, app] = [mine.venueId, mine];
      }
    }
    const rec = id && this.state.venues[id];
    if (!rec || !app) return this.noVenue(uid, api, Boolean(this.state.users[uid]?.venue));
    if (this.movedTo(rec)) return this.sayMoved(uid, rec, api);
    return app.handleUpdate(u, source);
  }

  // Заведение общего бота, где человек мастер: последнее, куда он заходил мастером, иначе первое
  panelVenue(uid) {
    const last = this.apps.get(this.state.users[uid]?.admin);
    if (last && this.isShared(last) && last.role(uid)) return last;
    return this.sharedApps().find((a) => a.state.admins[uid] && a.role(uid)) || null;
  }

  async routeStart(u, payload, source) {
    const msg = u.message;
    const uid = msg.from.id;
    const api = this.uiApi(source);
    if (payload.startsWith("own_")) return this.claimOwner(msg.from, payload.slice(4), api);
    if (payload === "venues" && this.isOwner(uid)) return this.showVenues(uid, api);
    if (payload.startsWith("adm_")) {
      const code = payload.slice(4);
      const app = this.sharedApps().find((a) => a.state.invites[code]);
      if (!app) return api.sendMessage(uid, "Ссылка-приглашение недействительна или уже использована. Попросите у владельца новую.");
      if (this.isOwner(uid)) {
        // Владелец открыл ссылку сам — не тратим её: она для администратора заведения
        return api.sendMessage(uid, `Это ссылка для администратора «${this.venueName(app.venueId)}» — перешлите её ему. Вы и так владелец этого заведения.`);
      }
      this.enter(uid, app.venueId);
      return app.handleUpdate(u, source);
    }
    if (payload.startsWith("bizChat")) {
      const chatId = payload.slice(7);
      const app =
        this.sharedApps().find((a) => a.role(uid) && Object.values(a.state.conversations).some((c) => c.kind === "business" && String(c.chatId) === chatId)) ||
        this.apps.get(this.userVenue(uid));
      return app?.handleUpdate(u, source);
    }
    const rec = this.venueBySlug(payload);
    if (!rec) return api.sendMessage(uid, "Не нашёл заведение по этой ссылке. Возможно, она устарела — попросите у заведения новую.");
    if (this.movedTo(rec)) return this.sayMoved(uid, rec, api);
    this.enter(uid, rec.id);
    // Заведение видит обычный /start: клиенту — приветствие точки, мастеру — его панель
    return this.apps.get(rec.id).handleUpdate({ ...u, message: { ...msg, text: "/start" } }, source);
  }

  async routeReaction(u, source) {
    const r = u.message_reaction;
    if (!r.user) return;
    const app = this.venueOfMessage(r.user.id, r.message_id) || this.apps.get(this.userVenue(r.user.id));
    if (app && this.isShared(app)) return app.handleUpdate(u, source);
  }

  // Мастер подключил общий бот к своему Telegram (Business): подключение — к заведению, где он мастер
  async routeBusinessConnection(u, source) {
    const bc = u.business_connection;
    const uid = bc.user?.id;
    const cur = this.apps.get(this.userVenue(uid));
    const app =
      (cur && this.isShared(cur) && cur.role(uid) ? cur : null) ||
      this.adminVenues(uid)[0] ||
      this.apps.get(this.state.defaultVenue) ||
      this.sharedApps()[0];
    if (!app) return;
    this.state.business[bc.id] = app.venueId;
    this.save();
    return app.handleUpdate(u, source);
  }

  async routeBusinessMessage(u, source) {
    const msg = u.business_message;
    const id = this.state.business[msg.business_connection_id] || this.sharedApps().find((a) => a.state.businessConnections[msg.business_connection_id])?.venueId;
    const app = this.apps.get(id);
    if (app && this.isShared(app)) return app.handleUpdate(u, source);
  }

  // ---------- меню команд ----------

  // Бот, в котором у мастеров заведения панель (TelegramApi без пометки заведения)
  panelBot(app) {
    const api = app.separateConsole ? app.consoleApi : app.api;
    return api instanceof TaggedApi ? api.base : api;
  }

  // У мастера одно меню на все его заведения в этом боте; владельцу — ещё «Заведения» и «Новое заведение»
  async syncCommands(app) {
    const shared = this.isShared(app);
    const api = this.panelBot(app);
    const botId = (app.separateConsole ? app.consoleMe : app.me)?.id;
    // Отдельный бот панели — только для мастеров: меню у всех одно
    if (app.separateConsole) await this.setCommandsOnce(api, `${botId}:*`, { commands: ADMIN_COMMANDS });
    for (const a of Object.values(app.state.admins)) {
      const owner = shared && this.isOwner(a.id);
      if (app.separateConsole && !owner) continue;
      const commands = [...ADMIN_COMMANDS, ...(owner ? OWNER_COMMANDS : [])];
      await this.setCommandsOnce(api, `${botId}:${a.id}`, { commands, scope: { type: "chat", chat_id: Number(a.id) } });
    }
  }

  async setCommandsOnce(api, key, params) {
    const json = JSON.stringify(params.commands);
    if (this.state.commands[key] === json) return;
    try {
      await api.call("setMyCommands", params);
      this.state.commands[key] = json;
      this.save();
    } catch (e) {
      // Человек ещё не открывал бота — меню поставим, когда он станет мастером снова или бот перезапустится
      this.log.warn("setMyCommands:", e.message);
    }
  }

  async syncAllCommands() {
    for (const app of this.apps.values()) await this.syncCommands(app);
  }

  // ---------- подписи и кнопки в заведениях ----------

  // Мастер (обычно владелец) в нескольких заведениях общего бота: над уведомлением — из какого оно заведения
  adminLabel(app, adminId) {
    if (!this.isShared(app)) return "";
    let n = 0;
    for (const other of this.sharedApps()) if (other.state.admins[adminId]) n++;
    return n > 1 ? `🏪 <b>${esc(app.shop.name || "Заведение")}</b>\n` : "";
  }

  // Строки под панелью мастера: владельцу — к списку заведений
  panelRows(app, adminId) {
    if (!this.isOwner(adminId)) return [];
    if (this.isShared(app)) return [[{ text: "🏪 Заведения", callback_data: "P:list" }]];
    return [[{ text: "🏪 Заведения", url: `https://t.me/${this.sharedMe.username}?start=venues` }]];
  }

  // ---------- свой бот у заведения, запас ботов, Telegram Managed Bots ----------

  // Подключить заведению отдельного бота по токену. rename — бот из запаса: дать ему название заведения.
  async attachBot(venueId, token, { managed = false, creatorId = null, rename = false } = {}) {
    const rec = this.state.venues[venueId];
    const app = this.apps.get(venueId);
    if (!rec || !app) throw new Error("Нет такого заведения");
    token = String(token || "").trim();
    if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error("Это не похоже на токен бота (вида 123456:ABC…)");
    if (token === this.cfg.telegramToken || token === this.cfg.adminBotToken) throw new Error("Это токен общего бота");
    const api = this.makeApi(token);
    let me;
    try {
      me = await api.getMe();
    } catch (e) {
      throw new Error(`Telegram не принял токен: ${e.message}`);
    }
    const other = this.venueList().find((v) => v.id !== venueId && v.bot?.mode === "own" && Number(v.bot.id) === Number(me.id));
    if (other) throw new Error(`@${me.username} уже работает у заведения ${other.id} «${this.venueName(other.id)}»`);
    const same = rec.bot?.mode === "own" && Number(rec.bot.id) === Number(me.id); // тот же бот с новым токеном
    const prevPanel = this.panelBot(app);
    if (rec.bot?.mode === "own" && !same) this.toPool(rec.bot, { from: venueId });
    this.stopOwnBot(venueId);
    this.state.pool = this.state.pool.filter((b) => Number(b.id) !== Number(me.id));
    rec.bot = { mode: "own", id: me.id, username: me.username, token, managed, creatorId, attachedAt: this.now() };
    this.save();
    // То, что копилось у бота, пока он был ничей или у другого заведения, — не этому заведению
    await api.call("deleteWebhook", { drop_pending_updates: true }).catch(() => {});
    this.ownBots.set(venueId, { api, me, token, poller: null });
    Object.assign(app, { api, consoleApi: api, separateConsole: false, me, consoleMe: me });
    await this.describeBot(app, api, { rename });
    await app.setCommands();
    await this.startOwnPoller(venueId);
    if (!same) {
      this.log.info(`Заведение ${venueId} теперь в своём боте @${me.username}`);
      await this.tellAdminsMoved(app, prevPanel, `🤖 У <b>${esc(app.shop.name || "точки")}</b> теперь свой бот @${esc(me.username)}: клиенты пишут в него, и панель мастера теперь тоже там. Откройте бота и нажмите «Старт».`, `https://t.me/${me.username}?start=panel`);
    }
    return rec;
  }

  // Мастерам заведения — куда переехали клиенты и панель (via — бот, которым они пользовались до сих пор)
  async tellAdminsMoved(app, via, text, url) {
    for (const a of Object.values(app.state.admins)) {
      if (app.role(a.id) !== "admin") continue;
      await this.sendHtml(via, a.id, text, [[{ text: "Открыть", url }]]).catch((e) => this.log.warn(`Мастеру ${a.id}:`, e.message));
    }
  }

  // Вернуть заведение в общий бот; его бот уходит в запас
  async detachBot(venueId) {
    const rec = this.state.venues[venueId];
    const app = this.apps.get(venueId);
    if (!rec || !app) throw new Error("Нет такого заведения");
    if (rec.bot?.mode !== "own") return rec;
    const prevPanel = this.panelBot(app);
    this.toPool(rec.bot, { from: venueId });
    this.stopOwnBot(venueId);
    rec.bot = { mode: "shared" };
    const t = await this.transport(rec);
    Object.assign(app, {
      api: t.api,
      consoleApi: t.consoleApi || t.api,
      separateConsole: Boolean(t.consoleApi),
      me: this.sharedMe,
      consoleMe: t.consoleApi ? this.sharedConsoleMe : this.sharedMe,
    });
    await app.setCommands();
    this.save();
    const panel = this.uiMe().username;
    await this.tellAdminsMoved(app, prevPanel, `🤖 <b>${esc(app.shop.name || "Точка")}</b> снова в общем боте @${esc(this.sharedMe.username)}: клиенты пишут туда, панель мастера — в @${esc(panel)}.`, `https://t.me/${panel}?start=${rec.slug}`);
    return rec;
  }

  toPool(bot, { from = null } = {}) {
    if (!bot?.token) return;
    this.state.pool = this.state.pool.filter((b) => Number(b.id) !== Number(bot.id));
    this.state.pool.push({ id: bot.id, username: bot.username, token: bot.token, managed: Boolean(bot.managed), creatorId: bot.creatorId || null, addedAt: this.now(), from });
    this.save();
  }

  async addToPool(token, { managed = false, creatorId = null } = {}) {
    token = String(token || "").trim();
    if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error("Это не похоже на токен бота (вида 123456:ABC…)");
    if (token === this.cfg.telegramToken || token === this.cfg.adminBotToken) throw new Error("Это токен общего бота");
    const me = await this.makeApi(token).getMe();
    const used = this.venueList().find((v) => v.bot?.mode === "own" && Number(v.bot.id) === Number(me.id));
    if (used) throw new Error(`@${me.username} уже работает у заведения ${used.id}`);
    this.toPool({ id: me.id, username: me.username, token, managed, creatorId });
    return me;
  }

  async assignFromPool(venueId, botId = null) {
    const b = botId ? this.state.pool.find((x) => Number(x.id) === Number(botId)) : this.state.pool[0];
    if (!b) throw new Error("В запасе нет свободных ботов");
    return this.attachBot(venueId, b.token, { managed: b.managed, creatorId: b.creatorId, rename: true });
  }

  // Описание бота в Telegram — то, что человек видит до первого сообщения. Своё описание бота не трогаем,
  // а бот из запаса получает название и описание заведения.
  async describeBot(app, api, { rename = false } = {}) {
    const s = app.shop;
    if (!s.name) return;
    const addr = [s.city, s.address].filter(Boolean).join(", ");
    const set = async (getter, field, method, value) => {
      if (!rename) {
        const cur = await api.call(getter).catch(() => null);
        if (cur?.[field]) return;
      }
      await api.call(method, { [field]: value }).catch((e) => this.log.warn(`${method}:`, e.message));
    };
    if (rename) await api.call("setMyName", { name: truncate(s.name, 64) }).catch((e) => this.log.warn("setMyName:", e.message));
    await set("getMyDescription", "description", "setMyDescription", truncate(`Онлайн-администратор «${s.name}»: подскажу по услугам и ценам, покажу свободное время и запишу.${addr ? ` Адрес: ${addr}.` : ""}`, 512));
    await set("getMyShortDescription", "short_description", "setMyShortDescription", truncate(`Запись и ответы на вопросы — ${s.name}`, 120));
  }

  // Юзернейм, который Telegram подставит при создании бота заведения (человек может его поменять)
  suggestUsername(rec) {
    const base = (rec.slug || rec.id).replace(/-/g, "_").replace(/^[^a-z]+/, "") || "venue";
    const tail = "_zapis_bot";
    return base.slice(0, 32 - tail.length).replace(/_+$/, "") + tail;
  }

  canManageBots() {
    return Boolean(this.sharedMe?.can_manage_bots);
  }

  // Ссылка Telegram «создать бота»: название и юзернейм заведения уже подставлены, а созданный бот приходит общему
  // боту апдейтом managed_bot (onManagedBot) — токен платформа берёт сама, ничего копировать не нужно.
  // uid — кто откроет ссылку; null — любой владелец (ссылку получили командой на сервере)
  managedBotLink(venueId, uid = null) {
    const rec = this.state.venues[venueId];
    if (!rec) throw new Error("Нет такого заведения");
    const username = this.suggestUsername(rec);
    this.state.managedRequests[uid ?? "*"] = { venue: venueId, username, at: this.now() };
    this.save();
    const name = truncate(this.venueName(venueId), 64);
    return `https://t.me/newbot/${this.sharedMe.username}/${username}?name=${encodeURIComponent(name)}`;
  }

  // Telegram сообщил о боте, которым управляет общий бот: создан (по ссылке managedBotLink), сменился токен или владелец
  async onManagedBot(mb) {
    const bot = mb?.bot;
    const creator = mb?.user;
    if (!bot?.id) return;
    let token;
    try {
      token = await this.shared.call("getManagedBotToken", { user_id: bot.id });
    } catch (e) {
      this.log.error(`Не удалось получить токен управляемого бота @${bot.username}:`, e.message);
      return;
    }
    const current = this.venueList().find((v) => v.bot?.mode === "own" && Number(v.bot.id) === Number(bot.id));
    if (current) {
      if (current.bot.token !== token) await this.attachBot(current.id, token, { managed: true, creatorId: current.bot.creatorId }).catch((e) => this.log.error("Новый токен бота:", e.message));
      return;
    }
    const pooled = this.state.pool.find((b) => Number(b.id) === Number(bot.id));
    if (pooled) {
      pooled.token = token;
      this.save();
      return;
    }
    if (!this.isOwner(creator?.id)) {
      this.log.warn(`Бот @${bot.username} создан под управлением общего бота не владельцем платформы (${creator?.id}) — не подключаю`);
      return;
    }
    const key = this.state.managedRequests[creator.id] ? creator.id : "*";
    const req = this.state.managedRequests[key];
    delete this.state.managedRequests[key];
    const free = (v) => v && v.bot?.mode !== "own";
    const venueId =
      req && this.now() - req.at < DAY && free(this.state.venues[req.venue])
        ? req.venue
        : this.venueList().find((v) => free(v) && this.suggestUsername(v) === bot.username)?.id;
    const api = this.shared;
    if (!venueId) {
      this.toPool({ id: bot.id, username: bot.username, token, managed: true, creatorId: creator.id });
      return this.sendHtml(api, creator.id, `🤖 Бот @${esc(bot.username)} создан и добавлен в запас. Подключить его к заведению — /venues → заведение → «Отдельный бот».`);
    }
    try {
      const rec = await this.attachBot(venueId, token, { managed: true, creatorId: creator.id });
      return this.sendHtml(
        api,
        creator.id,
        `✅ Бот @${esc(bot.username)} подключён к <b>${esc(this.venueName(venueId))}</b>.\n\nСсылка для клиентов: ${esc(this.clientLink(rec))}\nКлиентам, которые писали в общий бот по ссылке заведения, он подскажет новый адрес.`,
        [[this.btn("🏪 Заведение", `v:${venueId}`)]]
      );
    } catch (e) {
      this.toPool({ id: bot.id, username: bot.username, token, managed: true, creatorId: creator.id });
      return this.sendHtml(api, creator.id, `⚠️ Бот @${esc(bot.username)} создан, но к заведению не подключился: ${esc(e.message)}. Он в запасе — подключить можно в /venues.`);
    }
  }

  // ---------- сообщения владельцам ----------

  btn(text, data) {
    return { text, callback_data: `P:${data}` };
  }

  // HTML; если Telegram не разобрал разметку — простым текстом
  async sendHtml(api, chatId, text, keyboard) {
    const opts = { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) };
    try {
      return await api.sendMessage(chatId, text, opts);
    } catch (e) {
      if (!/parse entities/i.test(e.message)) throw e;
      delete opts.parse_mode;
      return api.sendMessage(chatId, plain(text), opts);
    }
  }

  // Владельцам — туда, где у них панель (отдельный бот панели, если он есть)
  async notifyOwners(text, keyboard) {
    for (const id of this.ownerIds()) await this.sendHtml(this.uiApi("console"), id, text, keyboard).catch((e) => this.log.warn(`Владельцу ${id}:`, e.message));
  }
}

module.exports = { Platform, parseVenueData, readVenueFile, seedSlug, defaultPlatformState, OWNER_COMMANDS, RESERVED_SLUGS };
require("./venues-ui").install(Platform);
