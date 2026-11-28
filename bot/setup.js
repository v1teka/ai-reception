// Настройка точки силами ИИ: импорт с Яндекс.Карт и правки словами/скриншотами.
// Результат всегда — предложение (черновик), мастер подтверждает его кнопкой.
const { textOf, parseJson, LlmError } = require("./llm");
const { LLM_SHOP_SCHEMA, toLlmShop, fromLlmShop, emptyShop, normalizeShop, hoursText } = require("./shop");
const { fetchOrgText, describeFetch, parseOrgId, looksLikeCaptcha } = require("./yandex");
const { collectChecks } = require("./review");

const SETUP_SYSTEM = `Ты помогаешь мастеру барбершопа (или салона) настроить онлайн-администратора в Telegram. Верни данные точки строго по JSON-схеме.

Правила:
- Ничего не выдумывай. Чего нет в источнике — оставь пустым (при правке — как в текущих данных).
- Услуги: название; цена как в прайсе («1 800 ₽», «от 2 000 ₽»); длительность в минутах; slots = длительность / slot_minutes с округлением вверх. Обычно услуга занимает от 1 до 4 слотов. Если длительность не указана — поставь типичную для такой услуги и напиши об этом в doubts.
- График (hours): все 7 дней недели; closed = true — только настоящий выходной. Время в формате HH:MM. «Круглосуточно» — 00:00–24:00, до полуночи — close 24:00. Строка «График работы (из разметки карточки)» — точный график с карточки, бери его. «Открыто до 22:00», «Закрыто до 10:00» — это состояние на момент загрузки страницы, а не график: часы по нему не восстанавливай и в knowledge не переноси. Если графика в источнике нет, у всех дней closed = false, а open и close пустые.
- staff: имена мастеров, если они есть в источнике.
- knowledge: прочие факты, которые пригодятся в ответах клиентам (оплата, парковка, удобства, правила, акции, особенности). Один факт — одна строка. Не повторяй то, что уже есть в других полях.
- changes: коротко по-русски, что заполнено или изменено.
- doubts: что мастеру стоит проверить — где ты догадывался или источник противоречит сам себе. О том, чего в источнике просто нет (графика, цен, имён мастеров), не пиши: это бот проверит сам. Сомнений нет — пустой список.
- Нигде не называй модель, нейросеть или компанию, на которой ты работаешь.`;

const EDIT_RULES = `Это правка текущих данных. Меняй только то, о чём говорит мастер, остальное верни без изменений. Если мастер сообщает новый факт — добавь его в knowledge. Если просит что-то убрать — убери. Если в сообщении прайс или график — обнови соответствующие поля. Если менять нечего — верни данные как есть, а changes оставь пустым.`;

function images(list) {
  return (list || []).map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType || "image/jpeg", data: img.data },
  }));
}

// Что ИИ открывал через web_fetch и что получил: ошибки этого инструмента приходят
// не исключением, а блоком web_fetch_tool_result с error_code
function webFetchLog(content) {
  const asked = {};
  const out = [];
  for (const b of content || []) {
    if (b.type === "server_tool_use" && b.name === "web_fetch") asked[b.id] = b.input?.url;
    if (b.type !== "web_fetch_tool_result") continue;
    const c = b.content || {};
    const url = c.url || asked[b.tool_use_id] || "адрес неизвестен";
    if (c.type === "web_fetch_tool_result_error") out.push(`${url} → ошибка ${c.error_code}`);
    else {
      const data = typeof c.content?.source?.data === "string" ? c.content.source.data : "";
      out.push(`${url} → ${looksLikeCaptcha(url, data) ? "капча" : "открыта"}`);
    }
  }
  return out;
}

async function askForShop({ llm, cfg, content, tools, base }) {
  const messages = [{ role: "user", content }];
  const fetched = [];
  for (let step = 0; step < 4; step++) {
    const resp = await llm.create(
      {
        max_tokens: 16000,
        system: SETUP_SYSTEM,
        messages,
        ...(tools ? { tools } : {}),
        output_config: { effort: cfg.setupEffort, format: { type: "json_schema", schema: LLM_SHOP_SCHEMA } },
      },
      { timeoutMs: cfg.setupTimeoutMs }
    );
    fetched.push(...webFetchLog(resp.content));
    if (resp.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: resp.content });
      continue;
    }
    if (resp.stop_reason === "refusal") return { ok: false, reason: "ИИ отказался обрабатывать эти данные", fetched };
    const out = parseJson(textOf(resp));
    if (!out || !Array.isArray(out.services)) return { ok: false, reason: "ИИ вернул данные в неожиданном формате", fetched };
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []);
    return { ok: true, shop: fromLlmShop(out, base), changes: list(out.changes), doubts: list(out.doubts), fetched };
  }
  return { ok: false, reason: "ИИ не закончил разбор", fetched };
}

async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    // Исходный текст ошибки API (с названием провайдера и модели) уже в логе — в Telegram его не показываем
    if (e instanceof LlmError) return { ok: false, reason: e.reason };
    throw e;
  }
}

