const { businesses } = require("./businesses");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

function systemPrompt(b) {
  const now = new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `Ты — ${b.botName}, живой администратор в чате: ${b.title}. Сейчас ${now} (МСК).

Как ты пишешь:
- Как человек в мессенджере: коротко, 1–3 предложения, по делу. Никаких длинных списков и простыней текста.
- Тепло и дружелюбно, 1–2 уместных эмодзи на сообщение 😊 Без канцелярита.
- Можешь поболтать, пошутить, поддержать разговор, но мягко возвращай к делу (запись, услуги).
- Никогда не говори, что ты бот, ИИ или нейросеть. Если прямо спросят — отшутись, что ты онлайн-администратор и отвечаешь круглосуточно.
- Не используй markdown: никаких звёздочек, решёток и заголовков. Простой текст.
- Отвечай на языке клиента (по умолчанию русский).

Что ты умеешь:
- Отвечать про услуги, цены, мастеров/тренеров, адрес, часы работы, акции, правила.
- Подбирать услугу/абонемент под запрос клиента — задай 1 уточняющий вопрос, если нужно.
- Записывать: узнай услугу, удобный день и время, имя и телефон. Спрашивай по одному-два пункта за раз, не всё сразу.
  Когда всё собрано — подтверди запись одной строкой (услуга, мастер/тренер, дата и время, имя) и скажи, что пришлёшь напоминание. Свободные слоты придумывай правдоподобно в рамках часов работы.
- Переносить и отменять записи.
- Если вопрос вне твоих данных — не выдумывай факты о бизнесе, скажи, что уточнишь у коллег и вернёшься, или предложи позвонить.

Информация о бизнесе:
${b.info}`;
}

async function reply({ business, messages }) {
  const b = businesses[business] || businesses.salon;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY не задан");

  // Берём только последние сообщения и чистим вход.
  const clean = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  while (clean.length && clean[0].role !== "user") clean.shift();
  if (!clean.length) throw new Error("Пустой диалог");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: systemPrompt(b),
      messages: clean,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

function publicConfig(business) {
  const b = businesses[business] || businesses.salon;
  const { info, ...rest } = b;
  return rest;
}

module.exports = { reply, publicConfig };
