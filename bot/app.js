// Ядро бота: маршрутизация апдейтов, разговоры с клиентами, ответы ИИ,
// передача мастеру, Telegram Business, напоминания. Панель мастера — в console.js.
const { generateReply } = require("./assistant");
const { typingDuration, splitReply } = require("./typing");
const { upcomingBookings, bookingLabel, minutesUntilStart } = require("./schedule");
const { nowParts } = require("./time");
const { esc, truncate, sleep: realSleep, randomCode, userName } = require("./util");

const HOUR = 3600000;

class App {
  constructor({ cfg, store, api, consoleApi, llm, log = console, now = () => Date.now(), sleep = realSleep, fetchImpl }) {
    this.cfg = cfg;
    this.store = store;
    this.api = api; // бот для клиентов
    this.consoleApi = consoleApi || api; // бот с панелью мастера (может быть тем же)
    this.separateConsole = Boolean(consoleApi && consoleApi !== api);
    this.llm = llm;
    this.log = log;
    this.now = now;
    this.sleep = sleep;
    this.fetchImpl = fetchImpl;
    this.timers = new Map(); // id разговора -> таймер «дождаться, пока клиент допишет»
    this.busy = new Set(); // разговоры, по которым сейчас думает ИИ
    this.setupBuffers = new Map(); // id мастера -> накопленный ввод для настройки
    this.tasks = new Set();
    this.keyIndex = new Map();
    for (const c of Object.values(this.state.conversations)) this.keyIndex.set(c.key, c.id);
  }

  get state() {
    return this.store.state;
  }
  get shop() {
    return this.state.shop;
  }
  save() {
    this.store.save();
  }

  // ---------- запуск ----------

  async init() {
    this.me = await this.api.getMe();
    this.consoleMe = this.separateConsole ? await this.consoleApi.getMe() : this.me;
    for (const id of this.cfg.ownerIds) this.ensureAdmin({ id }, "owner");
    for (const id of this.cfg.adminIds) if (!this.state.admins[id]) this.ensureAdmin({ id }, "admin");
    const hasOwner = Object.values(this.state.admins).some((a) => a.role === "owner");
    if (!hasOwner) {
      this.state.ownerClaimCode = this.state.ownerClaimCode || randomCode(9);
      this.log.info(
        `\n👑 Владельца ещё нет. Откройте ссылку, чтобы стать владельцем бота:\n   https://t.me/${this.consoleMe.username}?start=own_${this.state.ownerClaimCode}\n`
      );
    }
    this.save();
    await this.setCommands().catch((e) => this.log.warn("setMyCommands:", e.message));
  }

  async setCommands() {
    const adminCommands = [
      { command: "panel", description: "Панель мастера" },
      { command: "chats", description: "Текущие переписки" },
      { command: "bookings", description: "Записи" },
      { command: "settings", description: "Настройки точки и знания" },
      { command: "help", description: "Как это работает" },
    ];
    if (this.separateConsole) {
      await this.consoleApi.call("setMyCommands", { commands: adminCommands });
    } else {
      for (const a of Object.values(this.state.admins)) {
        await this.api
          .call("setMyCommands", { commands: adminCommands, scope: { type: "chat", chat_id: a.id } })
          .catch(() => {});
      }
    }
  }

  // Фоновые задачи (нужно тестам, чтобы дождаться тишины)
  run(fn) {
    const p = Promise.resolve()
      .then(fn)
      .catch((e) => this.log.error("Ошибка задачи:", e));
    this.tasks.add(p);
    p.finally(() => this.tasks.delete(p));
    return p;
  }

