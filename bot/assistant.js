// ИИ-администратор: отвечает клиенту, смотрит свободное время и записывает через инструменты.
// Итог каждого хода — JSON: ответ + уверенность + нужен ли мастер.
const { textOf, parseJson, LlmError } = require("./llm");
const { renderForPrompt } = require("./shop");
const { nowParts, addDays, fmtDate, fmtTime, WEEKDAY_LONG } = require("./time");
const { upcomingBookings, bookingForTool } = require("./schedule");
const { localBackend } = require("./booking");

const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "confidence", "handoff", "handoff_reason"],
  properties: {
    reply: {
      type: "string",
      description: "Сообщение клиенту. Если нужен мастер — черновик ответа для мастера (можно пустую строку).",
    },
    confidence: { type: "number", description: "От 0 до 1: насколько ответ опирается на данные точки и результаты инструментов" },
    handoff: { type: "boolean", description: "true, если переписку нужно передать мастеру" },
    handoff_reason: { type: "string", description: "Коротко, почему нужен мастер; пустая строка, если не нужен" },
  },
};

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });

const TOOLS = [
  {
    name: "get_free_slots",
    description:
      "Свободное время для записи на услугу. Сам учитывает длительность услуги (сколько слотов она занимает), график, занятые окна и минимальное время до записи. Возвращает по дням времена начала для каждого мастера. Вызывай перед тем, как называть клиенту любое время.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["service_id", "date_from", "days", "staff_id"],
      properties: {
        service_id: { type: "string", description: "id услуги из списка, например s1" },
        date_from: { type: "string", description: "С какой даты смотреть, YYYY-MM-DD" },
        days: { type: "integer", description: "Сколько дней смотреть, от 1 до 7" },
        staff_id: nullable({ type: "string", description: "id мастера, если клиент хочет конкретного" }),
      },
    },
  },
  {
    name: "create_booking",
    description:
      "Записать клиента. Время должно быть одним из свободных по get_free_slots. Если время заняли, вернёт ошибку и ближайшие варианты.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["service_id", "date", "time", "staff_id", "client_name", "phone", "comment"],
      properties: {
        service_id: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM — время начала" },
        staff_id: nullable({ type: "string", description: "id мастера или null — тогда любой свободный" }),
        client_name: { type: "string" },
        phone: nullable({ type: "string" }),
        comment: nullable({ type: "string", description: "Пожелания клиента, если есть" }),
      },
    },
  },
  {
    name: "list_client_bookings",
    description: "Предстоящие записи этого клиента (для переноса, отмены или напоминания).",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
  {
    name: "cancel_booking",
    description: "Отменить запись этого клиента по booking_id. Для переноса: отменить старую и создать новую.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["booking_id"],
      properties: { booking_id: { type: "string" } },
    },
  },
];

function stablePrompt(shop) {
  return `Ты — онлайн-администратор точки «${shop.name || "барбершоп"}» в Telegram. Отвечаешь клиентам 24/7: про услуги, цены, мастеров, адрес и график, подбираешь свободное время и записываешь. Это живой чат: отвечай сразу, без долгих размышлений.

Как писать:
- Как хороший администратор в мессенджере: коротко (обычно 1–3 предложения), тепло, по делу, на «вы».
- Эмодзи — не больше одного и не в каждом сообщении.
- Без markdown: никаких звёздочек, решёток и списков с дефисами. Варианты времени перечисляй через запятую.
- Отвечай на языке клиента.
- Не называй себя ботом без повода. Если клиент прямо спрашивает, с роботом ли он общается, честно скажи, что ты онлайн-помощник точки и мастер может подключиться к переписке.

Запись:
- Свободное время узнавай только через get_free_slots и никогда не придумывай его. Если клиент назвал день — смотри с этого дня; если нет — предложи 2–4 ближайших варианта.
- Услуга занимает несколько слотов подряд (обычно от 1 до 4), инструменты это учитывают сами — просто передавай id услуги.
- Если непонятно, какая услуга нужна, уточни одним вопросом.
- Для записи нужны услуга, дата и время из свободных и имя. ${
    shop.yclients
      ? "Телефон обязателен: запись уходит в журнал салона (YCLIENTS) и без номера не пройдёт. Если клиент не хочет давать номер — объясни это и предложи позвать мастера."
      : "Телефон попроси, но если клиент не хочет — записывай без него."
  }
- Когда всё известно и клиент согласился на конкретное время — вызывай create_booking. Потом подтверди одной фразой: услуга, день и время, мастер, адрес.
- Перенос: cancel_booking старой записи и create_booking новой. Отмена — cancel_booking.

Когда звать мастера (handoff = true):
- клиент просит живого человека или мастера, жалуется, недоволен;
- в данных ниже нет ответа и пришлось бы выдумывать факт о точке;
- нестандартное: скидки и торг, особые условия, здоровье (аллергия, раздражение кожи), группа людей, просьба, которую решает только мастер;
- сообщение непонятно.
Тогда в handoff_reason коротко напиши причину, а в reply — черновик ответа, который мастер сможет отправить одним нажатием (или пустую строку).

confidence (от 0 до 1):
- 0.9–1 — ответ прямо следует из данных точки или результатов инструментов;
- 0.6–0.8 — уточняющий вопрос, приветствие, small talk, общий ответ без новых фактов о точке;
- ниже 0.5 — пришлось догадываться или ответа в данных нет.

Итог каждого хода — JSON по схеме: reply, confidence, handoff, handoff_reason.

Данные точки:
${renderForPrompt(shop)}`;
}

