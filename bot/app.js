// Ядро бота: маршрутизация апдейтов, разговоры с клиентами, ответы ИИ,
// передача мастеру, Telegram Business, напоминания. Панель мастера — в console.js.
const { generateReply, unansweredTail, replyIndex } = require("./assistant");
const { typingDuration, splitReply } = require("./typing");
const { upcomingBookings, bookingLabel, minutesUntilStart } = require("./schedule");
const { nowParts } = require("./time");
const { esc, truncate, oneLine, sleep: realSleep, randomCode, userName } = require("./util");

const HOUR = 3600000;

// Что написать клиенту, когда бот зовёт мастера, а ИИ сам фразу не предложил
const HOLD_TEXT = "Уточню и скоро вам отвечу";
// Мастеру, чьи обычные сообщения сейчас ушли бы не этому клиенту (см. elsewhereNote)
const REPLY_HERE = "Чтобы ответить этому клиенту, ответьте реплаем на это сообщение или нажмите «Взять диалог».";

// Вложения, которые бот не разбирает: поле сообщения, как назвать мастеру и что ответить клиенту сразу
const MEDIA = [
  ["photo", "фото", "Посмотрю и скоро отвечу"],
  ["voice", "голосовое", "Послушаю и скоро отвечу"],
  ["video_note", "видеосообщение", "Посмотрю и скоро отвечу"],
  ["video", "видео", "Посмотрю и скоро отвечу"],
  ["audio", "аудио", "Послушаю и скоро отвечу"],
  // У гифки Telegram заполняет и document, поэтому она раньше файла.
  // Гифка — обычно реакция, обещать «посмотрю» странно.
  ["animation", "гифку", ""],
  ["document", "файл", "Посмотрю и скоро отвечу"],
];
const MEDIA_HOLD = Object.fromEntries(MEDIA.map(([, label, hold]) => [label, hold]));

