// Serverless-функция для Vercel: POST /api/chat
const { reply } = require("../lib/chat");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const text = await reply(body);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ reply: text }));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Не получилось ответить, попробуйте ещё раз 🙏" }));
  }
};
