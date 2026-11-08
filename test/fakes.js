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
    this.requests.push({ body, headers: req.headers, url: req.url });
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

// Фейковый YCLIENTS API: одна компания, два мастера, две услуги.
class FakeYclients {
  constructor() {
    this.requests = [];
    this.companyId = "555";
    this.company = { id: 555, title: "Барбершоп Борода", city: "Казань", address: "ул. Баумана, 10", phone: "+7 843 000-00-00", timezone_name: "Europe/Moscow" };
    this.services = [
      { id: 101, title: "Мужская стрижка", price_min: 1800, price_max: 1800, active: 1, comment: "" },
      { id: 102, title: "Борода", price_min: 900, price_max: 1200, active: 1, comment: "Контур и форма" },
    ];
    this.lengths = { 101: 3600, 102: 1800 };
    this.staff = [
      { id: 11, name: "Артём", bookable: true },
      { id: 12, name: "Илья", bookable: true },
    ];
    this.times = ["10:00", "11:00", "15:00"]; // свободно у каждого мастера, кроме занятого
    this.taken = new Set(); // "staff|date|time"
    this.records = {};
    this.seq = 9000;
    this.failNext = null; // { status, body }
  }

  async start() {
    const { server, url } = await listen((req, res) => this.handle(req, res));
    this.server = server;
    this.url = url + "/api/v1";
    return this;
  }

  of(re, method) {
    return this.requests.filter((r) => re.test(r.path) && (!method || r.method === method));
  }

  async handle(req, res) {
    const u = new URL(req.url, "http://x");
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : null;
    const path = u.pathname.replace(/^\/api\/v1\//, "");
    this.requests.push({ method: req.method, path, query: u.searchParams, body, headers: req.headers });
    const send = (status, json) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(json));
    };
    const ok = (data, status = 200) => send(status, { success: true, data, meta: [] });
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      return send(f.status, f.body);
    }
    if (req.headers.authorization !== "Bearer yc-partner") return send(401, { success: false, data: null, meta: { message: "Unauthorized" } });
    let m;
    if ((m = path.match(/^company\/(\d+)$/))) {
      return m[1] === this.companyId ? ok(this.company) : send(404, { success: false, meta: { message: "Компания не найдена" } });
    }
    if ((m = path.match(/^book_services\/(\d+)$/))) {
      const staffId = u.searchParams.get("staff_id");
      return ok({ services: this.services.map((s) => (staffId ? { ...s, seance_length: this.lengths[s.id] } : s)), category: [] });
    }
    if ((m = path.match(/^book_staff\/(\d+)$/))) return ok(this.staff);
    if ((m = path.match(/^book_dates\/(\d+)$/))) {
      // Работаем каждый день, кроме воскресенья; таймстемпы — полночь по Москве
      const out = [];
      for (let d = new Date(u.searchParams.get("date_from") + "T00:00:00+03:00"); d <= new Date(u.searchParams.get("date_to") + "T00:00:00+03:00"); d = new Date(d.getTime() + 86400000)) {
        const wd = new Date(d.getTime() + 3 * 3600000).getUTCDay();
        if (wd !== 0) out.push(Math.floor(d.getTime() / 1000));
      }
      return ok({ booking_dates: out, booking_days: {}, working_dates: out });
    }
    if ((m = path.match(/^book_times\/(\d+)\/(\d+)\/(\d{4}-\d\d-\d\d)$/))) {
      const [, , staff, date] = m;
      const sid = u.searchParams.getAll("service_ids[]")[0];
      const free = this.times.filter((t) => !this.taken.has(`${staff}|${date}|${t}`));
      return ok(free.map((time) => ({ time, seance_length: this.lengths[sid] || 3600, datetime: `${date}T${time}:00+03:00` })));
    }
    if ((m = path.match(/^book_record\/(\d+)$/)) && req.method === "POST") {
      const a = body.appointments[0];
      const [date, hm] = a.datetime.split(" ");
      const time = hm.slice(0, 5);
      let staff = String(a.staff_id);
      if (staff === "0") staff = String(this.staff.find((s) => !this.taken.has(`${s.id}|${date}|${time}`))?.id || 0);
      if (staff === "0" || this.taken.has(`${staff}|${date}|${time}`)) {
        return send(422, { success: false, data: null, meta: { message: "Выбранное время уже занято" }, errors: { code: 433, message: "Выбранное время уже занято" } });
      }
      this.taken.add(`${staff}|${date}|${time}`);
      const id = ++this.seq;
      const hash = "h" + id;
      const st = this.staff.find((s) => String(s.id) === staff);
      this.records[id] = { id, hash, staff: { id: st.id, name: st.name }, seance_length: this.lengths[a.services[0]], deleted: false, key: `${staff}|${date}|${time}`, body };
      return ok([{ id: 1, record_id: id, record_hash: hash }], 201);
    }
    if ((m = path.match(/^book_record\/(\d+)\/(\d+)\/(\w+)$/))) {
      const r = this.records[m[2]];
      if (!r || r.hash !== m[3]) return send(404, { success: false, meta: { message: "not found" } });
      return ok({ id: r.id, staff: r.staff, seance_length: r.seance_length, deleted: r.deleted });
    }
    if ((m = path.match(/^user\/records\/(\d+)\/(\w+)$/)) && req.method === "DELETE") {
      const r = this.records[m[1]];
      if (!r || r.hash !== m[2] || r.deleted) return send(404, { success: false, meta: { message: "not found" } });
      r.deleted = true;
      this.taken.delete(r.key);
      res.statusCode = 204;
      return res.end();
    }
    send(404, { success: false, meta: { message: `нет метода ${path}` } });
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

module.exports = { FakeTelegram, FakeAnthropic, FakeYclients, final, toolUse, tmpFile };
