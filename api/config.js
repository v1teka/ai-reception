// GET /api/config?b=salon|fitness — публичные данные для шапки чата
const { publicConfig } = require("../lib/chat");

module.exports = (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(publicConfig(url.searchParams.get("b"))));
};
