// Подхватываем .env из корня проекта, если он есть: переменные, уже заданные в окружении, важнее
const fs = require("fs");
const path = require("path");

function loadEnv(file = path.join(__dirname, "..", ".env"), env = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || env[m[1]]) continue;
    const v = m[2].trim();
    env[m[1]] = /^["']/.test(v) ? v.replace(/^["']|["']$/g, "") : v.replace(/\s+#.*$/, "");
  }
}

module.exports = { loadEnv };
