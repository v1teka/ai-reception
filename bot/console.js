// Панель мастера в Telegram: переписки, перехват и возврат боту, записи,
// настройки точки (Яндекс.Карты, правки словами, знания), приглашение мастера.
const { esc, truncate, randomCode, userName } = require("./util");
const { nowParts, fmtTime, fmtDate, fmtDateRelative, addDays, ago } = require("./time");
const { upcomingBookings, bookingLabel, cancelBooking, freeStarts } = require("./schedule");
const { renderSummary, renderFull, demoShop, emptyShop, serviceLine } = require("./shop");
const { importFromYandex, updateFromMessage, noteFromImages } = require("./setup");
const { extractYandexUrl } = require("./yandex");

const DAY = 86400000;
const btn = (text, data) => ({ text, callback_data: data });
const BACK = [btn("◀️ Меню", "m:panel")];

// Длинный HTML режем по строкам, чтобы не упереться в лимит 4096 символов
function chunks(text, max = 3900) {
  const out = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + "\n" + line).length > max && cur) {
      out.push(cur);
      cur = line;
    } else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

const STATUS = {
  waiting: { icon: "🔴", text: "ждёт ответа мастера" },
  admin: { icon: "✋", text: "ведёт мастер" },
  bot: { icon: "🤖", text: "ведёт бот" },
};

