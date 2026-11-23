// Управление запущенным ботом с сервера: node bot/cli.js … подключается к unix-сокету (по умолчанию data/control.sock)
// и присылает одну команду — строку JSON { cmd, args, opts }. В ответ — строка JSON { ok, result, text }
// (text — то же для человека) или { ok: false, error }. Сокет открыт только пользователю, от которого запущен бот
// (chmod 600): у него и так есть доступ к data/ с перепиской и токенами.
const fs = require("fs");
const net = require("net");
const { renderFull } = require("./shop");
const { parseVenueData } = require("./platform");
const { plain } = require("./util");

const MAX_REQUEST = 1024 * 1024;
const TOKEN_ARG = new Set(["bot", "pool"]); // в этих командах есть токен — в лог только название команды

function venueLines(p, d) {
  const lines = [`${d.id} · ${d.name}${d.default ? " · основное" : ""}`];
  lines.push(`  для клиентов: ${d.clientLink}`);
  lines.push(`  бот: ${d.bot.mode === "own" ? `свой @${d.bot.username}${d.bot.connected ? "" : " (недоступен — работает общий)"}` : `общий @${d.bot.username}`}`);
  lines.push(`  администраторы: ${d.admins.length ? d.admins.map((a) => `${a.name || "без имени"}${a.username ? ` @${a.username}` : ""} (${a.id})`).join(", ") : "нет"}`);
  lines.push(`  услуг: ${d.services} · переписок: ${d.conversations} · активных записей: ${d.bookings}`);
  return lines;
}

// Заведение по id, ссылке или названию — или понятная ошибка
function need(p, ref) {
  if (!ref) throw new Error("Укажите заведение: id (v2), ссылку (borodach) или название");
  const rec = p.findVenue(ref);
  if (rec) return rec;
  const s = String(ref).toLowerCase();
  const many = p.venueList().filter((v) => p.venueName(v.id).toLowerCase().includes(s));
  if (many.length > 1) throw new Error(`«${ref}» подходит нескольким заведениям: ${many.map((v) => `${v.id} «${p.venueName(v.id)}»`).join(", ")}. Укажите id`);
  throw new Error(`Нет заведения «${ref}». Список — node bot/cli.js list`);
}

// Заведение создано командой: ссылки для клиентов и администратора — в ответ, а владельцам ещё и в Telegram
async function created(p, rec, app, { notes = [], quiet = false } = {}) {
  const invite = p.adminInvite(rec.id, null);
  if (!quiet) await p.announceVenue(rec, app, { notes, via: "команда на сервере", invite }).catch((e) => p.log.warn("Владельцам:", e.message));
  const d = p.describe(rec);
  const text = [
    `Заведение создано: ${d.id} · ${d.name}`,
    "",
    plain(renderFull(app.shop)),
    "",
    `Ссылка для клиентов: ${d.clientLink}`,
    `Ссылка для администратора (одноразовая, 7 дней): ${invite}`,
    ...(notes.length ? ["", "Проверьте:", ...notes.map((n) => `• ${n}`)] : []),
    ...(quiet || !p.ownerIds().length ? [] : ["", "Те же ссылки отправлены владельцу в Telegram."]),
  ];
  return { result: { venue: d, invite, notes }, text: text.join("\n") };
}

