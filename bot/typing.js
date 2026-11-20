// «Печатает…»: длительность пропорциональна длине ответа.
// По умолчанию: 1 с + 50 мс на символ, не меньше 2 с и не больше 12 с
// (≈ 20 символов в секунду: быстрее, чем человек печатает с телефона, но уже не мгновенно —
// слишком быстрый ответ выдаёт бота).
const { clamp } = require("./util");

function typingDuration(text, { baseMs = 1000, perCharMs = 50, minMs = 2000, maxMs = 12000 } = {}) {
  const len = String(text || "").length;
  return Math.round(clamp(baseMs + len * perCharMs, minMs, maxMs));
}

// Длинный ответ — несколькими «пузырями», как пишет человек: по пустым строкам, максимум 3.
function splitReply(text, maxParts = 3) {
  const parts = String(text || "")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= maxParts) return parts;
  return [...parts.slice(0, maxParts - 1), parts.slice(maxParts - 1).join("\n\n")];
}

module.exports = { typingDuration, splitReply };
