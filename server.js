// Локальный запуск без зависимостей: node server.js → http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

// Подхватываем .env, если он есть
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const chat = require("./api/chat");
const config = require("./api/config");
const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/chat") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        req.body = body;
        chat(req, res);
      });
      return;
    }
    if (url.pathname === "/api/config") return config(req, res);

    const file = path.join(__dirname, "public", url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
    if (!file.startsWith(path.join(__dirname, "public"))) {
      res.statusCode = 403;
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.statusCode = 404;
        return res.end("Not found");
      }
      const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
      res.setHeader("content-type", types[path.extname(file)] || "application/octet-stream");
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`Демо запущено: http://localhost:${PORT}  (фитнес: /?b=fitness)`));
