#!/usr/bin/env node
// Управление ботом с сервера: заведения, администраторы, ссылки, свои боты у заведений.
//   node bot/cli.js help
//   docker exec <контейнер> node bot/cli.js list      — если бот запущен в Docker
// Команды уходят запущенному боту через unix-сокет (control.js); check работает и без него.
const fs = require("fs");
const net = require("net");
const path = require("path");

const HELP = `Управление ботом с сервера. Бот должен быть запущен: команды идут ему через сокет data/control.sock.

Заведения
  list                                   все заведения: ссылки, бот, администраторы
  show <заведение>                       данные заведения целиком
  add <ссылка на Яндекс.Карты>           новое заведение по карточке (загрузка — до пары минут)
  add <файл.json | ->                    новое заведение из готовых данных (формат — venues/README.md)
      --slug <ссылка>                    своя ссылка для клиентов: t.me/<бот>?start=<ссылка>
      --quiet                            не присылать ссылки владельцу в Telegram
  slug <заведение> <ссылка>              сменить ссылку для клиентов
  default <заведение>                    основное: в него попадает тот, кто открыл бота без ссылки
  delete <заведение> --yes               удалить (данные уедут в data/venues/_deleted)

Люди
  invite <заведение>                     одноразовая ссылка для администратора (7 дней)
  admin <заведение> <Telegram ID> [имя]  назначить администратором
  unadmin <заведение> <Telegram ID>      убрать из администраторов
  owner                                  новая ссылка «стать владельцем»

Свой бот у заведения
  newbot <заведение>                     ссылка Telegram «создать бота» (Managed Bots) — бот подключится сам
  bot <заведение> <токен | ->            подключить бота по токену от @BotFather («-» — токен со стандартного ввода)
      --rename                           дать боту название и описание заведения
  unbot <заведение>                      вернуть в общий бот (свой бот уйдёт в запас)
  pool                                   запас ботов
  pool add <токен | ->                   положить бота в запас
  pool use <заведение> [@бот]            подключить заведению бота из запаса

Без запущенного бота
  check <файл.json>                      проверить файл заведения для папки venues/

Прочее
  status                                 боты, владельцы, сколько заведений
  --json                                 ответ в JSON (для скриптов)
  --socket <путь>                        другой сокет (по умолчанию $CONTROL_SOCKET или $DATA_DIR/control.sock)

<заведение> — id (v2), ссылка (borodach) или название.`;

const VALUE_OPTS = new Set(["slug", "socket"]);

function parseArgs(argv) {
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    const m = a.match(/^--([a-z][a-z-]*)(?:=([\s\S]*))?$/);
    if (!m) args.push(a);
    else if (m[2] !== undefined) opts[m[1]] = m[2];
    else if (VALUE_OPTS.has(m[1]) && i + 1 < argv.length) opts[m[1]] = argv[++i];
    else opts[m[1]] = true;
  }
  return { args, opts };
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const parts = [];
    stream.on("data", (c) => parts.push(Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    stream.on("error", reject);
  });
}

function request(file, msg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(file);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Бот не ответил за ${Math.round(timeoutMs / 1000)} с`));
    }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify(msg) + "\n"));
    sock.on("data", (c) => (buf += c));
    sock.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error("Бот прислал непонятный ответ"));
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      const down = ["ENOENT", "ECONNREFUSED"].includes(e.code);
      reject(down ? new Error(`Бот не запущен или управление выключено: нет ${file}. Проверьте DATA_DIR и CONTROL_SOCKET.`) : e);
    });
  });
}

// Файл заведения для venues/: читается ли, что в нём, какая будет ссылка
function check(file) {
  const { readVenueFile, seedSlug } = require("./platform");
  const { renderFull } = require("./shop");
  const { checkLines } = require("./review");
  const { plain } = require("./util");
  if (!file) throw new Error("Укажите файл: check venues/<ссылка>.json");
  const seed = readVenueFile(file);
  const slug = seedSlug(path.basename(file, ".json"), seed);
  const text = [
    `Файл в порядке: ${seed.shop.name}`,
    "",
    plain(renderFull(seed.shop)),
    "",
    `Ссылка для клиентов: ${slug ? `t.me/<бот>?start=${slug}` : "придумается по названию (имя файла для ссылки не подходит)"}`,
    ...(seed.checks.length ? ["", "Проверьте:", ...checkLines(seed.checks, { html: false })] : []),
  ];
  return { result: { slug, shop: seed.shop, checks: seed.checks, notes: seed.checks.map((c) => c.text) }, text: text.join("\n") };
}

// → код выхода. Тесты зовут её напрямую, со своими env и потоками.
async function runCli(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin } = {}) {
  const { args, opts } = parseArgs(argv);
  const cmd = args.shift();
  const print = (s) => stdout.write(String(s).endsWith("\n") ? String(s) : `${s}\n`);
  const done = (res) => (print(opts.json ? JSON.stringify(res.result ?? null, null, 2) : res.text), 0);
  const fail = (message) => {
    if (opts.json) print(JSON.stringify({ ok: false, error: message }, null, 2));
    stderr.write(`${message}\n`);
    return 1;
  };
  if (!cmd || cmd === "help" || opts.help) return print(HELP), 0;

  try {
    if (cmd === "check") return done(check(args[0]));
    const send = { cmd, args, opts: { ...opts } };
    delete send.opts.json;
    delete send.opts.socket;
    // Токен — лучше со стандартного ввода: так он не остаётся в истории команд
    const tokenAt = cmd === "bot" ? 1 : cmd === "pool" && args[0] === "add" ? 1 : -1;
    if (tokenAt >= 0 && args[tokenAt] === "-") args[tokenAt] = (await readAll(stdin)).trim();
    // add <файл.json | -> — данные заведения уходят боту целиком
    if (cmd === "add" && args[0] && !/^https?:\/\//i.test(args[0])) {
      const src = args.shift();
      let raw;
      if (src === "-") raw = await readAll(stdin);
      else if (fs.existsSync(src)) raw = fs.readFileSync(src, "utf8");
      else throw new Error(`«${src}» — не ссылка и не файл`);
      try {
        send.opts.data = JSON.parse(raw);
      } catch (e) {
        throw new Error(`Данные заведения — не JSON: ${e.message}`);
      }
    }
    const { loadConfig } = require("./config");
    const socket = opts.socket || loadConfig(env).controlSocket;
    if (!socket) throw new Error("Управление с сервера выключено (CONTROL_SOCKET=off)");
    const res = await request(socket, send, cmd === "add" ? 6 * 60000 : 90000);
    if (!res.ok) return fail(res.error || "Ошибка");
    return done(res);
  } catch (e) {
    return fail(e.message);
  }
}

if (require.main === module) {
  require("./env").loadEnv();
  runCli(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(e);
      process.exitCode = 1;
    }
  );
}

module.exports = { runCli, parseArgs, HELP };