const methods = {
  // ---------- общие помощники ----------

  async show(adminId, text, keyboard, cq) {
    const markup = { reply_markup: { inline_keyboard: keyboard || [] } };
    if (cq?.message) {
      try {
        await this.consoleApi.call("editMessageText", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...markup,
        });
        return;
      } catch (e) {
        if (/not modified/i.test(e.message)) return;
      }
    }
    return this.sendHtml(adminId, text, markup).catch((e) => this.log.warn("Панель:", e.message));
  },

  async sendLong(adminId, html, keyboard) {
    const parts = chunks(html);
    for (let i = 0; i < parts.length; i++) {
      await this.sendHtml(adminId, parts[i], i === parts.length - 1 && keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}).catch(
        (e) => this.log.warn("Панель:", e.message)
      );
    }
  },

  lists() {
    const now = this.now();
    const all = Object.values(this.state.conversations).filter((c) => c.messages.some((m) => m.role === "client"));
    const waiting = all.filter((c) => c.status === "waiting").sort((a, b) => (a.handoff?.at || 0) - (b.handoff?.at || 0));
    const mine = all.filter((c) => c.status === "admin").sort((a, b) => b.updatedAt - a.updatedAt);
    const current = all.filter((c) => now - c.updatedAt < DAY).sort((a, b) => b.updatedAt - a.updatedAt);
    const unfinished = all
      .filter((c) => !c.session?.closed && !c.session?.booked && now - (c.lastClientAt || 0) < 7 * DAY)
      .filter((c) => c.messages.some((m) => m.role === "client" && !m.service))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { waiting, mine, current, unfinished };
  },

  convIcon(c) {
    if (c.status !== "bot") return STATUS[c.status].icon;
    return c.session?.booked ? "✅" : "💬";
  },

  // ---------- главное меню ----------

  async showPanel(adminId, cq, { hint = false } = {}) {
    const l = this.lists();
    const a = this.admin(adminId);
    const today = nowParts(this.shop.timezone, this.now()).date;
    const bookings = upcomingBookings(this.state, this.shop, { days: 2, now: this.now() });
    const lines = [
      `💈 <b>Панель мастера</b> · ${esc(this.shop.name || "точка не настроена")}${this.shop.demo ? " <i>(демо)</i>" : ""}`,
      "",
      `🔴 Ждут ответа: <b>${l.waiting.length}</b>`,
      `✋ Ведёте вы: <b>${l.mine.length}</b>`,
      `💬 Переписок за сутки: <b>${l.current.length}</b> · ⏳ незавершённых: <b>${l.unfinished.length}</b>`,
      `📅 Записей сегодня: <b>${bookings.filter((b) => b.date === today).length}</b>, завтра: <b>${
        bookings.filter((b) => b.date === addDays(today, 1)).length
      }</b>`,
    ];
    if (hint) lines.push("", "<i>Чтобы проверить бота как клиент, просто напишите ему обычное сообщение.</i>");
    const kb = [];
    if (l.waiting.length) kb.push([btn(`🔴 Ждут ответа (${l.waiting.length})`, "m:list:waiting")]);
    if (l.mine.length) kb.push([btn(`✋ Ведёте вы (${l.mine.length})`, "m:list:mine")]);
    kb.push([btn("💬 Текущие", "m:list:current"), btn("⏳ Незавершённые", "m:list:unfinished")]);
    kb.push([btn("📅 Записи", "m:bookings"), btn("🕐 Свободное время", "m:slots")]);
    kb.push([btn("⚙️ Настройки точки", "m:settings")]);
    kb.push([btn(`🔔 Уведомления: ${a?.notify !== false ? "вкл" : "выкл"}`, "m:notify"), btn("❓ Помощь", "m:help")]);
    if (this.role(adminId) === "owner") kb.push([btn("👤 Пригласить мастера", "m:invite")]);
    return this.show(adminId, lines.join("\n"), kb, cq);
  },

  async showList(adminId, kind, cq) {
    const l = this.lists();
    const titles = {
      waiting: "🔴 Ждут ответа мастера",
      mine: "✋ Диалоги, которые ведёте вы",
      current: "💬 Текущие переписки (за сутки)",
      unfinished: "⏳ Незавершённые: писали, но не записались",
    };
    const items = (l[kind] || []).slice(0, 12);
    const lines = [`<b>${titles[kind]}</b>`, ""];
    if (!items.length) lines.push("Пока пусто 👌");
    for (const c of items) {
      const last = [...c.messages].reverse().find((m) => !m.service);
      lines.push(
        `${this.convIcon(c)} <b>${esc(c.client.name || "Клиент")}</b> — «${esc(truncate(last?.text || "", 70))}» · ${ago(c.updatedAt, this.now())}`
      );
    }
    const kb = items.map((c) => [btn(`${this.convIcon(c)} ${truncate(c.client.name || "Клиент", 30)} · ${ago(c.updatedAt, this.now())}`, `c:open:${c.id}`)]);
    kb.push(BACK);
    return this.show(adminId, lines.join("\n"), kb, cq);
  },

  // ---------- карточка переписки ----------

  async showChat(adminId, convId, cq) {
    const c = this.conv(convId);
    if (!c) return this.show(adminId, "Переписка не найдена.", [BACK], cq);
    const tz = this.shop.timezone;
    const st = STATUS[c.status];
    const lines = [
      `${st.icon} <b>${esc(c.client.name || "Клиент")}</b>${c.client.username ? ` @${esc(c.client.username)}` : ""} · ${st.text}`,
      c.kind === "business" ? "📱 Пишет вам в Telegram (через Business)" : "🤖 Пишет боту",
    ];
    if (c.phone) lines.push(`📞 ${esc(c.phone)}`);
    if (c.status === "waiting" && c.handoff) {
      lines.push(`⚠️ ${esc(c.handoff.reason)}`);
      if (c.handoff.draft) lines.push(`📝 Черновик бота: «${esc(truncate(c.handoff.draft, 500))}»`);
    }
    const today = nowParts(tz, this.now()).date;
    const bookings = upcomingBookings(this.state, this.shop, { clientKey: c.id, now: this.now() });
    for (const b of bookings) lines.push(`🗓 ${b.id}: ${esc(b.serviceName)}, ${esc(bookingLabel(b, today))}, ${esc(b.staffName)}`);
    lines.push("", "<b>Последние сообщения</b>");
    const icons = { client: "👤", bot: "🤖", admin: "✂️" };
    for (const m of c.messages.filter((x) => !x.service).slice(-12)) {
      const p = nowParts(tz, m.at);
      const when = p.date === today ? fmtTime(p.minutes) : `${fmtDate(p.date)} ${fmtTime(p.minutes)}`;
      lines.push(`${icons[m.role] || "•"} <i>${when}</i> ${esc(truncate(m.text, 400))}`);
    }
    const own = this.isOwnChat(c, adminId);
    if (own) lines.push("", "<i>Это ваш собственный чат с ботом (проверка в роли клиента).</i>");
    const kb = [];
    if (c.status === "bot" && !own) kb.push([btn("✋ Перехватить", `c:take:${c.id}`)]);
    if (c.status === "waiting") {
      const row = [];
      if (!own) row.push(btn("✋ Взять диалог", `c:take:${c.id}`));
      if (c.handoff?.draft) row.push(btn("✅ Отправить черновик", `c:send:${c.id}`));
      if (row.length) kb.push(row);
      kb.push([btn("🔁 Бот, попробуй ещё", `c:retry:${c.id}`)]);
    }
    if (c.status === "admin") {
      const row = [];
      if (this.admin(adminId)?.relayTo !== c.id && !own) row.push(btn("✍️ Писать сюда", `c:write:${c.id}`));
      row.push(btn("🤖 Вернуть боту", `c:bot:${c.id}`));
      kb.push(row);
    }
    if (!c.session?.closed) kb.push([btn("✅ Завершить диалог", `c:close:${c.id}`)]);
    kb.push(BACK);
    const sent = await this.show(adminId, chunks(lines.join("\n"))[0], kb, cq);
    if (sent?.message_id) this.noteRef(adminId, sent.message_id, c.id);
    else if (cq?.message) this.noteRef(adminId, cq.message.message_id, c.id);
  },

  async sendTakeoverHint(conv, adminId) {
    const last = this.pendingClientMessages(conv).map((m) => m.text).join("\n");
    const lines = [
      `✋ Вы ведёте диалог с <b>${esc(conv.client.name)}</b>. Бот в этом чате молчит.`,
      conv.kind === "business"
        ? "Пишите сюда — я отправлю клиенту от вашего имени. Можно отвечать и прямо из своего Telegram."
        : "Пишите сюда — я передам клиенту.",
      "Чтобы ответить в другой чат, ответьте реплаем на его сообщение.",
    ];
    if (last) lines.push("", `Последнее от клиента: «${esc(truncate(last, 800))}»`);
    await this.notifyAdmin(
      adminId,
      lines.join("\n"),
      [[btn("🤖 Вернуть боту", `c:bot:${conv.id}`), btn("✅ Завершить", `c:close:${conv.id}`)]],
      conv.id
    );
  },

  // ---------- записи и свободное время ----------

  async showBookings(adminId, cq) {
    const today = nowParts(this.shop.timezone, this.now()).date;
    const list = upcomingBookings(this.state, this.shop, { days: 7, now: this.now() });
    const lines = ["📅 <b>Записи на 7 дней</b>"];
    if (!list.length) lines.push("", "Пока записей нет.");
    let day = null;
    for (const b of list) {
      if (b.date !== day) {
        day = b.date;
        lines.push("", `<b>${esc(fmtDateRelative(b.date, today))}</b>`);
      }
      lines.push(
        `${fmtTime(b.start)}–${fmtTime(b.start + b.durationMin)} · ${esc(b.serviceName)} · ${esc(b.client?.name || "")}${
          b.client?.phone ? ` (${esc(b.client.phone)})` : ""
        } · ${esc(b.staffName)} · ${b.id}`
      );
    }
    const kb = list.slice(0, 10).map((b) => [btn(`❌ ${b.id} · ${fmtTime(b.start)} ${truncate(b.client?.name || "", 20)}`, `b:cx:${b.id}`)]);
    kb.push(BACK);
    return this.show(adminId, chunks(lines.join("\n"))[0], kb, cq);
  },

  async showSlots(adminId, cq) {
    const shop = this.shop;
    const today = nowParts(shop.timezone, this.now()).date;
    const lines = [`🕐 <b>Свободное время</b> (слот ${shop.slotMinutes} мин)`];
    for (const date of [today, addDays(today, 1)]) {
      lines.push("", `<b>${esc(fmtDateRelative(date, today))}</b>`);
      for (const st of shop.staff) {
        const times = freeStarts(this.state, shop, { date, staffId: st.id, slots: 1, now: this.now() }).map(fmtTime);
        lines.push(`${esc(st.name)}: ${times.length ? times.join(", ") : "нет свободного времени"}`);
      }
    }
    if (shop.demoBusy) lines.push("", "<i>Включена демо-занятость: часть окон занята «для вида». Выключить — в настройках.</i>");
    return this.show(adminId, chunks(lines.join("\n"))[0], [BACK], cq);
  },

  async adminCancelBooking(adminId, id) {
    const r = cancelBooking(this.state, id, { by: "admin", now: this.now() });
    if (!r.ok) return this.consoleApi.sendMessage(adminId, r.error);
    const b = r.booking;
    const today = nowParts(this.shop.timezone, this.now()).date;
    this.save();
    const conv = this.conv(b.client?.key);
    if (conv) {
      await this.deliver(
        conv,
        `К сожалению, мастеру пришлось отменить вашу запись: ${b.serviceName}, ${bookingLabel(b, today)}. Подобрать другое время?`,
        "admin"
      );
    }
    return this.consoleApi.sendMessage(adminId, `Запись ${b.id} отменена${conv ? ", клиенту отправлено сообщение" : ""}.`);
  },

  // ---------- настройки точки ----------

  async showSettings(adminId, cq) {
    const s = this.shop;
    const lines = [
      "⚙️ <b>Настройки точки</b>",
      "",
      renderSummary(s),
      "",
      "Загрузите свою точку с Яндекс.Карт или просто напишите, что изменить: услуги, цены, график, любые факты для ответов клиентам.",
    ];
    const kb = [
      [btn("🗺 Загрузить с Яндекс.Карт", "s:yandex")],
      [btn("✏️ Изменить словами или фото", "s:edit")],
      [btn("📚 Знания", "s:kn"), btn("📋 Всё целиком", "s:all")],
      [btn(`⏱ Слот: ${s.slotMinutes} мин`, "s:slot"), btn(`🎲 Демо-занятость: ${s.demoBusy ? "вкл" : "выкл"}`, "s:busy")],
    ];
    if (this.role(adminId) === "owner") kb.push([btn("🧹 Сбросить точку", "s:reset")]);
    kb.push(BACK);
    return this.show(adminId, lines.join("\n"), kb, cq);
  },

  async showKnowledge(adminId, cq) {
    const k = this.shop.knowledge;
    const lines = ["📚 <b>Знания</b> — факты, которыми бот пользуется в ответах", ""];
    if (!k.length) lines.push("Пока пусто.");
    k.forEach((n) => lines.push(`<b>${n.id}</b>. ${esc(truncate(n.text, 250))}`));
    const kb = [[btn("➕ Добавить заметку", "s:kadd")]];
    for (let i = 0; i < k.length && i < 24; i += 4) {
      kb.push(k.slice(i, i + 4).map((n) => btn(`🗑 ${n.id}`, `s:kdel:${n.id}`)));
    }
    kb.push([btn("◀️ Настройки", "m:settings")]);
    return this.show(adminId, chunks(lines.join("\n"))[0], kb, cq);
  },

  async showPreview(adminId, shop, changes) {
    const lines = ["👀 <b>Проверьте, что получилось</b>", "", renderFull(shop)];
    if (changes?.length) {
      lines.push("", "<b>На что обратить внимание</b>");
      for (const c of changes.slice(0, 15)) lines.push(`• ${esc(c)}`);
    }
    lines.push("", "Можно написать поправку словами — я обновлю черновик.");
    return this.sendLong(adminId, lines.join("\n"), [
      [btn("✅ Сохранить", "s:save"), btn("❌ Отменить", "s:cancel")],
    ]);
  },

  // Подробности сбоя импорта (HTML) — для владельца бота
  importFailureDetails(r) {
    const lines = [`<b>Причина:</b> ${esc(r.reason || "неизвестна")}`];
    if (r.details?.length) {
      lines.push("<b>Что было:</b>");
      for (const d of r.details.slice(0, 10)) lines.push(`• ${esc(truncate(d, 500))}`);
    }
    return lines.join("\n");
  },

  setMode(a, mode, extra = {}) {
    a.mode = mode;
    Object.assign(a, extra);
    this.save();
  },

  // Ввод для настройки копим ~1,5 с: альбом из нескольких фото приходит отдельными сообщениями
  bufferSetupInput(a, msg, api) {
    const buf = this.setupBuffers.get(a.id) || { items: [], timer: null };
    const photo = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;
    const imageDoc = msg.document && /^image\//.test(msg.document.mime_type || "") ? msg.document.file_id : null;
    buf.items.push({ text: msg.text || msg.caption || "", file: photo || imageDoc, mime: msg.document?.mime_type, api });
    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      buf.timer = null;
      this.setupBuffers.delete(a.id);
      this.run(() => this.processSetup(a.id, buf.items));
    }, this.cfg.debounceMs);
    this.setupBuffers.set(a.id, buf);
  },

  async processSetup(adminId, items) {
    const a = this.admin(adminId);
    if (!a || !a.mode) return;
    const text = items.map((i) => i.text).filter(Boolean).join("\n").trim();
    const say = (t, kb) => this.sendHtml(adminId, t, kb ? { reply_markup: { inline_keyboard: kb } } : {});
    const imageList = [];
    for (const it of items.filter((i) => i.file)) {
      try {
        const buf = await it.api.downloadFile(it.file);
        imageList.push({ mediaType: it.mime && /^image\/(png|webp|gif)$/.test(it.mime) ? it.mime : "image/jpeg", data: buf.toString("base64") });
      } catch (e) {
        this.log.warn("Фото:", e.message);
      }
    }
    if (!text && !imageList.length) return say("Пришлите текст или фото.");

    if (a.mode === "await_note") {
      let note = text;
      if (imageList.length) {
        await say("⏳ Читаю изображение…");
        const r = await noteFromImages({ llm: this.llm, cfg: this.cfg, imageList, caption: text });
        if (!r.ok) return say(`Не получилось: ${esc(r.reason)}. Пришлите текстом.`);
        note = r.text;
      }
      this.shop.knowledge.push({ id: null, text: note.slice(0, 2000) });
      this.state.shop = require("./shop").normalizeShop(this.shop);
      this.setMode(a, null);
      await say(`📚 Запомнил: «${esc(truncate(note, 300))}»`);
      return this.showKnowledge(adminId);
    }

    const url = extractYandexUrl(text);
    if (url) {
      await say("⏳ Загружаю карточку с Яндекс.Карт и разбираю услуги… Обычно это до минуты.");
      const r = await importFromYandex({ llm: this.llm, cfg: this.cfg, url, prevShop: this.shop, fetchImpl: this.fetchImpl, log: this.log });
      if (!r.ok) {
        this.setMode(a, "await_edit", { freshBase: true, pending: null });
        // Техническая причина — только владельцу бота. Мастер видит просьбу прислать данные иначе.
        const isOwner = this.role(adminId) === "owner";
        await say(
          `😕 Не получилось прочитать карточку с Яндекс.Карт.\n\nПришлите скриншоты карточки и прайса из Яндекс.Карт (можно несколько) или просто перечислите текстом: название, адрес, график и услуги с ценами и длительностью. Разберу сам.${
            isOwner ? `\n\n<i>Подробности видны только владельцу бота.</i>\n${this.importFailureDetails(r)}` : ""
          }`,
          [[btn("❌ Отменить", "s:cancel")]]
        );
        const who = `${esc(a.name || "Мастер")}${a.username ? ` @${esc(a.username)}` : ""} (id ${a.id})`;
        return this.notifyOwners(
          [
            "⚠️ <b>Не получилось загрузить точку с Яндекс.Карт</b>",
            `👤 ${who}`,
            `🗺 ${esc(url)}`,
            "",
            this.importFailureDetails(r),
            "",
            "<i>Мастеру предложено прислать скриншоты или текст. Причину он не видит.</i>",
          ].join("\n"),
          { except: adminId }
        );
      }
      this.setMode(a, "review", { pending: r.shop, freshBase: false });
      return this.showPreview(adminId, r.shop, r.changes);
    }

    const base = a.pending || (a.freshBase && this.shop.demo ? emptyShop(this.shop) : this.shop);
    await say("⏳ Обновляю данные…");
    const r = await updateFromMessage({ llm: this.llm, cfg: this.cfg, shop: base, text, imageList });
    if (!r.ok) return say(`😕 Не получилось: ${esc(r.reason)}. Попробуйте ещё раз или сформулируйте иначе.`);
    if (!r.changes.length && !a.pending && JSON.stringify(r.shop.services) === JSON.stringify(base.services)) {
      return say("Кажется, менять нечего. Напишите, что именно поправить, или нажмите «Отменить».", [[btn("❌ Отменить", "s:cancel")]]);
    }
    this.setMode(a, "review", { pending: r.shop, freshBase: false });
    return this.showPreview(adminId, r.shop, r.changes);
  },

  async onSettingsAction(adminId, act, arg, cq) {
    const a = this.admin(adminId);
    const say = (t, kb) => this.sendHtml(adminId, t, kb ? { reply_markup: { inline_keyboard: kb } } : {});
    const cancelKb = [[btn("❌ Отменить", "s:cancel")]];
    switch (act) {
      case "yandex":
        this.setMode(a, "await_yandex", { freshBase: true, pending: null });
        return say(
          "🗺 Пришлите ссылку на вашу точку в Яндекс.Картах.\nВ приложении: карточка организации → «Поделиться» → «Скопировать ссылку».\n\nЯ заберу название, адрес, график, телефон и прайс. Если Яндекс не пустит, подойдут скриншоты или текст.",
          [[btn("✏️ Опишу словами", "s:edit"), btn("❌ Отменить", "s:cancel")]]
        );
      case "edit":
        this.setMode(a, "await_edit", { pending: a.pending || null });
        return say(
          "✏️ Напишите, что изменить или что боту нужно знать. Можно прислать фото прайса или скриншоты.\n\nНапример:\n• «по воскресеньям выходной»\n• «стрижка теперь 2000 ₽, длится час»\n• «добавь услугу укладка 700 ₽ на 30 минут»\n• «есть парковка во дворе, оплата только картой»",
          cancelKb
        );
      case "kn":
        return this.showKnowledge(adminId, cq);
      case "kadd":
        this.setMode(a, "await_note");
        return say("📚 Пришлите заметку текстом или фото — сохраню как есть. Например: «Работаем без перерыва», «Скидка 10% студентам по студенческому».", cancelKb);
      case "kdel": {
        const before = this.shop.knowledge.length;
        this.shop.knowledge = this.shop.knowledge.filter((k) => k.id !== arg);
        if (this.shop.knowledge.length !== before) this.save();
        return this.showKnowledge(adminId, cq);
      }
      case "all":
        return this.sendLong(adminId, renderFull(this.shop), [[btn("◀️ Настройки", "m:settings")]]);
      case "slot": {
        const options = [15, 20, 30, 45, 60];
        const s = this.shop;
        const next = options[(options.indexOf(s.slotMinutes) + 1) % options.length] || 30;
        // Длительность услуг сохраняем: пересчитываем число слотов
        for (const sv of s.services) sv.slots = Math.max(1, Math.ceil((sv.slots * s.slotMinutes) / next));
        s.slotMinutes = next;
        this.save();
        return this.showSettings(adminId, cq);
      }
      case "busy":
        this.shop.demoBusy = !this.shop.demoBusy;
        this.save();
        return this.showSettings(adminId, cq);
      case "reset":
        if (this.role(adminId) !== "owner") return;
        return this.show(
          adminId,
          "🧹 <b>Сбросить точку?</b>\nДанные точки вернутся к демо, удалятся записи, переписки и доступы мастеров (кроме владельцев). Так бот можно передать другому мастеру.",
          [[btn("Да, сбросить", "s:reset2"), btn("Нет", "m:settings")]],
          cq
        );
      case "reset2": {
        if (this.role(adminId) !== "owner") return;
        const st = this.state;
        st.shop = demoShop();
        st.bookings = [];
        st.conversations = {};
        this.keyIndex.clear();
        st.consoleRefs = {};
        st.invites = {};
        for (const [id, adm] of Object.entries(st.admins)) {
          if (adm.role !== "owner" && !this.cfg.adminIds.includes(Number(id))) delete st.admins[id];
          else Object.assign(adm, { mode: null, pending: null, relayTo: null });
        }
        for (const [id, c] of Object.entries(st.businessConnections)) if (!this.role(c.userId)) delete st.businessConnections[id];
        this.save();
        return this.show(adminId, "✅ Точка сброшена на демо-данные. Пригласите нового мастера — он настроит свою точку сам.", [
          [btn("👤 Пригласить мастера", "m:invite")],
          BACK,
        ], cq);
      }
      case "save": {
        if (!a.pending) return say("Нечего сохранять.");
        this.state.shop = { ...a.pending, updatedAt: this.now() };
        this.setMode(a, null, { pending: null, freshBase: false });
        await say("✅ Сохранено. Бот уже отвечает клиентам по новым данным.");
        return this.showSettings(adminId);
      }
      case "cancel":
        this.setMode(a, null, { pending: null, freshBase: false });
        return say("Отменено, данные точки не менялись.", [[btn("⚙️ Настройки", "m:settings"), btn("💈 Меню", "m:panel")]]);
    }
  },

  // ---------- доступы ----------

  async createInvite(adminId) {
    const code = randomCode(8);
    this.state.invites[code] = { role: "admin", by: adminId, createdAt: this.now(), expiresAt: this.now() + 7 * DAY };
    this.save();
    const link = `https://t.me/${this.consoleMe.username}?start=adm_${code}`;
    return this.sendHtml(
      adminId,
      `👤 <b>Приглашение для мастера</b>\n\nОтправьте эту ссылку мастеру. По ней он получит панель: переписки, записи и настройку своей точки — Яндекс.Карты, услуги и любые «знания».\nСсылка одноразовая, действует 7 дней.\n\n${esc(link)}`
    );
  },

  async acceptInvite(user, code, api) {
    const inv = this.state.invites[code];
    if (!inv || inv.usedBy || inv.expiresAt < this.now()) {
      return api.sendMessage(user.id, "Ссылка-приглашение недействительна или уже использована. Попросите у владельца новую.");
    }
    inv.usedBy = user.id;
    const a = this.ensureAdmin(user, inv.role || "admin");
    this.setMode(a, "await_yandex", { freshBase: true, pending: null });
    await this.setCommands().catch(() => {});
    for (const o of Object.values(this.state.admins).filter((x) => x.role === "owner")) {
      await this.notifyAdmin(o.id, `👤 ${esc(userName(user))} принял приглашение и стал мастером.`);
    }
    return this.sendHtml(
      user.id,
      `Добро пожаловать, ${esc(user.first_name || "мастер")}! 💈\n\nЯ онлайн-администратор: отвечаю клиентам 24/7, показываю свободное время и записываю. Если я не уверен или что-то сломалось — сразу зову вас.\n\n<b>Давайте настроим вашу точку.</b> Пришлите ссылку на ваш барбершоп в Яндекс.Картах — я сам заберу адрес, график и прайс. Или нажмите «Опишу словами».`,
      { reply_markup: { inline_keyboard: [[btn("✏️ Опишу словами", "s:edit"), btn("💈 Меню", "m:panel")]] } }
    );
  },

  async claimOwner(user, code, api) {
    if (!this.state.ownerClaimCode || code !== this.state.ownerClaimCode) {
      return api.sendMessage(user.id, "Ссылка владельца недействительна.");
    }
    this.state.ownerClaimCode = null;
    this.ensureAdmin(user, "owner");
    this.state.admins[user.id].role = "owner";
    this.save();
    await this.setCommands().catch(() => {});
    await this.consoleApi.sendMessage(
      user.id,
      "👑 Готово, вы владелец бота. Отсюда можно пригласить мастера: он получит панель и сам настроит точку.",
      { reply_markup: { inline_keyboard: [[btn("👤 Пригласить мастера", "m:invite")], [btn("💈 Панель", "m:panel")]] } }
    );
  },

  helpText() {
    return [
      "❓ <b>Как это работает</b>",
      "",
      "• Бот отвечает клиентам: услуги, цены, адрес, свободное время, запись. Каждая услуга занимает 1–4 слота подряд.",
      "• Если бот не уверен в ответе, клиент прислал фото/голосовое или ИИ не ответил вовремя — бот молчит и присылает вам карточку с черновиком. Можно отправить черновик, ответить самому или дать боту попробовать ещё раз.",
      "• «Перехватить» — бот замолкает в этом чате, а ваши сообщения отсюда уходят клиенту. «Вернуть боту» — бот снова отвечает сам.",
      "• Ответить реплаем на уведомление — сообщение уйдёт этому клиенту.",
      "• Новые записи и отмены приходят сюда же.",
      "",
      "<b>Telegram Business (рекомендуется)</b>",
      `Подключите бота к своему аккаунту: Настройки → Telegram для бизнеса → Чат-боты → @${esc(this.me?.username || "бот")}. Тогда бот отвечает клиентам в ваших личных чатах, а сообщения, на которые он не ответил, <b>остаются непрочитанными</b>. Ответите сами — бот в этом чате замолчит.`,
      "",
      "<b>Настройки точки</b>: ссылка на Яндекс.Карты, правки словами или фото прайса, заметки-«знания».",
    ].join("\n");
  },

  // ---------- входящие от мастера ----------

  async onAdminMessage(msg, api, { fallthrough }) {
    const uid = msg.from.id;
    const a = this.admin(uid);
    if (msg.from.first_name) a.name = userName(msg.from);
    if (msg.from.username) a.username = msg.from.username;
    const text = msg.text || "";
    const cmd = (text.match(/^\/([a-z_]+)/i) || [])[1];

    if (cmd) {
      switch (cmd.toLowerCase()) {
        case "start":
        case "panel":
        case "menu":
          this.setMode(a, null);
          await this.showPanel(uid, null, { hint: !this.separateConsole });
          return true;
        case "chats":
          await this.showList(uid, "current");
          return true;
        case "bookings":
          await this.showBookings(uid);
          return true;
        case "settings":
          await this.showSettings(uid);
          return true;
        case "help":
          await this.show(uid, this.helpText(), [BACK]);
          return true;
        case "cancel":
          this.setMode(a, null, { pending: null, freshBase: false });
          await api.sendMessage(uid, "Отменено.");
          return true;
        default:
          if (!fallthrough) {
            await this.showPanel(uid);
            return true;
          }
          return false;
      }
    }

    if (a.mode) {
      this.bufferSetupInput(a, msg, api);
      return true;
    }

    const ref = msg.reply_to_message && this.state.consoleRefs[`${uid}:${msg.reply_to_message.message_id}`];
    const target = (ref && this.conv(ref)) || (a.relayTo && this.conv(a.relayTo));
    if (target) {
      if (this.isOwnChat(target, uid)) {
        await api.sendMessage(uid, "Это ваш собственный чат с ботом — в него нельзя писать как мастер. Проверьте с другого аккаунта или подключите отдельного бота для панели.");
        return true;
      }
      await this.relay(uid, target, msg, api);
      return true;
    }
    if (!fallthrough) {
      await this.consoleApi.sendMessage(
        uid,
        "Сейчас вы не ведёте диалог. Откройте переписку в панели и нажмите «Перехватить» или ответьте реплаем на уведомление.",
        { reply_markup: { inline_keyboard: [BACK] } }
      );
      return true;
    }
    return false;
  },

  async onCallback(cq, source) {
    const uid = cq.from.id;
    const api = this.apiFor(source);
    const answer = (text, alert = false) =>
      api.call("answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
    if (!this.role(uid)) return answer("Нет доступа");
    const [ns, act, arg] = String(cq.data || "").split(":");
    const a = this.admin(uid);

    if (ns === "m") {
      await answer();
      if (act === "panel") return this.showPanel(uid, cq);
      if (act === "list") return this.showList(uid, arg, cq);
      if (act === "bookings") return this.showBookings(uid, cq);
      if (act === "slots") return this.showSlots(uid, cq);
      if (act === "settings") return this.showSettings(uid, cq);
      if (act === "help") return this.show(uid, this.helpText(), [BACK], cq);
      if (act === "notify") {
        a.notify = a.notify === false;
        this.save();
        return this.showPanel(uid, cq);
      }
      if (act === "invite" && this.role(uid) === "owner") return this.createInvite(uid);
      return;
    }

    if (ns === "s") {
      await answer();
      return this.onSettingsAction(uid, act, arg, cq);
    }

    if (ns === "b") {
      const b = this.state.bookings.find((x) => x.id === arg);
      if (!b || b.status !== "active") return answer("Запись уже отменена или не найдена");
      await answer();
      if (act === "cx") {
        const today = nowParts(this.shop.timezone, this.now()).date;
        return this.sendHtml(
          uid,
          `Отменить запись ${b.id}: ${esc(b.serviceName)}, ${esc(bookingLabel(b, today))}, ${esc(b.client?.name || "")}? Клиенту придёт сообщение.`,
          { reply_markup: { inline_keyboard: [[btn("Да, отменить", `b:cx2:${b.id}`), btn("Нет", "m:bookings")]] } }
        );
      }
      if (act === "cx2") return this.adminCancelBooking(uid, b.id);
      return;
    }

    if (ns === "c") {
      const conv = this.conv(arg);
      if (!conv) return answer("Переписка не найдена");
      switch (act) {
        case "open":
          await answer();
          return this.showChat(uid, conv.id, cq);
        case "take":
          if (this.isOwnChat(conv, uid)) return answer("Это ваш собственный чат с ботом — перехватить его нельзя", true);
          await answer("Диалог ваш");
          return this.takeover(conv, uid);
        case "write":
          a.relayTo = conv.id;
          this.save();
          await answer("Пишите — сообщения уйдут этому клиенту");
          return this.sendTakeoverHint(conv, uid);
        case "bot": {
          await answer("Бот снова ведёт диалог");
          await this.returnToBot(conv);
          const kb = conv.lastQA ? [[btn("📚 Запомнить мой ответ", `c:learn:${conv.id}`)]] : null;
          return this.notifyAdmin(uid, `🤖 Бот снова ведёт диалог с <b>${esc(conv.client.name)}</b>.`, kb, conv.id);
        }
        case "send": {
          if (conv.status !== "waiting" || !conv.handoff?.draft) return answer("Черновика уже нет");
          const draft = conv.handoff.draft;
          conv.status = "bot";
          conv.handoff = null;
          this.save();
          await answer("Отправляю");
          await this.deliver(conv, draft, "bot");
          return this.notifyAdmin(uid, `✅ Черновик отправлен <b>${esc(conv.client.name)}</b>.`, null, conv.id);
        }
        case "retry":
          if (conv.status === "admin" && conv.handledBy !== uid) return answer("Этот диалог ведёт другой мастер", true);
          await answer("Бот пробует ещё раз");
          await this.returnToBot(conv, { answerPending: false });
          return this.run(() => this.processConv(conv.id));
        case "close":
          conv.session = { ...(conv.session || {}), closed: true };
          if (conv.status !== "bot") await this.returnToBot(conv, { answerPending: false });
          this.save();
          await answer("Диалог завершён");
          return this.showChat(uid, conv.id, cq);
        case "learn": {
          if (!conv.lastQA) return answer("Нечего запоминать");
          const { q, a: ans } = conv.lastQA;
          this.shop.knowledge.push({ id: null, text: `Клиент спросил: «${truncate(q, 500)}». Ответ мастера: «${truncate(ans, 1000)}».` });
          this.state.shop = require("./shop").normalizeShop(this.shop);
          conv.lastQA = null;
          this.save();
          return answer("Запомнил — в следующий раз бот ответит сам", true);
        }
      }
      return answer();
    }
    return answer();
  },
};

function install(App) {
  Object.assign(App.prototype, methods);
}

module.exports = { install, chunks };