function dynamicPrompt({ shop, conv, state, now }) {
  const cur = nowParts(shop.timezone, now);
  const days = [];
  for (let i = 0; i < Math.min(shop.bookingDays, 14); i++) {
    const d = addDays(cur.date, i);
    days.push(`${i === 0 ? "сегодня " : i === 1 ? "завтра " : ""}${fmtDate(d)} = ${d}`);
  }
  const bookings = upcomingBookings(state, shop, { clientKey: conv.id, now });
  const client = conv.client || {};
  const lines = [
    `Сейчас ${WEEKDAY_LONG[cur.weekday]}, ${fmtDate(cur.date)}, ${fmtTime(cur.minutes)} по времени точки (${shop.timezone}).`,
    `Календарь: ${days.join("; ")}.`,
    `Клиент в Telegram: ${client.name || "без имени"}${client.username ? ` (@${client.username})` : ""}.${
      conv.phone ? ` Телефон из прошлых записей: ${conv.phone}.` : ""
    }${conv.knownName ? ` Записывался как: ${conv.knownName}.` : ""}`,
    bookings.length
      ? `Предстоящие записи клиента: ${bookings
          .map((b) => `${b.id} — ${b.serviceName}, ${fmtDate(b.date)} ${fmtTime(b.start)}, мастер ${b.staffName}`)
          .join("; ")}.`
      : "Предстоящих записей у клиента нет.",
  ];
  return lines.join("\n");
}