const COMMANDS = {
  status(p) {
    const venues = p.venueList();
    const owners = p.ownerIds();
    const result = {
      bot: p.sharedMe.username,
      consoleBot: p.sharedConsoleMe?.username || null,
      canManageBots: p.canManageBots(),
      venues: venues.length,
      owners,
      pool: p.state.pool.map((b) => b.username),
      ownerLink: owners.length ? null : p.ownerLink(),
    };
    const text = [
      `Общий бот: @${result.bot}${result.consoleBot ? `, панель мастеров — @${result.consoleBot}` : ""}`,
      `Заведений: ${venues.length}`,
      owners.length ? `Владельцы (Telegram ID): ${owners.join(", ")}` : `Владельца нет. Стать владельцем: ${result.ownerLink}`,
      `Создание ботов из Telegram (Managed Bots): ${result.canManageBots ? "включено" : "выключено — включается в @BotFather"}`,
      `Ботов в запасе: ${result.pool.length}${result.pool.length ? ` (${result.pool.map((u) => `@${u}`).join(", ")})` : ""}`,
    ];
    return { result, text: text.join("\n") };
  },

  list(p) {
    const list = p.venueList().map((rec) => p.describe(rec));
    const text = list.length ? list.flatMap((d) => [...venueLines(p, d), ""]).join("\n").trim() : "Заведений пока нет.";
    return { result: list, text };
  },

  show(p, [ref]) {
    const rec = need(p, ref);
    const app = p.apps.get(rec.id);
    const d = p.describe(rec);
    return { result: { ...d, shop: app.shop }, text: [...venueLines(p, d), "", plain(renderFull(app.shop))].join("\n") };
  },

  // add <ссылка на Яндекс.Карты> | add --json <данные> — новое заведение. --slug — своя ссылка, --quiet — не писать владельцам
  async add(p, [url], opts) {
    const slug = opts.slug || null;
    if (opts.data) {
      const seed = parseVenueData(opts.data);
      const { rec, app } = await p.createVenue({ shop: seed.shop, slug: slug || seed.slug, by: "cli" });
      return created(p, rec, app, { notes: seed.notes, quiet: opts.quiet });
    }
    if (!url) throw new Error("Нужна ссылка на карточку в Яндекс.Картах или --json с данными заведения");
    const r = await p.importVenue({ url, slug, by: "cli" });
    if (!r.ok) throw new Error([`Не получилось загрузить карточку: ${r.reason || "причина неизвестна"}`, ...(r.details || []).map((d) => `• ${d}`)].join("\n"));
    return created(p, r.rec, r.app, { notes: r.changes, quiet: opts.quiet });
  },

  invite(p, [ref]) {
    const rec = need(p, ref);
    const link = p.adminInvite(rec.id, null);
    return { result: { venue: rec.id, invite: link }, text: `Ссылка для администратора ${p.venueName(rec.id)} (одноразовая, 7 дней):\n${link}` };
  },

  async admin(p, [ref, userId, ...name]) {
    const rec = need(p, ref);
    const r = await p.addAdmin(rec.id, userId, { name: name.join(" ") });
    return {
      result: { venue: rec.id, admin: Number(userId), told: r.told },
      text: `${userId} — администратор ${p.venueName(rec.id)}.${r.told ? " Бот написал ему об этом." : " Написать ему бот не смог: пусть откроет бота и пришлёт /panel."}`,
    };
  },

  async unadmin(p, [ref, userId]) {
    const rec = need(p, ref);
    await p.removeAdmin(rec.id, userId);
    return { result: { venue: rec.id, removed: Number(userId) }, text: `${userId} больше не администратор ${p.venueName(rec.id)}.` };
  },

  slug(p, [ref, slug]) {
    const rec = need(p, ref);
    if (!slug) throw new Error("Укажите новую ссылку: латиница, цифры и дефис");
    p.setSlug(rec.id, slug);
    return { result: p.describe(rec), text: `Новая ссылка для клиентов: ${p.clientLink(rec)}\nПрежняя больше не ведёт в это заведение.` };
  },

  default(p, [ref]) {
    const rec = need(p, ref);
    p.setDefault(rec.id);
    return { result: { venue: rec.id }, text: `${p.venueName(rec.id)} — основное заведение: в него попадает тот, кто открыл бота без ссылки заведения.` };
  },

  async delete(p, [ref], opts) {
    const rec = need(p, ref);
    const name = p.venueName(rec.id);
    if (!opts.yes) {
      return {
        result: { venue: rec.id, deleted: false },
        text: `Удалить ${rec.id} «${name}»? Клиенты по ссылке больше не попадут в заведение, данные уедут в архив data/venues/_deleted. Повторите с --yes.`,
      };
    }
    await p.deleteVenue(rec.id);
    return { result: { venue: rec.id, deleted: true }, text: `Заведение ${rec.id} «${name}» удалено (данные — в data/venues/_deleted).` };
  },

  // bot <заведение> <токен> — подключить заведению свой бот. --rename — дать боту название заведения
  async bot(p, [ref, token], opts) {
    const rec = need(p, ref);
    const r = await p.attachBot(rec.id, token, { rename: Boolean(opts.rename) });
    return { result: p.describe(r), text: `${p.venueName(rec.id)} теперь в своём боте @${r.bot.username}.\nСсылка для клиентов: ${p.clientLink(r)}` };
  },

  async unbot(p, [ref]) {
    const rec = need(p, ref);
    const had = rec.bot?.mode === "own" ? rec.bot.username : null;
    await p.detachBot(rec.id);
    return {
      result: p.describe(rec),
      text: had ? `${p.venueName(rec.id)} снова в общем боте, @${had} — в запасе.\nСсылка для клиентов: ${p.clientLink(rec)}` : "У заведения и так общий бот.",
    };
  },

  // pool — запас ботов; pool add <токен>; pool use <заведение> [@бот]
  async pool(p, [sub, a, b]) {
    if (!sub || sub === "list") {
      const list = p.state.pool.map((x) => ({ id: x.id, username: x.username, managed: x.managed }));
      return { result: list, text: list.length ? list.map((x) => `@${x.username} (${x.id})${x.managed ? " · создан через Telegram" : ""}`).join("\n") : "В запасе ботов нет." };
    }
    if (sub === "add") {
      const me = await p.addToPool(a);
      return { result: { id: me.id, username: me.username }, text: `@${me.username} в запасе.` };
    }
    if (sub === "use") {
      const rec = need(p, a);
      const bot = b ? p.state.pool.find((x) => String(x.id) === String(b).replace(/^@/, "") || x.username === String(b).replace(/^@/, "")) : null;
      if (b && !bot) throw new Error(`В запасе нет ${b}`);
      const r = await p.assignFromPool(rec.id, bot?.id);
      return { result: p.describe(r), text: `${p.venueName(rec.id)} теперь в боте @${r.bot.username}.\nСсылка для клиентов: ${p.clientLink(r)}` };
    }
    throw new Error("pool, pool add <токен> или pool use <заведение> [@бот]");
  },

  // newbot <заведение> — ссылка Telegram «создать бота» для заведения (Managed Bots): бот подключится сам
  newbot(p, [ref]) {
    const rec = need(p, ref);
    if (!p.canManageBots()) {
      throw new Error(`Для @${p.sharedMe.username} не включено управление другими ботами (Managed Bots): включите его в @BotFather и перезапустите бота. Или подключите бота по токену: bot <заведение> <токен>`);
    }
    const link = p.managedBotLink(rec.id, null);
    return {
      result: { venue: rec.id, link },
      text: `Откройте ссылку в Telegram с аккаунта владельца и нажмите «Создать» — бот подключится к ${p.venueName(rec.id)} сам (ссылка для одного бота, сутки):\n${link}`,
    };
  },

  // owner — новая одноразовая ссылка «стать владельцем» (например, для второго владельца)
  owner(p) {
    const link = p.ownerLink({ fresh: true });
    return { result: { link }, text: `Одноразовая ссылка «стать владельцем» (прежняя больше не работает):\n${link}` };
  },
};

