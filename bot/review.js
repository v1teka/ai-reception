// Проверка данных точки: что бот подсвечивает администратору, прежде чем по этим данным начнут отвечать
// и записывать клиентов, — после импорта с Яндекс.Карт, правки словами, в «Заведение создано» и при входе
// приглашённого администратора. Проверка { level, text }:
//   error — с такими данными бот не сможет работать: записывать, называть часы работы;
//   warn  — сомнительное: что-то не нашлось или ИИ пришлось догадываться.
// Только то, что меняет работу бота: длинный список «на всякий случай» перестают читать.
const { hoursKnown } = require("./shop");
const { esc, truncate } = require("./util");

const error = (text) => ({ level: "error", text });
const warn = (text) => ({ level: "warn", text });

// Сколько услуг: «у 4 услуг», «у 21 услуги»
const servicesGen = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "услуги" : "услуг"}`;

// Точка без имён мастеров: normalizeShop подставляет одного «Мастера»
const placeholderStaff = (shop) => shop.staff.length === 1 && shop.staff[0].name === "Мастер";

// Проверки самих данных — их можно пересчитать в любой момент
function reviewShop(shop) {
  const out = [];
  if (!hoursKnown(shop)) {
    out.push(
      error(
        "График работы не указан: пока его нет, бот не записывает клиентов, а на вопросы о часах работы зовёт вас. Пришлите график словами, например: «пн–пт 10–21, сб–вс 11–20»."
      )
    );
  }
  if (!shop.services.length) {
    out.push(error("Нет ни одной услуги — записывать клиентов не на что. Пришлите прайс: фото или текстом."));
  }
  const noPrice = shop.services.filter((s) => !s.price);
  if (noPrice.length) {
    const which = noPrice.length <= 3 ? `Без цены: ${noPrice.map((s) => `«${s.name}»`).join(", ")}` : `Нет цены у ${servicesGen(noPrice.length)} из ${shop.services.length}`;
    out.push(warn(`${which} — стоимость бот не назовёт.`));
  }
  if (placeholderStaff(shop)) {
    out.push(
      warn("Имена мастеров не указаны — бот записывает всех к одному «Мастеру»: на одно время только один клиент. Если мастеров несколько, напишите их имена.")
    );
  }
  return out;
}

// Всё, что проверить, одним списком: сначала то, что ломает работу бота, без повторов.
// notes — проверки из источника (карточка Яндекса: перерывы, работа после полуночи, «больше не работает»);
// doubts — строки, в которых не уверен ИИ (или пометки notes из файла venues/<ссылка>.json).
function collectChecks({ shop, notes = [], doubts = [] }) {
  const all = [
    ...notes,
    ...reviewShop(shop),
    ...(Array.isArray(doubts) ? doubts : [])
      .map((d) => (typeof d === "string" ? d.trim() : ""))
      .filter(Boolean)
      .slice(0, 10)
      .map((d) => warn(truncate(d, 300))),
  ];
  const seen = new Set();
  const unique = all.filter((c) => c?.text && !seen.has(c.text) && seen.add(c.text));
  return [...unique.filter((c) => c.level === "error"), ...unique.filter((c) => c.level !== "error")];
}

// Строки для сообщения: «❗ …» — бот так работать не сможет, «• …» — проверить. html — экранировать для Telegram
function checkLines(checks, { html = true } = {}) {
  return (checks || []).map((c) => `${c.level === "error" ? "❗" : "•"} ${html ? esc(c.text) : c.text}`);
}

const hasErrors = (checks) => (checks || []).some((c) => c.level === "error");

module.exports = { reviewShop, collectChecks, checkLines, hasErrors };