// Черновик без начатого ответа в начале: начатое клиент получает отдельным сообщением, второй раз не повторяем
const withoutStart = (text, start) => (start && text.startsWith(start) ? text.slice(start.length).trim() : text);

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
    this.holding = new Set(); // разговоры, где бот сейчас «печатает» «уточню и скоро отвечу»
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
    this.resumePending();
  }

  // Перезапуск (например, автодеплой) обрывает ответы «на лету»: сообщение клиента уже сохранено,
  // а ответа нет и никто его не запланирует. Подхватываем такие переписки за последний час.
  resumePending(maxAgeMs = HOUR) {
    const now = this.now();
    let n = 0;
    for (const c of Object.values(this.state.conversations)) {
      // Завершённый диалог не поднимаем: следующий вопрос клиента начнёт новый разговор
      if (c.status !== "bot" || c.session?.closed || now - (c.lastClientAt || 0) > maxAgeMs) continue;
      // Без ответа — сообщение клиента или то, что бот не дослал, а мастер вернул ему (см. returnToBot)
      if (!c.unsent && !this.pendingClientMessages(c).length) continue;
      this.schedule(c.id);
      n++;
    }
    if (n) this.log.info(`Переписок без ответа после перезапуска: ${n}, отвечаю.`);
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

  // after — номер последнего сообщения, которое видел ИИ (или бот, начиная отправку).
  // Ответ встаёт сразу за ним, а то, что клиент дописал, пока бот думал или «печатал»,
  // остаётся в конце и считается неотвеченным — иначе такие сообщения терялись.
  pushMessage(conv, m, { after } = {}) {
    conv.msgCount = (conv.msgCount || conv.messages.length) + 1;
    const msgs = conv.messages;
    msgs.splice(replyIndex(msgs, after), 0, { at: this.now(), seq: conv.msgCount, ...m });
    if (msgs.length > 100) msgs.splice(0, msgs.length - 100);
    conv.updatedAt = this.now();
  }

  // Сообщения клиента без ответа в текущем разговоре. «Уточню и скоро отвечу» и напоминания
  // ответом не считаются: вопрос по-прежнему ждёт мастера или новой попытки бота.
  pendingClientMessages(conv) {
    return unansweredTail(conv.messages, conv.session?.startedAt).filter((m) => m.role === "client");
  }

  // Можно ли сейчас написать клиенту «уточню» с таким текстом. Одного обещания на вопрос хватает: пока оно
  // уходит или клиент после него ничего не дописал, второе не шлём. Клиент дописал — стандартную фразу
  // всё равно не повторяем, а свои слова ИИ (own) отправляем: в них бывает ответ на часть нового.
  mayHold(conv, text, own = false) {
    if (!text || this.holding.has(conv.id)) return false;
    const tail = unansweredTail(conv.messages, conv.session?.startedAt);
    const last = tail.findLastIndex((m) => m.hold);
    if (last < 0) return true;
    if (!own || !tail.slice(last + 1).some((m) => m.role === "client")) return false;
    const said = tail.filter((m) => m.hold).map((m) => m.text);
    return !splitReply(text).every((part) => said.includes(part)); // слово в слово то же самое не повторяем
  }

  // Клиент написал что-то новое текстом после сообщения номер seq. Голосовое или фото ответ
  // на прежний вопрос не меняют — их потом разберёт мастер.
  wroteSince(conv, seq) {
    return conv.messages.some((m) => m.role === "client" && !m.service && !m.needsHuman && m.seq > seq);
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
    for (const [field, label] of MEDIA) {
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
    return `Здравствуйте! Это ${s.name || "наш барбершоп"} 💈 Подскажу по услугам и запишу на удобное время.${
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
      // Ответ, который бот не отправил, потому что клиент дописал. ИИ увидит его в следующем круге
      // и решит, как поступил бы человек: отправить и дописать про новое или ответить заново.
      // С него же начинается проход, если мастер вернул боту диалог с тем, что не ушло из-за сбоя (conv.unsent).
      const resumed = this.conv(id);
      let draft = resumed?.unsent || null;
      if (resumed) resumed.unsent = null;
      // Следующий круг нового ответа не дал (сбой ИИ, лимит, вложение) — отправляем начатый как есть:
      // на то, что клиент спросил раньше, он отвечал верно. false — диалог уже взял мастер, дальше не идём.
      // Что не ушло из-за сбоя отправки, остаётся в lost; lostAfter — на какие сообщения клиента оно отвечало.
      let lost = "";
      let lostAfter = null;
      let lostError = "";
      const flush = async (conv) => {
        if (draft) {
          const { text, after } = draft;
          draft = null;
          const out = await this.deliver(conv, text, "bot", { after });
          if (out.failed) [lost, lostAfter, lostError] = [out.unsent, after, out.error];
        }
        return conv.status === "bot";
      };
      // Сбой отправки передачу мастеру не отменяет: вопрос клиента не должен пропасть. Клиенту тогда больше
      // не пишем (о сбое мастера уже знают), а то, что не ушло, мастер получит в начале черновика. Если кроме
      // этого в черновике ничего нет, он отвечает только на прежние сообщения клиента (draftAfter): после
      // «Отправить черновик» новое, ради которого звали мастера, остаётся без ответа и снова уйдёт мастеру.
      // Само неотправленное карточка помнит отдельно (lost): «Бот, попробуй ещё» вернёт его боту (см. returnToBot).
      const toMaster = (conv, h) => {
        if (!lost) return this.handoff(conv, h);
        const full = [lost, h.draft].filter(Boolean).join("\n\n");
        return this.handoff(conv, { ...h, draft: full, hold: "", draftAfter: h.draft ? null : lostAfter, lost: { text: lost, after: lostAfter } });
      };
      const sendFailed = (conv, question) => toMaster(conv, { reason: `не удалось отправить ответ клиенту: ${lostError}`, question });
      for (let round = 0; round < 4; round++) {
        const conv = this.conv(id);
        if (!conv || conv.status !== "bot") return;
        // Мастер вернул боту то, что не ушло из-за сбоя, а клиент с тех пор ничего не написал: ответ по-прежнему
        // верен и уходит как есть, ИИ заново не зовём. (Обычный начатый ответ сюда не попадает: он появляется,
        // только когда клиент дописал.) Написал — ниже ИИ увидит этот ответ как неотправленный и решит сам.
        if (draft && !this.wroteSince(conv, draft.after)) {
          const { question = "", upTo = 0 } = draft;
          if (!(await flush(conv))) return;
          if (!lost) continue; // дальше — то, что клиент прислал после (фото, голосовое), если есть
          // Снова не ушло: диалог опять ждёт мастера. В вопросе — прежний вопрос и то, что клиент прислал после него
          const more = this.pendingClientMessages(conv).filter((m) => m.seq > upTo).map((m) => m.text);
          await sendFailed(conv, [question, ...more].filter(Boolean).join("\n"));
          return;
        }
        const pending = this.pendingClientMessages(conv);
        if (!pending.length) return;

        const odd = pending.find((m) => m.needsHuman);
        if (odd) {
          if (!(await flush(conv))) return;
          await toMaster(conv, { reason: `клиент прислал ${odd.needsHuman} — бот такое не разбирает`, hold: MEDIA_HOLD[odd.needsHuman] || "" });
          return;
        }

        // Защита от спама: не больше LLM_CALLS_PER_HOUR ответов ИИ в час на одного клиента
        conv.llmCalls = (conv.llmCalls || []).filter((t) => this.now() - t < HOUR);
        if (conv.llmCalls.length >= this.cfg.llmCallsPerHour) {
          if (!(await flush(conv))) return;
          await toMaster(conv, { reason: "клиент пишет слишком часто — бот взял паузу" });
          return;
        }
        conv.llmCalls.push(this.now());

        const seen = conv.msgCount;
        const result = await generateReply({ llm: this.llm, cfg: this.cfg, state: this.state, shop: this.shop, conv, draft, now: this.now(), log: this.log });
        for (const ef of result.effects) await this.onEffect(conv, ef);
        this.save();
        if (conv.status !== "bot") return; // мастер перехватил, пока ИИ думал

        // Клиент дописал, пока ИИ думал или бот «печатал», — ответ мог устареть: не отправляем его,
        // а переписываем с учётом нового. Если ИИ уже записал или отменил запись, ответ о сделанном
        // уходит как есть, а новое бот разберёт следующим кругом. В последнем круге тоже отправляем как есть.
        const canRedo = round < 3 && !result.effects.length;
        const outdated = () => canRedo && this.wroteSince(conv, seen);
        if (outdated()) {
          // Новый ответ заменяет прежний черновик. Не ответил (сбой, нужен мастер) — прежний остаётся.
          if (result.kind === "reply") draft = { text: result.text, after: seen };
          continue;
        }

        if (result.kind === "error") {
          // При сбое ИИ молчим: неизвестно, что именно клиент спросил и нужно ли ему что-то обещать
          if (!(await flush(conv))) return;
          await toMaster(conv, { reason: result.reason, error: true });
          return;
        }
        if (result.kind === "handoff") {
          // ИИ сам написал «уточню»: неотправленный ответ он видел и что в нём ещё верно, перенёс туда.
          // Иначе (не уверен, отказался, «уточню» уже ушло, а клиент после него не писал) начатый ответ
          // уходит как есть.
          const ownHold = this.mayHold(conv, result.hold, true);
          const started = !ownHold && draft ? draft.text : "";
          if (!ownHold && !(await flush(conv))) return;
          // Черновик для мастера — только про новое: начатое уже ушло клиенту, а что из него не ушло из-за
          // сбоя, встанет в начало черновика само (toMaster) — второй раз не повторяем
          await toMaster(conv, {
            reason: result.reason,
            draft: withoutStart(result.draft || "", started),
            confidence: result.confidence,
            // ИИ не знает ответа — клиенту «уточню и скоро отвечу» (своими словами или стандартной фразой).
            // Нет hold — ИИ отказался отвечать или ничего не написал: тогда молчим.
            hold: result.hold == null ? "" : ownHold ? result.hold : HOLD_TEXT,
            own: ownHold,
            carried: ownHold ? draft : null, // не уйдёт «уточню» — начатое вернётся мастеру в черновик (см. handoff)
          });
          return;
        }
        const out = await this.deliver(conv, result.text, "bot", { after: seen, stopIf: outdated });
        if (out.failed) {
          // Ответ не ушёл. ИИ впустую не крутим и клиенту больше не пишем: диалог переходит к мастеру, а то,
          // что не ушло, — в черновик, чтобы отправить ещё раз одним нажатием. Что клиент прислал уже после
          // этого ответа (фото, голосовое), после отправки черновика бот разберёт как обычно.
          [lost, lostAfter, lostError] = [out.unsent, seen, out.error];
          // Вопрос в карточке — то, на что этот ответ отвечал, и то, что клиент дописал после. Если первая часть
          // ответа ушла, эти сообщения уже считаются отвеченными, и сама карточка их бы не показала.
          const asked = [...new Set([...pending, ...this.pendingClientMessages(conv)])].map((m) => m.text).join("\n");
          if (conv.status === "bot") await sendFailed(conv, asked);
          return;
        }
        draft = out.unsent ? { text: out.unsent, after: seen } : null;
        // следующий круг ответит на то, что клиент написал, пока бот думал или «печатал»
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
  // Отмечаем только то, на что отвечаем: сообщения клиента позже upTo (см. after в pushMessage)
  // остаются непрочитанными — на них ответит следующий круг или мастер.
  async markRead(conv, upTo = Infinity) {
    if (conv.kind !== "business" || !conv.unread.length) return;
    const later = new Set(conv.messages.filter((m) => m.role === "client" && m.seq > upTo).map((m) => m.mid));
    const read = conv.unread.filter((id) => !later.has(id));
    if (!read.length) return;
    conv.unread = conv.unread.filter((id) => later.has(id));
    if (!this.conn(conv)?.rights?.can_read_messages) return;
    await this.api
      .call("readBusinessMessage", { business_connection_id: conv.connId, chat_id: conv.chatId, message_id: read[read.length - 1] })
      .catch((e) => this.log.warn("readBusinessMessage:", e.message));
  }

  // «Печатает…» ms миллисекунд. stopIf — бросить на полуслове (клиент дописал): тогда вернёт false.
  async typing(conv, ms, stopIf = null) {
    let left = ms;
    while (left > 0) {
      if (stopIf?.()) return false;
      await this.api
        .call("sendChatAction", { chat_id: conv.chatId, action: "typing", ...this.transportExtra(conv) })
        .catch((e) => this.log.warn("sendChatAction:", e.message));
      let chunk = Math.min(left, 4500); // статус живёт ~5 секунд
      left -= chunk;
      // Пока печатаем, несколько раз в секунду смотрим, не дописал ли клиент
      while (chunk > 0) {
        const step = stopIf ? Math.min(chunk, 250) : chunk;
        await this.sleep(step);
        chunk -= step;
        if (stopIf?.()) return false;
      }
    }
    return true;
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
  // after — см. pushMessage; по умолчанию ответ относится ко всему, что было до начала отправки.
  // hold — «уточню и скоро отвечу», пока диалог ждёт мастера; notice — напоминание о записи: уходит,
  // даже если диалог ведёт мастер. Ни то ни другое не ответ по существу, поэтому сообщения клиента
  // бот прочитанными не отмечает (это сделает тот, кто ответит).
  // stopIf — бросить устаревший ответ, если клиент дописал: вернёт неотправленный остаток в unsent.
  // Сбой отправки — { failed: true, sent: сколько частей ушло, unsent: что не ушло, error }, мастерам уже написали (кроме мастера
  // by: он сам нажал кнопку, и ему ответит вызвавший). Мастер перехватил диалог, пока бот «печатал», —
  // { stopped: true, sent: сколько частей успело уйти }.
  async deliver(conv, text, role = "bot", { after = conv.msgCount, hold = false, notice = false, stopIf = null, by } = {}) {
    const parts = splitReply(text);
    if (!parts.length) return {};
    if (!hold && !notice) await this.markRead(conv, after);
    // Бот пишет, только пока диалог у него (а «уточню» — пока диалог ждёт мастера)
    const mayGo = () => notice || role !== "bot" || conv.status === (hold ? "waiting" : "bot");
    const flags = hold ? { hold: true } : notice ? { notice: true } : {};
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await this.sleep(this.cfg.typing.pauseMs);
      const typed = await this.typing(conv, typingDuration(parts[i], this.cfg.typing), stopIf);
      if (!mayGo()) {
        this.save(); // первые части могли уйти
        return { stopped: true, sent: i }; // мастер перехватил на полуслове
      }
      if (!typed || stopIf?.()) {
        this.save(); // первые части могли уйти
        return { unsent: parts.slice(i).join("\n\n") };
      }
      try {
        const sent = await this.sendToClient(conv, parts[i]);
        this.pushMessage(conv, { role, text: parts[i], mid: sent?.message_id, ...flags }, { after });
        conv.lastReplyAt = this.now();
      } catch (e) {
        this.log.error("Не удалось отправить клиенту:", e.message);
        this.save();
        const unsent = parts.slice(i).join("\n\n");
        await this.notifyAdmins(
          `⚠️ Не удалось отправить сообщение клиенту <b>${esc(conv.client.name)}</b>: ${esc(e.message)}\nНе ушло: «${esc(truncate(unsent, 700))}»`,
          [[{ text: "📜 Переписка", callback_data: `c:open:${conv.id}` }]],
          null,
          { except: by }
        );
        return { failed: true, sent: i, unsent, error: e.message };
      }
    }
    this.save();
    return {};
  }

  // ---------- передача мастеру ----------

  // hold — что сразу написать клиенту («уточню и скоро отвечу»), чтобы он не ждал в тишине.
  // Пустая строка — бот молчит (например, при сбое ИИ). own — это слова самого ИИ, а не стандартная фраза.
  // draftAfter — черновик отвечает только на сообщения клиента до этого номера (обычно — на все).
  // carried — начатый ответ { text, after }, который бот отдельно не отправлял: ИИ перенёс его в своё «уточню».
  // question — вопрос для карточки, если это не просто всё, что сейчас без ответа.
  // lost — та часть черновика { text, after }, которую бот уже отправлял клиенту и не смог (см. returnToBot).
  async handoff(conv, { reason, draft = "", confidence = null, error = false, hold = "", own = false, draftAfter = null, carried = null, question = null, lost = null }) {
    this.cancelScheduled(conv.id);
    // Одного «уточню» на вопрос хватает: после «Бот, попробуй ещё» второй раз не обещаем (см. mayHold)
    const holdText = this.mayHold(conv, hold, own) ? hold : "";
    if (holdText) this.holding.add(conv.id); // сразу: пока это «уточню» не ушло, второе не начинаем
    conv.status = "waiting";
    const h = (conv.handoff = {
      reason,
      draft,
      draftAfter,
      lost,
      confidence,
      error,
      hold: holdText,
      at: this.now(),
      upTo: conv.msgCount, // вопрос ниже охватывает сообщения клиента до этого номера
      question:
        question ??
        this.pendingClientMessages(conv)
          .map((m) => m.text)
          .join("\n"),
    });
    this.save();
    this.log.info(`→ мастеру: разговор ${conv.id} (${reason})`);
    await this.notifyHandoff(conv).catch((e) => this.log.error("Карточка мастеру:", e));
    // «Печатает…» идёт в фоне: если мастер успеет ответить или нажать кнопку, «уточню» не уйдёт
    if (!holdText) return;
    this.run(async () => {
      try {
        const out = await this.deliver(conv, holdText, "bot", { hold: true });
        // Своё «уточню» не ушло совсем, а начатый ответ был только в нём. Он не пропадает: встаёт в начало
        // черновика (как в toMaster), и мастера получают карточку заново — без «Клиенту пишу», с кнопкой.
        // Пока она не пришла, «Отправить черновик» под прежней карточкой просит подождать (holding).
        // Только если ИИ перенёс начатое в «уточню» как есть, каждое сообщение слово в слово: переписал — значит,
        // оно устарело (клиент уточнил вопрос), и одним нажатием такое отправлять нельзя. Что не ушло, мастера
        // видят в предупреждении.
        const said = oneLine(holdText);
        const kept = carried && splitReply(carried.text).every((part) => said.includes(oneLine(part)));
        if (out.failed && !out.sent && kept && conv.handoff === h) {
          const rest = withoutStart(h.draft, carried.text);
          Object.assign(h, { draft: [carried.text, rest].filter(Boolean).join("\n\n"), draftAfter: rest ? null : carried.after, lost: { ...carried }, hold: "" });
          this.save();
          await this.notifyHandoff(conv).catch((e) => this.log.error("Карточка мастеру:", e));
        }
      } finally {
        this.holding.delete(conv.id);
      }
    });
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

  // relay — обычные сообщения мастера из панели теперь уходят этому клиенту.
  // keepSetup — мастер ответил реплаем посреди настройки точки, которой занят прямо сейчас: обычные
  // сообщения по-прежнему идут в настройку, а к клиенту он вернётся реплаем или «Писать сюда».
  // Настройку, которую давно не трогали (бросил на полпути), реплай клиенту отодвигает.
  async takeover(conv, adminId, { quiet = false, relay = true, keepSetup = false } = {}) {
    this.cancelScheduled(conv.id);
    if (conv.status === "waiting" && conv.handoff) conv.takenHandoff = conv.handoff;
    conv.status = "admin";
    conv.handledBy = adminId;
    conv.handoff = null;
    conv.unsent = null; // отвечает мастер — недосланное бот уже не досылает
    // Взял диалог — его обычные сообщения теперь уходят клиенту, даже если он не закончил
    // настройку точки (иначе ответ клиенту попадал в «Обновляю данные…»)
    const a = this.admin(adminId);
    if (relay && a) {
      if (keepSetup && this.setupFresh(a)) a.relayTo = conv.id;
      else this.focusDialog(a, conv.id);
    }
    this.save();
    if (!quiet) await this.sendTakeoverHint(conv, adminId);
  }

  focusDialog(a, convId) {
    if (!a) return;
    a.relayTo = convId;
    a.focus = "dialog";
  }

  // by — мастер, который нажал кнопку: ему скажут об этом там, где он нажал
  // resume — бот продолжает с того места, где позвал мастера («Бот, попробуй ещё», «Вернуть боту»). То, что он
  // уже отправлял клиенту и не смог (handoff.lost), остаётся за ним: с этого начнётся следующий проход
  // (processConv). Так же, если мастер взял диалог и вернул, ничего клиенту не написав. А если мастер ответил
  // сам или диалог завершили, недосланное больше не нужно.
  // Сам проход бота запускает тот, кто вернул диалог.
  async returnToBot(conv, { by = null, resume = false } = {}) {
    const taken = conv.status === "admin" ? conv.takenHandoff : null;
    // Что мастер написал клиенту с тех пор, как бот его позвал
    const answer = !taken
      ? ""
      : conv.messages
          .filter((m) => m.role === "admin" && m.at >= taken.at)
          .map((m) => m.text)
          .join("\n");
    const waited = !resume ? null : conv.status === "waiting" ? conv.handoff : answer ? null : taken;
    // Диалог уже у бота (кнопку нажали дважды подряд, проход ещё не начался) — недосланное остаётся за ним
    if (!resume || conv.status !== "bot") conv.unsent = waited?.lost ? { ...waited.lost, question: waited.question, upTo: waited.upTo } : null;
    conv.status = "bot";
    conv.handledBy = null;
    conv.handoff = null;
    // Чьи обычные сообщения уходили этому клиенту: вернул диалог другой мастер — скажем им
    const others = [];
    for (const a of Object.values(this.state.admins)) {
      if (a.relayTo !== conv.id) continue;
      a.relayTo = null;
      // Диалога больше нет: обычные сообщения идут в открытую настройку, и мастер снова занят ею
      if (a.mode) a.focus = "setup";
      if (a.id !== by) others.push(a);
    }
    // Для кнопки «Запомнить ответ»: вопрос, на который бот не смог, и ответ мастера
    if (taken) conv.lastQA = answer ? { q: taken.question, a: answer } : null;
    conv.takenHandoff = null;
    this.save();
    for (const a of others) {
      await this.notifyAdmin(
        a.id,
        `🤖 Диалог с <b>${esc(conv.client.name)}</b> вернули боту — ваши сообщения этому клиенту больше не уходят.${
          a.mode ? " Обычные сообщения теперь идут в настройку точки." : ""
        }`,
        [[{ text: "✋ Взять диалог", callback_data: `c:take:${conv.id}` }]],
        conv.id
      );
    }
  }

  async relay(adminId, conv, msg, api) {
    const a = this.admin(adminId);
    if (conv.status !== "admin" || conv.handledBy !== adminId) {
      // Написал клиенту без «Перехватить» (например, реплаем) — бот в этом чате встаёт на паузу, говорим об этом
      await this.takeover(conv, adminId, { keepSetup: true });
    } else if (a?.mode && a.focus === "setup" && !this.setupFresh(a)) {
      // Уже ведёт этот диалог, а настройку точки открыл и давно не трогал: раз ответил клиенту реплаем,
      // дальше обычные сообщения снова идут клиенту — как после нового сообщения от него
      this.focusDialog(a, conv.id);
      this.save();
      await this.notifyAdmin(
        adminId,
        `Настройка точки не закончена, но обычные сообщения теперь снова уходят клиенту <b>${esc(conv.client.name || "Клиент")}</b>. Чтобы вернуться к настройке, нажмите «Писать в настройку».`,
        [[{ text: "✏️ Писать в настройку", callback_data: "s:focus" }]],
        conv.id
      );
    }
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
        `• Если бот не знает ответа, он пишет клиенту, что уточнит и скоро ответит, и зовёт вас.\n` +
        `• Если случилась ошибка, бот <b>не читает</b> сообщение и молча зовёт вас — непрочитанный чат будет у вас в списке, как обычно.\n` +
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
    let changed = false;
    for (const b of upcomingBookings(this.state, shop, { now: this.now() })) {
      if (b.remindedAt) continue;
      const left = minutesUntilStart(b, shop, this.now());
      if (left > this.cfg.reminderMinutes || left <= 0) continue;
      b.remindedAt = this.now();
      changed = true;
      // Не напоминаем о записи, сделанной перед самым визитом
      if (minutesUntilStart(b, shop, b.createdAt) < this.cfg.reminderMinutes + 30) continue;
      const conv = this.conv(b.client?.key);
      if (!conv) continue;
      const today = nowParts(shop.timezone, this.now()).date;
      const text = `Напоминаю: ${bookingLabel(b, today).replace(/–\d\d:\d\d$/, "")} у вас ${b.serviceName.toLowerCase()} у мастера ${b.staffName}. Ждём вас${
        shop.address ? ` по адресу ${[shop.city, shop.address].filter(Boolean).join(", ")}` : ""
      } 💈`;
      // Напоминание уходит, даже если диалог сейчас ведёт или ждёт мастер
      await this.deliver(conv, text, "bot", { notice: true }).catch((e) => this.log.warn("Напоминание:", e.message));
    }
    // Проверка идёт раз в минуту — без изменений не переписываем файл состояния
    if (changed) this.save();
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

  async notifyAdmins(text, keyboard, convId, { except } = {}) {
    const targets = Object.values(this.state.admins).filter((a) => a.notify !== false && Number(a.id) !== Number(except));
    // text — строка или функция от мастера: у каждого свой адресат обычных сообщений
    for (const a of targets) await this.notifyAdmin(a.id, typeof text === "function" ? text(a) : text, keyboard, convId);
    this.save();
  }

  // Технические сообщения (сбои импорта и т. п.) — только владельцам бота, не мастерам точки.
  // Переключатель «Уведомления» здесь не действует: он про переписки с клиентами.
  async notifyOwners(text, { except } = {}) {
    for (const a of Object.values(this.state.admins)) {
      if (this.role(a.id) !== "owner" || Number(a.id) === Number(except)) continue;
      await this.notifyAdmin(a.id, text);
    }
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
    if (h.hold) lines.push(`🕐 Клиенту пишу: «${esc(truncate(h.hold, 300))}»`);
    if (h.draft) lines.push(`📝 Черновик бота: «${esc(truncate(h.draft, 700))}»`);
    // Последняя строка — как ответить. Если обычное сообщение мастера сейчас ушло бы не этому клиенту
    // (в незакрытую настройку точки или другому клиенту), говорим об этом прямо в карточке
    // «Осталось непрочитанным» — только если это правда: «уточню» не уходило и бот ничего не отмечал прочитанным
    // (перед ответом, который потом не ушёл, он это уже сделал)
    const own = h.hold || !conv.unread?.length ? "Ответить можно прямо в своём Telegram." : "Сообщение осталось непрочитанным — можно ответить прямо в своём Telegram.";
    const how = (a) => {
      const where = this.elsewhereNote(a, conv);
      if (conv.kind === "business") return `<i>${where ? `${where} ` : ""}${own}</i>`;
      return `<i>${where ? `${where} ${REPLY_HERE}` : "Ответьте реплаем на это сообщение — я передам клиенту."}</i>`;
    };
    const kb = [[{ text: "✋ Взять диалог", callback_data: `c:take:${conv.id}` }]];
    if (h.draft) kb[0].push({ text: "✅ Отправить черновик", callback_data: `c:send:${conv.id}` });
    kb.push([
      { text: "🔁 Бот, попробуй ещё", callback_data: `c:retry:${conv.id}` },
      { text: "📜 Переписка", callback_data: `c:open:${conv.id}` },
    ]);
    await this.notifyAdmins((a) => [...lines, how(a)].join("\n"), kb, conv.id);
  }

  async notifyMoreFromClient(conv, text) {
    const head = `💬 <b>${esc(conv.client.name)}</b> (ждёт ответа): ${esc(truncate(text, 1000))}`;
    await this.notifyAdmins(
      (a) => {
        const where = this.elsewhereNote(a, conv);
        return where ? `${head}\n\n<i>${where} ${REPLY_HERE}</i>` : head;
      },
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
      const a = this.admin(id);
      const lines = [`💬 <b>${esc(conv.client.name)}</b>: ${esc(truncate(text, 3000))}`];
      const kb = [[{ text: "🤖 Вернуть боту", callback_data: `c:bot:${conv.id}` }]];
      // Обычный ответ мастера сейчас ушёл бы не этому клиенту (в настройку точки или в другой чат) —
      // говорим об этом сразу, иначе ответ снова пропадёт в «Обновляю настройки…»
      if (this.dialogFocus(a) !== conv.id) {
        if (a?.relayTo === conv.id && !this.setupFresh(a)) {
          // Настройку давно не трогали, а клиент пишет сейчас — диалог важнее
          this.focusDialog(a, conv.id);
          lines.push("", "<i>Настройка точки не закончена, но обычные сообщения теперь снова уходят этому клиенту.</i>");
          kb.push([{ text: "✏️ Писать в настройку", callback_data: "s:focus" }]);
        } else {
          const where = this.elsewhereNote(a, conv);
          lines.push("", `<i>${where ? `${where} ` : ""}Ответьте реплаем на это сообщение или нажмите «Писать сюда».</i>`);
          kb.unshift([{ text: "✍️ Писать сюда", callback_data: `c:write:${conv.id}` }]);
        }
      }
      await this.notifyAdmin(id, lines.join("\n"), kb, conv.id);
    }
    this.save();
  }
}

module.exports = { App, HOUR };
require("./console").install(App);