async function execute(p, line, log = console) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return { ok: false, error: "Команда — не JSON" };
  }
  const cmd = String(req?.cmd || "");
  const fn = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null;
  if (!fn) return { ok: false, error: `Нет команды «${cmd}». Список — node bot/cli.js help` };
  const args = Array.isArray(req.args) ? req.args.map(String) : [];
  log.info("Команда с сервера:", cmd, TOKEN_ARG.has(cmd) ? "" : args.slice(0, 2).join(" "));
  try {
    return { ok: true, ...(await fn(p, args, req.opts || {})) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// → net.Server или null (управление выключено). Команды выполняются как фоновые задачи платформы.
function startControl(p, file, { log = console } = {}) {
  if (!file) return null;
  // Сокет от прошлого запуска (процесс убили, не дав убрать его) мешает listen
  try {
    if (fs.statSync(file).isSocket()) fs.unlinkSync(file);
  } catch {}
  const server = net.createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      if (buf === null) return;
      buf += chunk;
      if (buf.length > MAX_REQUEST) return sock.destroy();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = null; // одна команда на подключение
      p.run(async () => {
        const out = await execute(p, line, log);
        if (!sock.destroyed) sock.end(JSON.stringify(out) + "\n");
      });
    });
  });
  server.on("error", (e) => log.error("Управление с сервера не запустилось:", file, e.message));
  server.listen(file, () => log.info(`Управление с сервера: node bot/cli.js help (сокет ${file})`));
  // Файл сокета появляется сразу (bind синхронный) — закрываем его, пока никто не успел подключиться
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  const close = server.close.bind(server);
  server.close = (cb) => {
    close(cb);
    try {
      fs.unlinkSync(file);
    } catch {}
  };
  return server;
}

module.exports = { startControl, execute, COMMANDS };
