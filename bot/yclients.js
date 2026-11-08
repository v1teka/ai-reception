// YCLIENTS: клиент API онлайн-записи и импорт точки (услуги, мастера, контакты).
// Нужен только ключ партнёра (YCLIENTS_PARTNER_TOKEN) и ID компании (филиала) в YCLIENTS.
// Методы book_* — те же, что использует виджет онлайн-записи YCLIENTS: свободное время
// считает сам YCLIENTS, поэтому учитываются и записи, сделанные в салоне или через другие каналы.
// Документация: https://developers.yclients.com/ru/
const { normalizeShop, emptyShop } = require("./shop");

class YclientsError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = "YclientsError";
    this.status = status;
    this.code = code;
  }
}

// Код ошибки онлайн-записи (431–438) может прийти в разных местах тела ответа
function errorCode(body) {
  const cands = [body?.errors?.code, body?.meta?.errors?.code, body?.code, body?.data?.code, body?.meta?.code];
  for (const c of cands) if (Number.isFinite(Number(c)) && Number(c) > 0) return Number(c);
  return null;
}

function errorMessage(body) {
  const m = body?.meta?.message || body?.errors?.message || body?.message || body?.error;
  if (typeof m === "string" && m) return m;
  const errs = body?.meta?.errors || body?.errors;
  if (errs && typeof errs === "object") {
    const flat = Object.values(errs).flat().filter((x) => typeof x === "string");
    if (flat.length) return flat.join("; ");
  }
  return "";
}

class YclientsApi {
  constructor({ partnerToken, base = "https://api.yclients.com/api/v1", fetchImpl = (...a) => fetch(...a), timeoutMs = 10000, log = console } = {}) {
    this.partnerToken = partnerToken;
    this.base = base.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.cache = new Map();
  }

  async request(method, path, { query, body, timeoutMs } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) for (const x of v) qs.append(`${k}[]`, String(x));
      else qs.append(k, String(v));
    }
    const url = `${this.base}/${path}${qs.toString() ? `?${qs}` : ""}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || this.timeoutMs);
    let res, text;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/vnd.yclients.v2+json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.partnerToken}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (e) {
      throw new YclientsError(e.name === "AbortError" ? "YCLIENTS не ответил вовремя" : `YCLIENTS недоступен: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new YclientsError(`YCLIENTS вернул не JSON (HTTP ${res.status})`, { status: res.status });
    }
    if (!res.ok || json?.success === false) {
      throw new YclientsError(errorMessage(json) || `HTTP ${res.status}`, { status: res.status, code: errorCode(json) });
    }
    return json?.data;
  }

  async cached(key, ttlMs, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  company(companyId) {
    return this.request("GET", `company/${companyId}`);
  }

  bookServices(companyId, { staffId, serviceIds } = {}) {
    return this.request("GET", `book_services/${companyId}`, { query: { staff_id: staffId, service_ids: serviceIds } });
  }

  bookStaff(companyId, { serviceIds } = {}) {
    return this.request("GET", `book_staff/${companyId}`, { query: { service_ids: serviceIds } });
  }

  bookDates(companyId, { serviceIds, staffId, dateFrom, dateTo } = {}) {
    return this.request("GET", `book_dates/${companyId}`, {
      query: { service_ids: serviceIds, staff_id: staffId, date_from: dateFrom, date_to: dateTo },
    });
  }

  bookTimes(companyId, staffId, date, { serviceIds } = {}) {
    return this.request("GET", `book_times/${companyId}/${staffId || 0}/${date}`, { query: { service_ids: serviceIds } });
  }

  bookRecord(companyId, payload) {
    return this.request("POST", `book_record/${companyId}`, { body: payload });
  }

  getBookRecord(companyId, recordId, hash) {
    return this.request("GET", `book_record/${companyId}/${recordId}/${hash}`);
  }

  deleteUserRecord(recordId, hash) {
    return this.request("DELETE", `user/records/${recordId}/${hash}`);
  }
}

// ---------- разбор ввода мастера ----------

// ID компании из ссылки на виджет/кабинет YCLIENTS или просто числом
function parseCompanyId(text) {
  const s = String(text || "");
  const m =
    s.match(/^\s*(\d{3,})\s*$/) ||
    s.match(/yclients\.\w+\/(?:[^\s]*?\/)?company\/(\d{3,})/i) ||
    s.match(/\bcompany[_/=:\s-]*(?:id)?[=:\s/]*(\d{3,})/i) ||
    s.match(/(?:^|\D)(\d{4,9})(?:\D|$)/);
  return m ? m[1] : null;
}