  async idle(maxMs = 20000) {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      if (!this.tasks.size && !this.timers.size && !this.busy.size && ![...this.setupBuffers.values()].some((b) => b.timer)) return;
      await Promise.race([...this.tasks, realSleep(10)]);
    }
    throw new Error("idle timeout");
  }

  // ---------- роли ----------

  role(userId) {
    const a = this.state.admins[userId];
    if (this.cfg.ownerIds.includes(Number(userId)) || a?.role === "owner") return "owner";
    if (this.cfg.adminIds.includes(Number(userId)) || a) return "admin";
    return null;
  }

  ensureAdmin(user, role) {
    const prev = this.state.admins[user.id] || {};
    const a = {
      notify: true,
      mode: null,
      relayTo: null,
      pending: null,
      joinedAt: this.now(),
      ...prev,
      id: user.id,
      role: prev.role === "owner" ? "owner" : role,
      name: user.first_name ? userName(user) : prev.name || "",
      username: user.username || prev.username || "",
    };
    this.state.admins[user.id] = a;
    this.save();
    return a;
  }

  admin(userId) {
    if (!this.role(userId)) return null;
    return this.state.admins[userId] || this.ensureAdmin({ id: userId }, this.role(userId));
  }

  // ---------- маршрутизация ----------

  async handleUpdate(u, source = "main") {
    if (u.business_connection) return this.onBusinessConnection(u.business_connection);
    if (u.business_message) return this.onBusinessMessage(u.business_message);
    if (u.callback_query) return this.onCallback(u.callback_query, source);
    if (u.message) return this.onMessage(u.message, source);
  }

  apiFor(source) {
    return source === "console" ? this.consoleApi : this.api;
  }

  async onMessage(msg, source) {
    if (msg.chat?.type !== "private" || !msg.from || msg.from.is_bot) return;
    const uid = msg.from.id;
    const text = msg.text || "";
    const api = this.apiFor(source);

    if (text.startsWith("/start ")) {
      const payload = text.slice(7).trim();
      if (payload.startsWith("own_")) return this.claimOwner(msg.from, payload.slice(4), api);
      if (payload.startsWith("adm_")) return this.acceptInvite(msg.from, payload.slice(4), api);
      if (payload.startsWith("bizChat") && this.role(uid)) return this.openBusinessChat(uid, payload.slice(7));
    }

    const isAdmin = Boolean(this.role(uid));
    if (source === "console") {
      if (!isAdmin) {
        await api.sendMessage(uid, "Это панель мастера. Доступ выдаёт владелец бота по ссылке-приглашению.");
        return;
      }
      await this.onAdminMessage(msg, api, { fallthrough: false });
      return;
    }
    if (isAdmin && !this.separateConsole) {
      const handled = await this.onAdminMessage(msg, api, { fallthrough: true });
      if (handled) return;
    }
    return this.onClientMessage(msg, { kind: "direct", chatId: msg.chat.id });
  }

  // ---------- разговоры ----------

  convByKey(key) {
    const id = this.keyIndex.get(key);
    return id ? this.state.conversations[id] : null;
  }

  conv(id) {
    return this.state.conversations[id] || null;
  }

  getConv(transport, user) {
    const key = transport.kind === "direct" ? `d:${transport.chatId}` : `b:${transport.connId}:${transport.chatId}`;
    let c = this.convByKey(key);
    if (!c) {
      this.state.seq.conv = (this.state.seq.conv || 0) + 1;
      const id = String(this.state.seq.conv);
      c = {
        id,
        key,
        kind: transport.kind,
        chatId: transport.chatId,
        connId: transport.connId || null,
        client: {},
        status: "bot", // bot | waiting | admin
        handledBy: null,
        handoff: null,
        messages: [],
        session: { startedAt: this.now(), booked: false, closed: false },
        unread: [],
        sentMids: [],
        createdAt: this.now(),
        updatedAt: this.now(),
        lastClientAt: 0,
      };
      this.state.conversations[id] = c;
      this.keyIndex.set(key, id);
    }
    if (user && user.id) {
      c.client = { id: user.id, name: userName(user), username: user.username || "" };
    }
    return c;
  }

  pushMessage(conv, m) {
    conv.msgCount = (conv.msgCount || conv.messages.length) + 1;
    conv.messages.push({ at: this.now(), ...m });
    if (conv.messages.length > 100) conv.messages.splice(0, conv.messages.length - 100);
    conv.updatedAt = this.now();
  }

  pendingClientMessages(conv) {
    const out = [];
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i];
      if (m.role !== "client") break;
      out.unshift(m);
    }
    return out;
  }

  isOwnChat(conv, adminId) {
    return conv.kind === "direct" && Number(conv.chatId) === Number(adminId);
  }

  // Что прислал клиент: текст или то, что бот разобрать не может
  messageContent(msg) {
    const caption = msg.caption ? ` ${msg.caption}` : "";
    if (msg.text) return { text: msg.text };
    if (msg.contact) return { text: `Мой телефон: ${msg.contact.phone_number}`, phone: msg.contact.phone_number };
    if (msg.sticker) return { text: `[стикер ${msg.sticker.emoji || ""}]`.replace(" ]", "]") };
    if (msg.location) return { text: "[отправил геолокацию]" };
    const kinds = [
      ["photo", "фото"],
      ["voice", "голосовое"],
      ["video_note", "видеосообщение"],
      ["video", "видео"],
      ["audio", "аудио"],
      ["document", "файл"],
      ["animation", "гифку"],
    ];
    for (const [field, label] of kinds) {
      if (msg[field]) return { text: `[${label}]${caption}`, needsHuman: label };
    }
    return { text: "[сообщение]", needsHuman: "сообщение без текста" };
  }

  // ---------- клиент пишет ----------

  async onClientMessage(msg, transport) {
    const conv = this.getConv(transport, msg.from);
    const now = this.now();
    if (!conv.session || conv.session.closed || now - conv.updatedAt > 12 * HOUR) {
      conv.session = { startedAt: now, booked: false, closed: false };
    }

    if (transport.kind === "direct" && /^\/start(\s|$)/.test(msg.text || "")) {
      this.pushMessage(conv, { role: "client", text: "/start", mid: msg.message_id, service: true });
      this.save();
      if (conv.status === "bot") this.run(() => this.deliver(conv, this.greeting(), "bot"));
      return;
    }

    const content = this.messageContent(msg);
    if (content.phone) conv.phone = content.phone;
    this.pushMessage(conv, { role: "client", text: content.text, mid: msg.message_id, needsHuman: content.needsHuman || null });
    conv.lastClientAt = now;
    if (transport.kind === "business") conv.unread.push(msg.message_id);
    this.save();

    if (conv.status === "admin") return this.run(() => this.forwardToHandler(conv, content.text));
    if (conv.status === "waiting") return this.run(() => this.notifyMoreFromClient(conv, content.text));
    this.schedule(conv.id);
  }

  greeting() {
    const s = this.shop;
    if (s.greeting) return s.greeting;
    return `Здравствуйте! Это ${s.name || "наш барбершоп"} 💈 Подскажу по услугам и ценам и запишу на удобное время. Чем могу помочь?${
      s.demo ? "\n\nЭто демо-версия: данные точки тестовые." : ""
    }`;
  }

  schedule(id, delay = this.cfg.debounceMs) {
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.run(() => this.processConv(id));
      }, delay)
    );
  }

  cancelScheduled(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  async processConv(id) {
    if (this.busy.has(id)) return; // текущий проход сам подхватит новые сообщения
    this.busy.add(id);
    let again = false;
    try {
      for (let round = 0; round < 4; round++) {
        const conv = this.conv(id);
        if (!conv || conv.status !== "bot") return;
        const pending = this.pendingClientMessages(conv).filter((m) => !m.service);
        if (!pending.length) return;

        const odd = pending.find((m) => m.needsHuman);
        if (odd) {
          await this.handoff(conv, { reason: `клиент прислал ${odd.needsHuman} — бот такое не разбирает`, draft: "" });
          return;
        }

        // Защита от спама: не больше LLM_CALLS_PER_HOUR ответов ИИ в час на одного клиента
        conv.llmCalls = (conv.llmCalls || []).filter((t) => this.now() - t < HOUR);
        if (conv.llmCalls.length >= this.cfg.llmCallsPerHour) {
          await this.handoff(conv, { reason: "клиент пишет слишком часто — бот взял паузу", draft: "" });
          return;
        }
        conv.llmCalls.push(this.now());

        const seen = conv.msgCount;
        const result = await generateReply({ llm: this.llm, cfg: this.cfg, state: this.state, shop: this.shop, conv, now: this.now(), log: this.log });
        for (const ef of result.effects) await this.onEffect(conv, ef);
        this.save();
        if (conv.status !== "bot") return; // мастер перехватил, пока ИИ думал

        // Клиент дописал, пока ИИ думал, — ответ мог устареть; переспросим, если ничего не записали
        if (conv.msgCount !== seen && !result.effects.length && round < 3) continue;

        if (result.kind !== "reply") {
          await this.handoff(conv, {
            reason: result.reason,
            draft: result.draft || "",
            confidence: result.confidence,
            error: result.kind === "error",
          });
          return;
        }
        await this.deliver(conv, result.text, "bot");
        // следующий круг подхватит то, что клиент написал, пока бот «печатал»
      }
      again = true;
    } finally {
      this.busy.delete(id);
      if (again) this.schedule(id);
    }
  }

  // ---------- отправка клиенту ----------

  conn(conv) {
    return conv.kind === "business" ? this.state.businessConnections[conv.connId] : null;
  }

  transportExtra(conv) {
    return conv.kind === "business" ? { business_connection_id: conv.connId } : {};
  }

  // В Telegram Business сообщение остаётся непрочитанным, пока мы сами не отметим его.
  // Отмечаем только когда точно отвечаем.
  async markRead(conv) {
    if (conv.kind !== "business" || !conv.unread.length) return;
    const conn = this.conn(conv);
    const lastId = conv.unread[conv.unread.length - 1];
    conv.unread = [];
    if (!conn?.rights?.can_read_messages) return;
    await this.api
      .call("readBusinessMessage", { business_connection_id: conv.connId, chat_id: conv.chatId, message_id: lastId })
      .catch((e) => this.log.warn("readBusinessMessage:", e.message));
  }

  async typing(conv, ms) {
    let left = ms;
    while (left > 0) {
      await this.api
        .call("sendChatAction", { chat_id: conv.chatId, action: "typing", ...this.transportExtra(conv) })
        .catch((e) => this.log.warn("sendChatAction:", e.message));
      const step = Math.min(left, 4500); // статус живёт ~5 секунд
      await this.sleep(step);
      left -= step;
    }
  }

  async sendToClient(conv, text) {
    const sent = await this.api.sendMessage(conv.chatId, truncate(text, 4096), this.transportExtra(conv));
    if (sent?.message_id) {
      conv.sentMids.push(sent.message_id);
      if (conv.sentMids.length > 50) conv.sentMids.splice(0, conv.sentMids.length - 50);
    }
    return sent;
  }

  // Ответ бота: прочитать → «печатает» пропорционально длине → отправить. Длинный ответ — частями.
  async deliver(conv, text, role = "bot") {
    const parts = splitReply(text);
    if (!parts.length) return;
    await this.markRead(conv);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await this.sleep(this.cfg.typing.pauseMs);
      await this.typing(conv, typingDuration(parts[i], this.cfg.typing));
      if (role === "bot" && conv.status !== "bot") return; // мастер перехватил на полуслове
      try {
        const sent = await this.sendToClient(conv, parts[i]);
        this.pushMessage(conv, { role, text: parts[i], mid: sent?.message_id });
        conv.lastReplyAt = this.now();
      } catch (e) {
        this.log.error("Не удалось отправить клиенту:", e.message);
        await this.notifyAdmins(
          `⚠️ Не удалось отправить сообщение клиенту <b>${esc(conv.client.name)}</b>: ${esc(e.message)}`,
          [[{ text: "📜 Переписка", callback_data: `c:open:${conv.id}` }]]
        );
        break;
      }
    }
    this.save();
  }

  // ---------- передача мастеру ----------

  async handoff(conv, { reason, draft = "", confidence = null, error = false }) {
    this.cancelScheduled(conv.id);
    conv.status = "waiting";
    conv.handoff = {
      reason,
      draft,
      confidence,
      error,
      at: this.now(),
      question: this.pendingClientMessages(conv)
        .map((m) => m.text)
        .join("\n"),
    };
    this.save();
    this.log.info(`→ мастеру: разговор ${conv.id} (${reason})`);
    await this.notifyHandoff(conv);
  }

  async onEffect(conv, ef) {
    const b = ef.booking;
    const today = nowParts(this.shop.timezone, this.now()).date;
    if (ef.type === "booked") {
      conv.session.booked = true;
      await this.notifyAdmins(
        `🆕 <b>Новая запись</b> ${b.id}\n${esc(b.serviceName)} · ${esc(b.price)}\n🗓 ${esc(bookingLabel(b, today))} · мастер ${esc(
          b.staffName
        )}\n👤 ${esc(b.client.name || conv.client.name)}${b.client.phone ? ` · ${esc(b.client.phone)}` : ""}${
          b.client.username ? ` · @${esc(b.client.username)}` : ""
        }${b.comment ? `\n💬 ${esc(b.comment)}` : ""}`,
        [
          [
            { text: "💬 Переписка", callback_data: `c:open:${conv.id}` },
            { text: "❌ Отменить запись", callback_data: `b:cx:${b.id}` },
          ],
        ],
        conv.id
      );
    } else if (ef.type === "cancelled") {
      await this.notifyAdmins(
        `❌ <b>Клиент отменил запись</b> ${b.id}\n${esc(b.serviceName)} · ${esc(bookingLabel(b, today))} · ${esc(b.staffName)}\n👤 ${esc(
          b.client.name || conv.client.name
        )}`,
        [[{ text: "💬 Переписка", callback_data: `c:open:${conv.id}` }]],
        conv.id
      );
    }
  }

  // ---------- мастер пишет клиенту ----------

  async takeover(conv, adminId, { quiet = false, relay = true } = {}) {
    this.cancelScheduled(conv.id);
    if (conv.status === "waiting" && conv.handoff) conv.takenHandoff = conv.handoff;
    conv.status = "admin";
    conv.handledBy = adminId;
    conv.handoff = null;
    const a = this.admin(adminId);
    if (a && relay) a.relayTo = conv.id;
    this.save();
    if (!quiet) await this.sendTakeoverHint(conv, adminId);
  }

  async returnToBot(conv, { answerPending = true } = {}) {
    const hadAdminReply = conv.status === "admin" && conv.takenHandoff;
    conv.status = "bot";
    conv.handledBy = null;
    conv.handoff = null;
    for (const a of Object.values(this.state.admins)) if (a.relayTo === conv.id) a.relayTo = null;
    // Для кнопки «Запомнить ответ»: вопрос, на который бот не смог, и ответ мастера
    if (hadAdminReply) {
      const since = conv.takenHandoff.at;
      const answer = conv.messages
        .filter((m) => m.role === "admin" && m.at >= since)
        .map((m) => m.text)
        .join("\n");
      conv.lastQA = answer ? { q: conv.takenHandoff.question, a: answer } : null;
    }
    conv.takenHandoff = null;
    this.save();
    const last = conv.messages[conv.messages.length - 1];
    if (answerPending && last && last.role === "client" && !last.service) this.schedule(conv.id, 0);
  }

  async relay(adminId, conv, msg, api) {
    // Написал клиенту без «Перехватить» (например, реплаем) — бот в этом чате встаёт на паузу, говорим об этом
    if (conv.status !== "admin" || conv.handledBy !== adminId) await this.takeover(conv, adminId);
    const text = msg.text || msg.caption || "";
    try {
      await this.markRead(conv);
      if (msg.text) {
        const sent = await this.sendToClient(conv, text);
        this.pushMessage(conv, { role: "admin", text, mid: sent?.message_id });
      } else if (conv.kind === "direct" && !this.separateConsole) {
        const sent = await this.api.call("copyMessage", { chat_id: conv.chatId, from_chat_id: msg.chat.id, message_id: msg.message_id });
        this.pushMessage(conv, { role: "admin", text: text || "[вложение]", mid: sent?.message_id });
      } else {
        await api.sendMessage(
          adminId,
          conv.kind === "business"
            ? "В чат через Telegram Business передаю только текст. Вложение отправьте прямо из своего Telegram."
            : "Из отдельного бота-панели передаю клиенту только текст."
        );
        return;
      }
      this.save();
      await api
        .call("setMessageReaction", { chat_id: adminId, message_id: msg.message_id, reaction: [{ type: "emoji", emoji: "👍" }] })
        .catch(() => {});
    } catch (e) {
      await api.sendMessage(adminId, `⚠️ Не удалось отправить: ${e.message}`);
    }
  }

  // ---------- Telegram Business ----------

  async onBusinessConnection(bc) {
    const uid = bc.user.id;
    const allowed = Boolean(this.role(uid));
    this.state.businessConnections[bc.id] = {
      id: bc.id,
      userId: uid,
      userChatId: bc.user_chat_id,
      rights: bc.rights || {},
      enabled: bc.is_enabled !== false,
      allowed,
      name: userName(bc.user),
      at: this.now(),
    };
    this.save();
    const say = (t) => this.api.sendMessage(bc.user_chat_id, t, { parse_mode: "HTML" }).catch((e) => this.log.warn(e.message));
    if (bc.is_enabled === false) return say("Бот отключён от вашего аккаунта. Клиентам он больше не отвечает.");
    if (!allowed) {
      return say("Этот бот уже работает для другой точки, поэтому подключение не активно. Чтобы подключить свою, попросите у владельца ссылку-приглашение.");
    }
    const r = bc.rights || {};
    const notes = [];
    if (!r.can_reply) notes.push("⚠️ Нет права «Отвечать на сообщения» — без него бот не сможет писать клиентам.");
    if (!r.can_read_messages)
      notes.push("ℹ️ Нет права «Отмечать сообщения прочитанными» — бот будет отвечать, но сообщения останутся непрочитанными до вашего ответа.");
    return say(
      `✅ <b>Бот подключён к вашему Telegram.</b>\nТеперь он отвечает клиентам в ваших личных чатах от вашего имени.\n\n` +
        `• Если бот не уверен или случилась ошибка, он <b>не читает</b> сообщение и зовёт вас — непрочитанный чат будет у вас в списке, как обычно.\n` +
        `• Ответите клиенту сами — бот в этом чате замолчит, пока вы не вернёте его кнопкой.\n` +
        (notes.length ? `\n${notes.join("\n")}` : "")
    );
  }

  async onBusinessMessage(msg) {
    const conn = this.state.businessConnections[msg.business_connection_id];
    if (!conn || !conn.allowed || conn.enabled === false) return;
    if (msg.chat?.type !== "private") return;
    const transport = { kind: "business", connId: conn.id, chatId: msg.chat.id };

    if (msg.from?.id === conn.userId) {
      // Это пишет сам мастер (или бот от его имени)
      if (msg.sender_business_bot) return;
      const conv = this.getConv(transport, null);
      if (!conv.client.id) conv.client = { id: msg.chat.id, name: userName(msg.chat), username: msg.chat.username || "" };
      if (conv.sentMids.includes(msg.message_id)) return;
      this.pushMessage(conv, { role: "admin", text: msg.text || msg.caption || "[вложение]", mid: msg.message_id });
      conv.unread = [];
      if (conv.status !== "admin") {
        // Мастер отвечает из своего Telegram — сообщения из панели в этот чат не перенаправляем
        await this.takeover(conv, conn.userId, { quiet: true, relay: false });
        await this.notifyAdmin(
          conn.userId,
          `✋ Вы ответили <b>${esc(conv.client.name)}</b> сами — бот в этом чате на паузе.`,
          [[{ text: "🤖 Вернуть боту", callback_data: `c:bot:${conv.id}` }]],
          conv.id
        );
      }
      this.save();
      return;
    }
    if (msg.from?.is_bot) return;
    return this.onClientMessage(msg, transport);
  }

  async openBusinessChat(adminId, chatId) {
    const conv = Object.values(this.state.conversations).find((c) => c.kind === "business" && String(c.chatId) === String(chatId));
    if (!conv) return this.consoleApi.sendMessage(adminId, "Этой переписки пока нет в истории бота.");
    return this.showChat(adminId, conv.id);
  }

  // ---------- напоминания ----------

  async checkReminders() {
    const shop = this.shop;
    for (const b of upcomingBookings(this.state, shop, { now: this.now() })) {
      if (b.remindedAt) continue;
      const left = minutesUntilStart(b, shop, this.now());
      if (left > this.cfg.reminderMinutes || left <= 0) continue;
      b.remindedAt = this.now();
      // Не напоминаем о записи, сделанной перед самым визитом
      if (minutesUntilStart(b, shop, b.createdAt) < this.cfg.reminderMinutes + 30) continue;
      const conv = this.conv(b.client?.key);
      if (!conv) continue;
      const today = nowParts(shop.timezone, this.now()).date;
      const text = `Напоминаю: ${bookingLabel(b, today).replace(/–\d\d:\d\d$/, "")} у вас ${b.serviceName.toLowerCase()} у мастера ${b.staffName}. Ждём вас${
        shop.address ? ` по адресу ${[shop.city, shop.address].filter(Boolean).join(", ")}` : ""
      } 💈`;
      await this.deliver(conv, text, "bot").catch((e) => this.log.warn("Напоминание:", e.message));
    }
    this.save();
  }

  // ---------- уведомления мастерам ----------

  noteRef(adminId, messageId, convId) {
    if (!convId || !messageId) return;
    const refs = this.state.consoleRefs;
    refs[`${adminId}:${messageId}`] = convId;
    const keys = Object.keys(refs);
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete refs[k];
  }

  // Сообщение в панель (HTML). Если Telegram не разобрал разметку — шлём простым текстом.
  async sendHtml(chatId, text, extra = {}) {
    const opts = { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra };
    try {
      return await this.consoleApi.sendMessage(chatId, text, opts);
    } catch (e) {
      if (!/parse entities/i.test(e.message)) throw e;
      delete opts.parse_mode;
      const plain = text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      return this.consoleApi.sendMessage(chatId, plain, opts);
    }
  }

  async notifyAdmin(adminId, text, keyboard, convId) {
    try {
      const sent = await this.sendHtml(adminId, text, keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {});
      this.noteRef(adminId, sent?.message_id, convId);
      return sent;
    } catch (e) {
      this.log.warn(`Не удалось уведомить мастера ${adminId}:`, e.message);
    }
  }

  async notifyAdmins(text, keyboard, convId) {
    const targets = Object.values(this.state.admins).filter((a) => a.notify !== false);
    for (const a of targets) await this.notifyAdmin(a.id, text, keyboard, convId);
    this.save();
  }

  clientLine(conv) {
    const c = conv.client || {};
    const via = conv.kind === "business" ? "пишет вам в Telegram" : "пишет боту";
    return `👤 <b>${esc(c.name || "Клиент")}</b>${c.username ? ` @${esc(c.username)}` : ""} · ${via}`;
  }

  async notifyHandoff(conv) {
    const h = conv.handoff;
    const lines = [`🔴 <b>Нужен ответ мастера</b>`, this.clientLine(conv)];
    if (h.question) lines.push(`💬 «${esc(truncate(h.question, 700))}»`);
    lines.push(`⚠️ ${esc(h.reason)}`);
    if (h.draft) lines.push(`📝 Черновик бота: «${esc(truncate(h.draft, 700))}»`);
    if (conv.kind === "business") lines.push("<i>Сообщение осталось непрочитанным — можно ответить прямо в своём Telegram.</i>");
    else lines.push("<i>Ответьте реплаем на это сообщение — я передам клиенту.</i>");
    const kb = [[{ text: "✋ Взять диалог", callback_data: `c:take:${conv.id}` }]];
    if (h.draft) kb[0].push({ text: "✅ Отправить черновик", callback_data: `c:send:${conv.id}` });
    kb.push([
      { text: "🔁 Бот, попробуй ещё", callback_data: `c:retry:${conv.id}` },
      { text: "📜 Переписка", callback_data: `c:open:${conv.id}` },
    ]);
    await this.notifyAdmins(lines.join("\n"), kb, conv.id);
  }

  async notifyMoreFromClient(conv, text) {
    await this.notifyAdmins(
      `💬 <b>${esc(conv.client.name)}</b> (ждёт ответа): ${esc(truncate(text, 1000))}`,
      [
        [
          { text: "✋ Взять диалог", callback_data: `c:take:${conv.id}` },
          { text: "🔁 Бот, попробуй ещё", callback_data: `c:retry:${conv.id}` },
        ],
      ],
      conv.id
    );
  }

  // Мастер ведёт диалог: пересылаем ему новые сообщения клиента
  async forwardToHandler(conv, text) {
    const targets = conv.handledBy ? [conv.handledBy] : Object.keys(this.state.admins).map(Number);
    for (const id of targets) {
      if (conv.kind === "business" && this.conn(conv)?.userId === id) continue; // он и так видит чат у себя
      await this.notifyAdmin(
        id,
        `💬 <b>${esc(conv.client.name)}</b>: ${esc(truncate(text, 3000))}`,
        [[{ text: "🤖 Вернуть боту", callback_data: `c:bot:${conv.id}` }]],
        conv.id
      );
    }
    this.save();
  }
}

module.exports = { App, HOUR };
require("./console").install(App);
