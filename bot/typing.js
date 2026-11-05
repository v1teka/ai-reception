// «Печатает…»: длительность пропорциональна длине ответа, но быстро.
// По умолчанию: 0,4 с + 12 мс на символ, не меньше 0,8 с и не больше 4 с
// (≈ 80 символов в секунду — заметно, но не раздражает).
const { clamp } = require("./util");

function typingDuration(text, { baseMs = 400, perCharMs = 12, minMs = 800, maxMs = 4000 } = {}) {
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
