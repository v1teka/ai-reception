// Экраны владельца платформы в общем боте: список заведений, новое заведение по карточке с Яндекс.Карт,
// ссылки для клиентов и администратора, администраторы, свой бот у заведения. Кнопки — «P:…» (см. onOwnerCallback).
const { App } = require("./app");
const { renderSummary, emptyShop } = require("./shop");
const { extractYandexUrl } = require("./yandex");
const { checkLines, hasErrors } = require("./review");
const { esc, truncate } = require("./util");

const TOKEN_RE = /\d{5,}:[A-Za-z0-9_-]{30,}/;

const methods = {
  // Отредактировать сообщение, на кнопке которого нажали, или прислать новое
  async ownerShow(api, uid, text, keyboard, cq) {
    if (cq?.message) {
      try {
        await api.call("editMessageText", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: keyboard || [] },
        });
        return;
      } catch (e) {
        if (/not modified/i.test(e.message)) return;
      }
    }
    return this.sendHtml(api, uid, text, keyboard).catch((e) => this.log.warn("Экран владельца:", e.message));
  },

  // /venues и /new [ссылка] — true, если это была команда владельца
  async onOwnerCommand(msg, source) {
    const m = (msg.text || "").match(/^\/(venues|new)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    if (!m) return false;
    const uid = msg.from.id;
    const api = this.uiApi(source);
    if (m[1].toLowerCase() === "venues") {
      this.setMode(uid, null);
      await this.showVenues(uid, api);
      return true;
    }
    const url = extractYandexUrl(m[2] || "");
    if (url) {
      this.setMode(uid, null);
      this.run(() => this.createFromUrl(uid, url, api));
      return true;
    }
    this.setMode(uid, "await_venue");
    await this.askVenueUrl(uid, api);
    return true;
  },

  // Владелец нажал «Новое заведение» или «Прислать токен» и теперь пишет — true, если сообщение для этого
  async onOwnerInput(msg, source, u) {
    const uid = msg.from.id;
    const mode = this.mode(uid);
    if (!mode) return false;
    const api = this.uiApi(source);
    const text = msg.text || msg.caption || "";
    // Команда (/panel, /cancel…) — владелец занялся другим: ссылку или токен больше не ждём
    if (text.startsWith("/")) {
      this.setMode(uid, null);
      return false;
    }
    if (mode === "await_venue") {
      const url = extractYandexUrl(text);
      if (url) {
        this.setMode(uid, null);
        this.run(() => this.createFromUrl(uid, url, api));
        return true;
      }
      // Скриншоты карточки или описание словами — пустое заведение, а данные разберёт его настройка точки
      if (msg.photo || /^image\//.test(msg.document?.mime_type || "") || text.trim().length >= 30) {
        this.setMode(uid, null);
        await this.createEmpty(uid, api, { forward: { u, source } });
        return true;
      }
      await this.sendHtml(api, uid, "Пришлите ссылку на карточку заведения в Яндекс.Картах — или скриншоты карточки и прайса, или описание словами.", [
        [this.btn("📝 Создать пустое", "empty"), this.btn("❌ Отмена", "cancel")],
      ]);
      return true;
    }
    if (mode.startsWith("token:")) {
      const venueId = mode.slice(6);
      const token = (text.match(TOKEN_RE) || [])[0];
      if (!token) {
        await this.sendHtml(api, uid, "Это не похоже на токен бота. Его выдаёт @BotFather, вида <code>123456789:AA…</code>", [[this.btn("❌ Отмена", "cancel")]]);
        return true;
      }
      // Токен — ключ от бота: в переписке его не оставляем
      api.call("deleteMessage", { chat_id: uid, message_id: msg.message_id }).catch(() => {});
      this.setMode(uid, null);
      this.run(async () => {
        try {
          const rec = await this.attachBot(venueId, token);
          await this.sendHtml(api, uid, `✅ Бот @${esc(rec.bot.username)} подключён к <b>${esc(this.venueName(venueId))}</b>.\nСсылка для клиентов: ${esc(this.clientLink(rec))}`, [
            [this.btn("🏪 Заведение", `v:${venueId}`)],
          ]);
        } catch (e) {
          await this.sendHtml(api, uid, `⚠️ Бот не подключён: ${esc(e.message)}`, [[this.btn("🤖 Отдельный бот", `bot:${venueId}`)]]);
        }
      });
      return true;
    }
    return false;
  },

  async askVenueUrl(uid, api) {
    return this.sendHtml(
      api,
      uid,
      "➕ <b>Новое заведение</b>\n\nПришлите ссылку на карточку заведения в Яндекс.Картах (в приложении: карточка → «Поделиться» → «Скопировать ссылку»). Бот заберёт название, адрес, график, телефон и прайс, создаст заведение и даст ссылки для клиентов и администратора.\n\nНет карточки или Яндекс не пускает — пришлите скриншоты карточки и прайса или опишите заведение словами.",
      [[this.btn("📝 Создать пустое", "empty"), this.btn("❌ Отмена", "cancel")]]
    );
  },

  async createFromUrl(uid, url, api) {
    await api.sendMessage(uid, "⏳ Загружаю карточку с Яндекс.Карт и создаю заведение… Обычно это до минуты.").catch(() => {});
    const r = await this.importVenue({ url, by: uid });
    if (!r.ok) {
      // Владелец видит техническую причину целиком: он и разбирается со сбоями
      return this.sendHtml(
        api,
        uid,
        `😕 Не получилось создать заведение по карточке.\n\n${App.prototype.importFailureDetails(r)}\n\nМожно создать пустое заведение и прислать скриншоты карточки и прайса или описать его словами.`,
        [[this.btn("📝 Создать пустое", "empty"), this.btn("🔁 Другая ссылка", "new")]]
      );
    }
    this.enter(uid, r.rec.id);
    return this.sendCreated(uid, r.rec, r.app, { checks: r.checks, api });
  },

  // Пустое заведение: данные владелец присылает в его настройку точки — словами или скриншотами.
  // forward — сообщение, с которого он уже начал (скриншоты, описание): его сразу разбирает настройка.
  async createEmpty(uid, api, { forward = null } = {}) {
    const { rec, app } = await this.createVenue({ shop: emptyShop(), by: uid });
    this.enter(uid, rec.id);
    app.startSetup(app.admin(uid), "await_edit", { freshBase: true, pending: null });
    if (forward) return app.handleUpdate(forward.u, forward.source);
    return app.sendHtml(
      uid,
      "📝 <b>Новое заведение</b>\n\nОпишите его: название, адрес, график, услуги с ценами и длительностью — можно одним сообщением или скриншотами карточки и прайса. Бот покажет, что понял, и сохранит после подтверждения, а потом пришлёт ссылки для клиентов и администратора.",
      { reply_markup: { inline_keyboard: [[{ text: "❌ Отменить", callback_data: "s:cancel" }]] } }
    );
  },

  // Текст «заведение готово»: что проверить, что загружено, ссылки для клиентов и одноразовая — для администратора.
  // checks — что бот просит проверить (review.js), сверху: ссылку клиентам отдают после этого
  createdText(rec, app, { checks = [], invite, via = "", title = "Заведение создано" } = {}) {
    const lines = [`✅ <b>${esc(title)}</b>${via ? ` <i>(${esc(via)})</i>` : ""}`, ""];
    if (checks.length) lines.push("⚠️ <b>Проверьте, прежде чем отдавать ссылку клиентам</b>", ...checkLines(checks.slice(0, 12)), "");
    lines.push(renderSummary(app.shop), "");
    lines.push(
      hasErrors(checks)
        ? "🔗 <b>Ссылка для клиентов</b> — опубликуйте её, когда поправите то, что отмечено ❗:"
        : "🔗 <b>Ссылка для клиентов</b> — её можно публиковать:",
      esc(this.clientLink(rec)),
      ""
    );
    lines.push(
      "👤 <b>Ссылка для администратора</b> — одноразовая, действует 7 дней. Перешлите её представителю заведения: по ней он станет администратором и сразу увидит данные своей точки.",
      esc(invite)
    );
    return lines.join("\n");
  },

  createdKeyboard(rec) {
    return [
      [this.btn("💈 Панель заведения", `open:${rec.id}`), { text: "✏️ Поправить данные", callback_data: `${rec.id}|s:edit` }],
      [this.btn("🏪 Все заведения", "list")],
    ];
  },

  async sendCreated(uid, rec, app, { checks = [], api = this.shared } = {}) {
    const invite = this.adminInvite(rec.id, uid);
    return this.sendHtml(api, uid, this.createdText(rec, app, { checks, invite }), this.createdKeyboard(rec));
  },

  // Заведение создали не в чате с владельцем (командой на сервере или файлом из venues/) — ссылки приходят владельцам
  async announceVenue(rec, app, { checks = [], via = "", invite = null } = {}) {
    if (!this.ownerIds().length) return;
    invite ||= this.adminInvite(rec.id, null);
    return this.notifyOwners(this.createdText(rec, app, { checks, invite, via }), this.createdKeyboard(rec));
  },

  // ---------- списки и карточка заведения ----------

  async showVenues(uid, api, cq) {
    const list = this.venueList();
    const cur = this.userVenue(uid);
    const lines = [`🏪 <b>Заведения</b> · ${list.length}`, ""];
    for (const rec of list.slice(0, 40)) {
      const d = this.describe(rec);
      const bot = d.bot.mode === "own" ? `свой бот @${esc(d.bot.username)}` : `?start=${esc(rec.slug)}`;
      const admins = d.admins.length ? `админов: ${d.admins.length}` : "без администратора";
      lines.push(`${rec.id === cur ? "▶️" : "•"} <b>${esc(d.name)}</b>${d.default ? " · основное" : ""} · ${bot} · ${admins}`);
    }
    if (list.length > 40) lines.push(`…и ещё ${list.length - 40}: полный список — node bot/cli.js list на сервере`);
    lines.push("", "<i>Новое заведение — кнопка ниже или команда /new со ссылкой на карточку в Яндекс.Картах.</i>");
    const kb = list.slice(0, 40).map((rec) => [this.btn(`${rec.id === cur ? "▶️ " : ""}${truncate(this.venueName(rec.id), 40)}`, `v:${rec.id}`)]);
    kb.push([this.btn("➕ Новое заведение", "new")]);
    return this.ownerShow(api, uid, lines.join("\n"), kb, cq);
  },

  async showVenue(uid, id, api, cq) {
    const rec = this.state.venues[id];
    const app = this.apps.get(id);
    if (!rec || !app) return this.ownerShow(api, uid, "Заведение не найдено — возможно, его удалили.", [[this.btn("🏪 Заведения", "list")]], cq);
    const d = this.describe(rec);
    const s = app.shop;
    const lines = [`🏪 <b>${esc(d.name)}</b>${d.default ? " · основное" : ""}${s.demo ? " <i>(демо-данные)</i>" : ""}`];
    if (s.city || s.address) lines.push(`📍 ${esc([s.city, s.address].filter(Boolean).join(", "))}`);
    lines.push(`✂️ Услуг: ${d.services} · 💬 переписок: ${d.conversations} · 📅 записей: ${d.bookings}`);
    lines.push(
      d.admins.length
        ? `👤 Администраторы: ${d.admins.map((a) => `${esc(a.name || "без имени")}${a.username ? ` @${esc(a.username)}` : ""}`).join(", ")}`
        : "👤 Администратора пока нет — отправьте ссылку-приглашение"
    );
    if (rec.bot?.mode === "own") {
      lines.push(d.bot.connected ? `🤖 Свой бот: @${esc(rec.bot.username)}` : `⚠️ Свой бот @${esc(rec.bot.username || "?")} недоступен${rec.bot.error ? `: ${esc(rec.bot.error)}` : ""} — работает общий`);
    } else lines.push(`🤖 Общий бот @${esc(this.sharedMe.username)}`);
    lines.push(`🔗 Для клиентов: ${esc(d.clientLink)}`);
    const kb = [
      [this.btn("💈 Панель заведения", `open:${id}`), this.btn("🔗 Ссылка администратору", `inv:${id}`)],
      [this.btn("👤 Администраторы", `adm:${id}`), this.btn("🤖 Отдельный бот", `bot:${id}`)],
    ];
    if (!d.default) kb.push([this.btn("⭐ Сделать основным", `def:${id}`), this.btn("🗑 Удалить", `del:${id}`)]);
    kb.push([this.btn("◀️ Заведения", "list")]);
    if (d.default) lines.push("", "<i>Основное заведение: в него попадает тот, кто открыл бота без ссылки заведения.</i>");
    return this.ownerShow(api, uid, lines.join("\n"), kb, cq);
  },

  async showAdmins(uid, id, api, cq) {
    const rec = this.state.venues[id];
    if (!rec || !this.apps.get(id)) return this.showVenues(uid, api, cq);
    const d = this.describe(rec);
    const lines = [`👤 <b>Администраторы ${esc(d.name)}</b>`, ""];
    if (!d.admins.length) lines.push("Пока никого. Отправьте представителю заведения ссылку-приглашение.");
    for (const a of d.admins) lines.push(`• ${esc(a.name || "без имени")}${a.username ? ` @${esc(a.username)}` : ""} (id ${a.id})`);
    lines.push("", "<i>Администратор видит переписки, записи и настройки только этого заведения. Назначить по Telegram ID можно и с сервера: node bot/cli.js admin.</i>");
    const kb = d.admins.slice(0, 20).map((a) => [this.btn(`❌ Убрать ${truncate(a.name || String(a.id), 30)}`, `rm:${id}:${a.id}`)]);
    kb.push([this.btn("🔗 Пригласить", `inv:${id}`), this.btn("◀️ Заведение", `v:${id}`)]);
    return this.ownerShow(api, uid, lines.join("\n"), kb, cq);
  },

  async showBot(uid, id, api, cq) {
    const rec = this.state.venues[id];
    if (!rec || !this.apps.get(id)) return this.showVenues(uid, api, cq);
    const name = esc(this.venueName(id));
    const own = rec.bot?.mode === "own";
    const lines = [`🤖 <b>Отдельный бот для ${name}</b>`, ""];
    lines.push(
      own
        ? `Сейчас у заведения свой бот @${esc(rec.bot.username)}${this.ownBots.has(id) ? "" : " (сейчас недоступен — работает общий)"}.`
        : `Сейчас заведение в общем боте @${esc(this.sharedMe.username)}: клиенты приходят по ссылке ${esc(this.clientLink(rec))}.`
    );
    lines.push(
      "",
      "Со своим ботом у заведения своё имя в Telegram, а клиенты пишут прямо в него. Переписки, записи и настройки остаются те же; клиентам общего бота он подскажет новый адрес."
    );
    const kb = [];
    if (this.canManageBots()) {
      lines.push("", "«Создать бота» откроет в Telegram экран создания бота — имя и адрес уже подставлены. Бот подключится к заведению сам.");
      kb.push([{ text: "🆕 Создать бота в Telegram", url: this.managedBotLink(id, uid) }]);
    } else {
      lines.push(
        "",
        `Чтобы создавать ботов одной кнопкой, включите для @${esc(this.sharedMe.username)} в @BotFather управление другими ботами (Managed Bots) и перезапустите бота. Пока можно подключить бота, созданного в @BotFather, по токену.`
      );
    }
    const pool = this.state.pool.slice(0, 5);
    if (pool.length) {
      lines.push("", `В запасе: ${pool.map((b) => `@${esc(b.username)}`).join(", ")} — такой бот получит название заведения.`);
      for (const b of pool) kb.push([this.btn(`📦 Взять @${truncate(b.username, 30)}`, `pool:${id}:${b.id}`)]);
    }
    kb.push([this.btn("🔑 Прислать токен от @BotFather", `tok:${id}`)]);
    if (own) kb.push([this.btn("↩️ Вернуть в общий бот", `unbot:${id}`)]);
    kb.push([this.btn("◀️ Заведение", `v:${id}`)]);
    return this.ownerShow(api, uid, lines.join("\n"), kb, cq);
  },

  // ---------- кнопки владельца ----------

  async onOwnerCallback(cq, data, source) {
    const uid = cq.from.id;
    const api = this.uiApi(source);
    const answer = (text, alert = false) => api.call("answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
    if (!this.isOwner(uid)) return answer("Нет доступа");
    const [act, id, arg] = data.split(":");
    const rec = id ? this.state.venues[id] : null;
    if (id && !rec && act !== "list") {
      await answer("Заведение не найдено — возможно, его удалили");
      return this.showVenues(uid, api, cq);
    }
    // Любая кнопка, кроме самого «Нового заведения», отменяет ожидание ссылки или токена
    if (!["new", "empty"].includes(act)) this.setMode(uid, null);
    switch (act) {
      case "list":
        await answer();
        return this.showVenues(uid, api, cq);
      case "v":
        await answer();
        return this.showVenue(uid, id, api, cq);
      case "new":
        await answer();
        this.setMode(uid, "await_venue");
        return this.askVenueUrl(uid, api);
      case "empty":
        await answer("Создаю");
        this.setMode(uid, null);
        return this.createEmpty(uid, api);
      case "cancel":
        await answer("Отменено");
        return api.sendMessage(uid, "Отменено.").catch(() => {});
      case "open": {
        await answer();
        const app = this.apps.get(id);
        if (!this.isShared(app)) {
          return this.sendHtml(api, uid, `Панель ${esc(this.venueName(id))} — в его боте @${esc(rec.bot.username)}.`, [
            [{ text: `Открыть @${rec.bot.username}`, url: `https://t.me/${rec.bot.username}?start=panel` }],
          ]);
        }
        this.enter(uid, id);
        return app.showPanel(uid);
      }
      case "inv": {
        await answer();
        const link = this.adminInvite(id, uid);
        return this.sendHtml(
          api,
          uid,
          `👤 <b>Ссылка для администратора ${esc(this.venueName(id))}</b>\n\nОдноразовая, действует 7 дней. Перешлите её представителю заведения: по ней он станет администратором и сразу увидит данные своей точки.\n\n${esc(link)}`
        );
      }
      case "adm":
        await answer();
        return this.showAdmins(uid, id, api, cq);
      case "rm": {
        await answer();
        const a = this.apps.get(id)?.state.admins[arg];
        return this.ownerShow(
          api,
          uid,
          `Убрать <b>${esc(a?.name || arg)}</b> из администраторов ${esc(this.venueName(id))}? Диалоги, которые он ведёт, вернутся боту.`,
          [[this.btn("Да, убрать", `rm2:${id}:${arg}`), this.btn("Нет", `adm:${id}`)]],
          cq
        );
      }
      case "rm2": {
        try {
          await this.removeAdmin(id, arg);
          await answer("Убран");
          const app = this.apps.get(id);
          app?.sendHtml(Number(arg), `Вы больше не администратор <b>${esc(app.shop.name || "точки")}</b> в этом боте.`).catch(() => {});
        } catch (e) {
          await answer(e.message, true);
        }
        return this.showAdmins(uid, id, api, cq);
      }
      case "bot":
        await answer();
        return this.showBot(uid, id, api, cq);
      case "tok":
        await answer();
        this.setMode(uid, `token:${id}`);
        return this.sendHtml(
          api,
          uid,
          `🔑 Пришлите токен бота для ${esc(this.venueName(id))}. Создать бота и получить токен — в @BotFather: /newbot. Сообщение с токеном я сразу удалю из переписки.`,
          [[this.btn("❌ Отмена", "cancel")]]
        );
      case "pool":
        await answer("Подключаю");
        try {
          const r = await this.assignFromPool(id, arg);
          await this.sendHtml(api, uid, `✅ Бот @${esc(r.bot.username)} подключён к <b>${esc(this.venueName(id))}</b>.\nСсылка для клиентов: ${esc(this.clientLink(r))}`);
        } catch (e) {
          await this.sendHtml(api, uid, `⚠️ ${esc(e.message)}`);
        }
        return this.showVenue(uid, id, api);
      case "unbot":
        await answer();
        return this.ownerShow(
          api,
          uid,
          `Вернуть ${esc(this.venueName(id))} в общий бот? Свой бот @${esc(rec.bot?.username || "")} уйдёт в запас, а клиентам, которые пишут в него, бот отвечать перестанет.`,
          [[this.btn("Да, вернуть", `unbot2:${id}`), this.btn("Нет", `bot:${id}`)]],
          cq
        );
      case "unbot2":
        await answer("Готово");
        await this.detachBot(id);
        return this.showVenue(uid, id, api, cq);
      case "def":
        this.setDefault(id);
        await answer("Теперь это основное заведение");
        return this.showVenue(uid, id, api, cq);
      case "del":
        await answer();
        return this.ownerShow(
          api,
          uid,
          `🗑 <b>Удалить ${esc(this.venueName(id))}?</b>\nКлиенты по ссылке больше не попадут в это заведение. Переписки и записи не пропадут: они останутся в архиве на сервере (data/venues/_deleted).`,
          [[this.btn("Да, удалить", `del2:${id}`), this.btn("Нет", `v:${id}`)]],
          cq
        );
      case "del2":
        try {
          await this.deleteVenue(id);
          await answer("Удалено");
        } catch (e) {
          await answer(e.message, true);
        }
        return this.showVenues(uid, api, cq);
    }
    return answer();
  },
};

function install(Platform) {
  Object.assign(Platform.prototype, methods);
}

module.exports = { install };
