// Фейковые Telegram Bot API и Anthropic API для интеграционных тестов.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

class FakeTelegram {
  constructor() {
    this.calls = [];
    this.msgId = 1000;
    this.files = {};
    this.updates = {};
    this.fail = null; // (method, params) → { code, description } — ответить ошибкой Telegram
  }

  async start() {
    const { server, url } = await listen((req, res) => this.handle(req, res));
    this.server = server;
    this.url = url;
    return this;
  }

  async handle(req, res) {
    const fileMatch = req.url.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (fileMatch) {
      const buf = this.files[fileMatch[2]];
      res.statusCode = buf ? 200 : 404;
      return res.end(buf || "");
    }
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)/);
    const raw = await readBody(req);
    const params = raw ? JSON.parse(raw) : {};
    const token = m[1];
    const method = m[2];
    this.calls.push({ token, method, params, at: Date.now() });
    const err = this.fail?.(method, params);
    if (err) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error_code: err.code || 400, description: err.description || "Bad Request" }));
    }
    let result = true;
    switch (method) {
      case "getMe":
        result = { id: token.startsWith("admin") ? 2 : 1, is_bot: true, first_name: "Test", username: token.startsWith("admin") ? "test_admin_bot" : "test_bot" };
        break;
      case "sendMessage":
      case "copyMessage":
        result = { message_id: ++this.msgId, chat: { id: params.chat_id }, date: 0, text: params.text };
        break;
      case "editMessageText":
        result = { message_id: params.message_id, chat: { id: params.chat_id }, text: params.text };
        break;
      case "getFile":
        result = { file_id: params.file_id, file_path: `photos/${params.file_id}.jpg` };
        break;
      case "getUpdates": {
        const q = (this.updates[token] || []).filter((u) => !params.offset || u.update_id >= params.offset);
        this.updates[token] = q;
        result = q;
        if (!q.length) await new Promise((r) => setTimeout(r, 50));
        break;
      }
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  }

  of(method, filter = () => true) {
    return this.calls.filter((c) => c.method === method && filter(c.params));
  }

  sentTo(chatId) {
    return this.of("sendMessage", (p) => String(p.chat_id) === String(chatId));
  }

  reset() {
    this.calls = [];
    this.fail = null;
  }

  close() {
    this.server.close();
  }
}

// Ответы задаются функцией respond(body, n) → объект ответа | { delayMs, response } | { status, error }
class FakeAnthropic {
  constructor() {
    this.requests = [];
    this.respond = () => final({ reply: "Ок", confidence: 0.9, handoff: false, handoff_reason: "" });
  }

  async start() {
    const { server, url } = await listen((req, res) => this.handle(req, res));
    this.server = server;
    this.url = url;
    return this;
  }

  async handle(req, res) {
    const body = JSON.parse(await readBody(req));
    this.requests.push({ body, headers: req.headers, url: req.url, at: Date.now() });
    let out = this.respond(body, this.requests.length);
    if (out && out.delayMs) {
      await new Promise((r) => setTimeout(r, out.delayMs));
      out = out.response;
    }
    if (res.destroyed) return;
    res.setHeader("content-type", "application/json");
    if (out && out.status) {
      res.statusCode = out.status;
      return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: out.error || "boom" } }));
    }
    res.end(JSON.stringify(out));
  }

  reset() {
    this.requests = [];
  }

  close() {
    this.server.closeAllConnections?.();
    this.server.close();
  }
}

let n = 0;
function message(content, stop_reason) {
  return {
    id: `msg_${++n}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

const final = (obj) => message([{ type: "text", text: JSON.stringify(obj) }], "end_turn");
const toolUse = (name, input, id = `tu_${++n}`) => message([{ type: "tool_use", id, name, input }], "tool_use");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "barber-bot-")), "state.json");
}

module.exports = { FakeTelegram, FakeAnthropic, final, toolUse, message, tmpFile };