// Телефон в формате YCLIENTS: 79001234567
function normalizePhone(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  if (d.length === 10 && d[0] === "9") d = "7" + d;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

function fmtRub(n) {
  return Math.round(Number(n)).toLocaleString("ru-RU").replace(/ |,/g, " ");
}

function priceText(s) {
  const min = Number(s.price_min) || 0;
  const max = Number(s.price_max) || 0;
  if (!min && !max) return "";
  if (!max || max === min) return `${fmtRub(min || max)} ₽`;
  if (!min) return `до ${fmtRub(max)} ₽`;
  return `${fmtRub(min)}–${fmtRub(max)} ₽`;
}

const listOf = (data, key) => (Array.isArray(data) ? data : Array.isArray(data?.[key]) ? data[key] : []);

// ---------- импорт точки ----------

function ycReason(e, companyId) {
  if (!(e instanceof YclientsError)) return "внутренняя ошибка";
  if (e.status === 401) return "YCLIENTS не принял ключ партнёра (YCLIENTS_PARTNER_TOKEN)";
  if (e.status === 403) return `нет доступа к компании ${companyId}: подключите наше приложение в YCLIENTS или проверьте, что онлайн-запись включена`;
  if (e.status === 404) return `компания с ID ${companyId} не найдена в YCLIENTS`;
  return e.message;
}

async function importFromYclients({ api, companyId, prevShop, log = console }) {
  if (!api) return { ok: false, reason: "не задан ключ партнёра YCLIENTS (YCLIENTS_PARTNER_TOKEN)" };
  let company, servicesData, staffData;
  try {
    [company, servicesData, staffData] = await Promise.all([
      api.company(companyId),
      api.bookServices(companyId),
      api.bookStaff(companyId),
    ]);
  } catch (e) {
    return { ok: false, reason: ycReason(e, companyId) };
  }
  const ycServices = listOf(servicesData, "services").filter((s) => s && s.id && s.title && s.active !== 0 && s.active !== false);
  const ycStaff = listOf(staffData, "staff").filter((s) => s && s.id && s.name && s.bookable !== false && !s.fired && !s.hidden);

  // Длительность услуги YCLIENTS отдаёт только в разрезе мастера — спрашиваем у нескольких
  const durations = new Map();
  for (const st of ycStaff.slice(0, 6)) {
    try {
      const d = await api.bookServices(companyId, { staffId: st.id });
      for (const s of listOf(d, "services")) {
        const len = Number(s.seance_length) || 0;
        if (len > 0 && !durations.has(String(s.id))) durations.set(String(s.id), Math.round(len / 60));
      }
    } catch (e) {
      log.warn("YCLIENTS длительности:", e.message);
    }
  }

  const base = prevShop && !prevShop.demo ? prevShop : emptyShop(prevShop);
  const slot = base.slotMinutes || 30;
  const tz = typeof company?.timezone_name === "string" && company.timezone_name.includes("/") ? company.timezone_name : base.timezone;
  const city = typeof company?.city === "string" ? company.city : company?.city?.title || base.city || "";
  const knowledge = [...(base.knowledge || [])];
  const schedule = typeof company?.schedule === "string" ? company.schedule.trim() : "";
  if (schedule && !knowledge.some((k) => k.text.startsWith("График (из YCLIENTS)"))) {
    knowledge.push({ id: null, text: `График (из YCLIENTS): ${schedule}` });
  }

  const shop = normalizeShop(
    {
      ...base,
      demo: false,
      demoBusy: false,
      name: company?.title || company?.public_title || base.name,
      city,
      address: company?.address || base.address,
      phone: company?.phone || (Array.isArray(company?.phones) ? company.phones[0] : "") || base.phone,
      site: company?.site || base.site,
      description: base.description || (typeof company?.short_descr === "string" ? company.short_descr : ""),
      timezone: tz,
      staff: ycStaff.map((s) => ({ name: s.name, ycId: String(s.id) })),
      services: ycServices.map((s) => {
        const dur = durations.get(String(s.id)) || 0;
        return {
          name: s.title,
          price: priceText(s),
          duration_minutes: dur || slot,
          durationMin: dur || undefined,
          description: typeof s.comment === "string" ? s.comment : "",
          ycId: String(s.id),
        };
      }),
      knowledge,
      yclients: { companyId: String(companyId), title: company?.title || "", syncedAt: Date.now() },
      updatedAt: Date.now(),
    },
    // id услуг и мастеров берём из прошлой версии, только если она тоже из YCLIENTS
    base.yclients ? base : undefined
  );

  const changes = [
    `Из YCLIENTS: ${shop.services.length} услуг, ${ycStaff.length} мастеров.`,
    "Свободное время бот будет брать из YCLIENTS в реальном времени, записи сразу попадут в журнал YCLIENTS.",
    "Для записи бот обязательно спросит телефон клиента — без него YCLIENTS запись не примет.",
    "Проверьте, что в YCLIENTS выключено подтверждение онлайн-записи по SMS-коду, иначе бот не сможет записывать.",
  ];
  if (!ycServices.length) changes.unshift("⚠️ В YCLIENTS нет услуг, доступных для онлайн-записи. Включите онлайн-запись для нужных услуг.");
  if (!ycStaff.length) changes.unshift("⚠️ В YCLIENTS нет мастеров, доступных для онлайн-записи.");
  const noDur = shop.services.filter((s) => !s.durationMin).length;
  if (noDur && ycServices.length) changes.push(`У ${noDur} услуг YCLIENTS не отдал длительность — указал ${slot} мин (на запись это не влияет).`);
  return { ok: true, shop, changes, company };
}

module.exports = { YclientsApi, YclientsError, importFromYclients, parseCompanyId, normalizePhone, priceText, listOf };