// История разговора в формате Messages API (только текст, без старых thinking-блоков).
function buildMessages(conv, limit = 30) {
  const items = conv.messages.filter((m) => !m.service).slice(-limit);
  const out = [];
  for (const m of items) {
    const role = m.role === "client" ? "user" : "assistant";
    const text = m.role === "admin" ? `[ответил мастер] ${m.text}` : m.text;
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += "\n" + text;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

// backend — где живёт расписание: в боте или в YCLIENTS (см. booking.js)
async function runTool(name, input, ctx) {
  const { state, shop, conv, now } = ctx;
  const backend = ctx.backend || localBackend(state, shop);
  switch (name) {
    case "get_free_slots": {
      const r = await backend.freeSlots({
        serviceId: input.service_id,
        dateFrom: input.date_from,
        days: input.days,
        staffId: input.staff_id,
        now,
      });
      return { content: JSON.stringify(r), isError: Boolean(r.error) };
    }
    case "create_booking": {
      const r = await backend.book({
        serviceId: input.service_id,
        date: input.date,
        time: input.time,
        staffId: input.staff_id,
        comment: input.comment,
        client: {
          key: conv.id,
          name: input.client_name || conv.client?.name || "",
          phone: input.phone || conv.phone || "",
          tgId: conv.client?.id,
          username: conv.client?.username || "",
        },
        now,
      });
      if (!r.ok) return { content: JSON.stringify({ error: r.error }), isError: true };
      if (input.phone) conv.phone = input.phone;
      if (input.client_name) conv.knownName = input.client_name;
      return {
        content: JSON.stringify({ ok: true, booking: bookingForTool(r.booking, shop, now), address: [shop.city, shop.address].filter(Boolean).join(", ") }),
        effect: { type: "booked", booking: r.booking },
      };
    }
    case "list_client_bookings": {
      const list = upcomingBookings(state, shop, { clientKey: conv.id, now }).map((b) => bookingForTool(b, shop, now));
      return { content: JSON.stringify({ bookings: list }) };
    }
    case "cancel_booking": {
      const r = await backend.cancel(input.booking_id, { clientKey: conv.id, by: "client", now });
      if (!r.ok) return { content: JSON.stringify({ error: r.error }), isError: true };
      return {
        content: JSON.stringify({ ok: true, cancelled: bookingForTool(r.booking, shop, now) }),
        effect: { type: "cancelled", booking: r.booking },
      };
    }
    default:
      return { content: JSON.stringify({ error: `Неизвестный инструмент ${name}` }), isError: true };
  }
}

// Один ход ассистента. Никогда не бросает: возвращает reply / handoff / error.
async function generateReply({ llm, cfg, state, shop, conv, backend, now = Date.now(), log = console }) {
  const effects = [];
  const deadline = Date.now() + cfg.llmTimeoutMs;
  const messages = buildMessages(conv);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return { kind: "error", reason: "нечего отвечать", effects };
  }
  const system = [
    { type: "text", text: stablePrompt(shop), cache_control: { type: "ephemeral" } },
    { type: "text", text: dynamicPrompt({ shop, conv, state, now }) },
  ];

  try {
    for (let step = 0; step < (cfg.maxSteps || 6); step++) {
      const left = deadline - Date.now();
      if (left < 500) throw new LlmError("ИИ не ответил вовремя (таймаут)");
      const resp = await llm.create(
        {
          max_tokens: 4000,
          system,
          tools: TOOLS,
          messages,
          output_config: { effort: cfg.effort, format: { type: "json_schema", schema: REPLY_SCHEMA } },
        },
        { timeoutMs: left }
      );

      if (resp.stop_reason === "refusal") return { kind: "handoff", reason: "ИИ отказался отвечать на это сообщение", draft: "", effects };
      if (resp.stop_reason === "max_tokens") return { kind: "error", reason: "ответ ИИ оборвался (лимит токенов)", effects };
      if (resp.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: resp.content });
        continue;
      }

      const toolUses = (resp.content || []).filter((b) => b.type === "tool_use");
      if (toolUses.length) {
        // Блоки ответа (включая thinking) возвращаем как есть
        messages.push({ role: "assistant", content: resp.content });
        // По очереди: запись и отмена меняют расписание
        const results = [];
        for (const tu of toolUses) {
          let r;
          try {
            r = await runTool(tu.name, tu.input || {}, { state, shop, conv, now, backend });
          } catch (e) {
            log.error("Инструмент", tu.name, e);
            r = { content: JSON.stringify({ error: "внутренняя ошибка инструмента" }), isError: true };
          }
          if (r.effect) effects.push(r.effect);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      const out = parseJson(textOf(resp));
      if (!out || typeof out.reply !== "string") {
        return { kind: "error", reason: "ИИ вернул ответ в неожиданном формате", effects };
      }
      const confidence = Math.max(0, Math.min(1, Number(out.confidence) || 0));
      const reply = out.reply.trim();
      if (out.handoff) {
        return { kind: "handoff", reason: out.handoff_reason || "бот просит помощи мастера", draft: reply, confidence, effects };
      }
      if (!reply) return { kind: "handoff", reason: "бот не нашёл, что ответить", draft: "", confidence, effects };
      if (confidence < cfg.confidenceThreshold) {
        return {
          kind: "handoff",
          reason: `бот не уверен в ответе (${Math.round(confidence * 100)}%)${out.handoff_reason ? `: ${out.handoff_reason}` : ""}`,
          draft: reply,
          confidence,
          effects,
        };
      }
      return { kind: "reply", text: reply, confidence, effects };
    }
    return { kind: "error", reason: "ИИ сделал слишком много шагов", effects };
  } catch (e) {
    if (e instanceof LlmError) return { kind: "error", reason: e.reason, effects };
    log.error("Ассистент:", e);
    return { kind: "error", reason: "внутренняя ошибка бота", effects };
  }
}

module.exports = { generateReply, buildMessages, runTool, TOOLS, REPLY_SCHEMA, stablePrompt, dynamicPrompt };