// Импорт новой точки по ссылке на Яндекс.Карты.
// Успех: { ok, shop, changes, checks, via, details }; checks — что показать администратору для проверки (review.js).
// При неудаче: reason — главная причина, details — что произошло на каждом шаге.
// Это техническая информация для владельца бота, мастеру её не показываем.
async function importFromYandex({ llm, cfg, url, prevShop, fetchImpl, log = console }) {
  const base = { ...emptyShop(prevShop), yandexUrl: url };
  const details = [];
  const page = await fetchOrgText(url, { fetchImpl, log });
  details.push(...page.pages.map(describeFetch));
  // График из разметки карточки точнее того, что ИИ понял из текста страницы: ставим его поверх
  const done = (r, via) => {
    let shop = r.shop;
    if (page.hours) {
      const fromPage = normalizeShop({ ...shop, hours: page.hours }, shop);
      if (hoursText(fromPage) !== hoursText(shop)) {
        log.info(`Импорт с Яндекс.Карт: график взят из разметки карточки (${hoursText(fromPage)}), у ИИ было: ${hoursText(shop)}`);
      }
      shop = fromPage;
    }
    return { ...r, shop, via, details, checks: collectChecks({ shop, notes: page.checks || [], doubts: r.doubts }) };
  };
  let reason = page.reason;
  if (page.ok) {
    if (!parseOrgId(page.url) && !parseOrgId(url)) {
      details.push("В ссылке нет номера организации: похоже, это ссылка на карту или поиск, а не на карточку");
    }
    const r = await safe(() =>
      askForShop({
        llm,
        cfg,
        base: { ...base, yandexUrl: page.url || url },
        content: `slot_minutes по умолчанию: ${base.slotMinutes}.\nНиже текст страницы организации с Яндекс.Карт (и вкладки «Цены», если она есть). Собери из него данные точки.\n\n${page.text}`,
      })
    );
    if (r.ok && r.shop.name) return done(r, "page");
    const why = r.ok ? "ИИ не нашёл на странице название организации" : r.reason;
    details.push(`Разбор страницы ИИ: ${why}`);
    reason = `не получилось разобрать карточку (${why})`;
  }

  // Запасной путь: страницу откроет сам ИИ через web_fetch
  if (cfg.yandexWebFetch) {
    const r = await safe(() =>
      askForShop({
        llm,
        cfg,
        base,
        tools: [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 }],
        content: `slot_minutes по умолчанию: ${base.slotMinutes}.\nОткрой карточку организации на Яндекс.Картах и её вкладку с ценами (обычно адрес карточки + "prices/"), затем собери данные точки. Если страница не открылась или там капча — верни пустые поля.\n\nСсылка: ${url}`,
      })
    );
    if (r.ok && r.shop.name) {
      log.warn("Импорт с Яндекс.Карт прошёл только через web_fetch:", url, "\n" + details.join("\n"));
      return done(r, "web_fetch");
    }
    const why = r.ok ? "ИИ не получил данных со страницы" : r.reason;
    const more = (r.fetched || []).filter(Boolean);
    details.push(`Запасной путь (ИИ сам открывает ссылку): ${why}${more.length ? `; ${more.join("; ")}` : ""}`);
  } else {
    details.push("Запасной путь (ИИ сам открывает ссылку): выключен (YANDEX_WEB_FETCH=off)");
  }
  log.warn("Импорт с Яндекс.Карт не удался:", url, "\n" + details.join("\n"));
  return { ok: false, reason, details };
}

// Правка словами или скриншотами: «по воскресеньям выходной», «стрижка теперь 2000», фото прайса.
// → { ok, shop, changes, checks } | { ok: false, reason }
async function updateFromMessage({ llm, cfg, shop, text, imageList }) {
  const content = [
    ...images(imageList),
    {
      type: "text",
      text: `${EDIT_RULES}\n\nТекущие данные точки (JSON):\n${JSON.stringify(toLlmShop(shop))}\n\nСообщение мастера:\n${
        text || (imageList?.length ? "(только изображения — извлеки из них данные)" : "")
      }`,
    },
  ];
  const r = await safe(() => askForShop({ llm, cfg, base: shop, content }));
  return r.ok ? { ...r, checks: collectChecks({ shop: r.shop, doubts: r.doubts }) } : r;
}

// Фото → текстовая заметка для «знаний»
async function noteFromImages({ llm, cfg, imageList, caption }) {
  return safe(async () => {
    const resp = await llm.create(
      {
        max_tokens: 4000,
        system: "Перепиши полезную для клиентов информацию с изображения в виде короткой заметки на русском. Без вступлений. Не упоминай, какая модель или нейросеть это сделала.",
        messages: [{ role: "user", content: [...images(imageList), { type: "text", text: caption || "Сделай заметку." }] }],
        output_config: { effort: "low" },
      },
      { timeoutMs: cfg.setupTimeoutMs }
    );
    const t = textOf(resp);
    return t ? { ok: true, text: t } : { ok: false, reason: "на изображении не нашлось текста" };
  });
}

module.exports = { importFromYandex, updateFromMessage, noteFromImages, SETUP_SYSTEM };
