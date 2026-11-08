// Где живёт расписание: в самом боте (schedule.js) или в YCLIENTS.
// У обоих вариантов одинаковый асинхронный интерфейс:
//   freeSlots({ serviceId, dateFrom, days, staffId, now, maxPerDay }) → как findFreeSlots
//   book({ serviceId, date, time, staffId, client, comment, now })     → { ok, booking } | { ok: false, error }
//   cancel(bookingId, { clientKey, by, now })                           → { ok, booking } | { ok: false, error }
//   stillActive(booking)                                                → false, если запись удалили на стороне CRM
// Записи, сделанные ботом, в любом случае хранятся и в state.bookings — для панели, отмены и напоминаний.
const schedule = require("./schedule");
const { findService, findStaff } = require("./shop");
const { nowParts, isDate, addDays, diffDays, parseTime, fmtDateRelative, fmtDuration } = require("./time");
const { clamp } = require("./util");
const { YclientsError, normalizePhone, listOf } = require("./yclients");

function localBackend(state, shop) {
  return {
    kind: "local",
    async freeSlots(args) {
      return schedule.findFreeSlots(state, shop, args);
    },
    async book(args) {
      return schedule.createBooking(state, shop, args);
    },
    async cancel(id, opts) {
      return schedule.cancelBooking(state, id, opts);
    },
    async stillActive() {
      return true;
    },
  };
}

// Пул с ограничением параллельности: YCLIENTS разрешает ~5 запросов в секунду
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

const YC_STAFF_PREFIX = "y";

// Мастер из ответа YCLIENTS → наш мастер (или временный id, если его ещё нет в данных точки)
function staffFromYc(shop, ycStaff) {
  const ycId = String(ycStaff.id);
  const known = shop.staff.find((s) => s.ycId === ycId);
  return known ? { id: known.id, name: known.name, ycId } : { id: YC_STAFF_PREFIX + ycId, name: ycStaff.name || "Мастер", ycId };
}

function resolveStaff(shop, staffId) {
  if (!staffId) return { any: true };
  const st = findStaff(shop, staffId);
  if (st) return st.ycId ? st : { error: `У мастера «${st.name}» нет связи с YCLIENTS — обнови данные из YCLIENTS.` };
  const m = String(staffId).match(/^y(\d+)$/i);
  if (m) return { id: String(staffId).toLowerCase(), ycId: m[1], name: "" };
  return { error: `Нет мастера с id «${staffId}».` };
}

function ycProblem(e) {
  const msg = e instanceof YclientsError ? e.message : "внутренняя ошибка";
  return `YCLIENTS сейчас не отвечает (${msg}). Не называй клиенту время и позови мастера (handoff).`;
}

function yclientsBackend(state, shop, api, { log = console } = {}) {
  const cid = shop.yclients.companyId;

  async function staffFor(ycServiceId) {
    const data = await api.cached(`staff:${cid}:${ycServiceId}`, 5 * 60000, () => api.bookStaff(cid, { serviceIds: [ycServiceId] }));
    return listOf(data, "staff").filter((s) => s && s.id && s.bookable !== false);
  }

  // Дни, на которые вообще есть запись (чтобы не спрашивать время на выходные)
  async function bookableDates(ycServiceId, ycStaffId, from, to) {
    try {
      const d = await api.bookDates(cid, { serviceIds: [ycServiceId], staffId: ycStaffId || 0, dateFrom: from, dateTo: to });
      const set = new Set();
      for (const ts of d?.booking_dates || []) {
        if (typeof ts === "string" && isDate(ts.slice(0, 10))) set.add(ts.slice(0, 10));
        else if (Number(ts) > 0) set.add(nowParts(shop.timezone, Number(ts) * 1000).date);
      }
      return Array.isArray(d?.booking_dates) ? set : null;
    } catch (e) {
      log.warn("YCLIENTS book_dates:", e.message);
      return null; // не знаем — спросим время по каждому дню
    }
  }

  async function freeSlots({ serviceId, dateFrom, days, staffId, now = Date.now(), maxPerDay = 14 }) {
    const service = findService(shop, serviceId);
    if (!service) return { error: `Нет услуги с id «${serviceId}». Возьми id из списка услуг.` };
    if (!service.ycId) return { error: `Услуга «${service.name}» не связана с YCLIENTS — записать на неё бот не может, позови мастера.` };
    const who = resolveStaff(shop, staffId);
    if (who.error) return { error: who.error };
    const today = nowParts(shop.timezone, now).date;
    let from = isDate(dateFrom) ? dateFrom : today;
    if (diffDays(from, today) < 0) from = today;
    const n = clamp(Number(days) || 3, 1, 7);
    const dates = Array.from({ length: n }, (_, i) => addDays(from, i));

    let staffList;
    try {
      staffList = who.any ? (await staffFor(service.ycId)).map((s) => staffFromYc(shop, s)) : [who];
    } catch (e) {
      return { error: ycProblem(e) };
    }
    staffList = staffList.slice(0, 6);
    const open = await bookableDates(service.ycId, who.any ? 0 : who.ycId, dates[0], dates[n - 1]);

    let durationSec = 0;
    let failed = 0;
    const pairs = [];
    for (const date of dates) if (!open || open.has(date)) for (const st of staffList) pairs.push({ date, st });
    const answers = await mapLimit(pairs, 4, async ({ date, st }) => {
      try {
        const list = await api.bookTimes(cid, st.ycId, date, { serviceIds: [service.ycId] });
        return (Array.isArray(list) ? list : []).filter((t) => t && /^\d{1,2}:\d\d$/.test(t.time));
      } catch (e) {
        failed++;
        log.warn("YCLIENTS book_times:", e.message);
        return [];
      }
    });
    if (pairs.length && failed === pairs.length) return { error: ycProblem(new YclientsError("не удалось получить свободное время")) };

    const result = dates.map((date) => ({ date, label: fmtDateRelative(date, today), staff: [] }));
    pairs.forEach(({ date, st }, k) => {
      const times = answers[k];
      if (!times.length) return;
      durationSec = durationSec || Number(times[0].seance_length) || 0;
      const day = result.find((d) => d.date === date);
      const uniq = [...new Set(times.map((t) => t.time.padStart(5, "0")))];
      day.staff.push({ staff_id: st.id, name: st.name, times: uniq.slice(0, maxPerDay), more: Math.max(0, uniq.length - maxPerDay) });
    });
    for (const day of result) if (open && !open.has(day.date)) day.closed = true;
    const minutes = durationSec ? Math.round(durationSec / 60) : service.durationMin || service.slots * shop.slotMinutes;
    return {
      service: { id: service.id, name: service.name, price: service.price, duration: fmtDuration(minutes) },
      days: result,
    };
  }

  async function book({ serviceId, date, time, staffId, client, comment, now = Date.now() }) {
    const service = findService(shop, serviceId);
    if (!service) return { ok: false, error: `Нет услуги «${serviceId}».` };
    if (!service.ycId) return { ok: false, error: `Услуга «${service.name}» не связана с YCLIENTS — позови мастера.` };
    if (!isDate(date)) return { ok: false, error: "Дата должна быть в формате YYYY-MM-DD." };
    const start = parseTime(time);
    if (start == null) return { ok: false, error: "Время должно быть в формате HH:MM." };
    const phone = normalizePhone(client?.phone);
    if (!phone) return { ok: false, error: "Для записи в YCLIENTS нужен номер телефона клиента. Попроси его и повтори create_booking." };
    if (!client?.name) return { ok: false, error: "Нужно имя клиента." };
    const who = resolveStaff(shop, staffId);
    if (who.error) return { ok: false, error: who.error };
    const hh = String(Math.floor(start / 60)).padStart(2, "0");
    const mm = String(start % 60).padStart(2, "0");

    const localId = (() => {
      state.seq = state.seq || {};
      state.seq.booking = (state.seq.booking || 0) + 1;
      return "B" + state.seq.booking;
    })();

    let created;
    try {
      const data = await api.bookRecord(cid, {
        phone,
        fullname: client.name,
        email: "",
        comment: comment || "",
        api_id: `tg-${localId}`,
        appointments: [{ id: 1, services: [Number(service.ycId)], staff_id: who.any ? 0 : Number(who.ycId), datetime: `${date} ${hh}:${mm}:00` }],
      });
      created = Array.isArray(data) ? data[0] : data;
      if (!created?.record_id) throw new YclientsError("YCLIENTS не вернул номер записи");
    } catch (e) {
      state.seq.booking--; // номер не потратили
      const code = e.code;
      if (code === 433 || code === 437 || /занят|недоступ|not available/i.test(e.message)) {
        const alt = await freeSlots({ serviceId: service.id, dateFrom: date, days: 1, staffId: who.any ? null : who.id, now, maxPerDay: 8 });
        const times = alt.days?.[0]?.staff?.flatMap((s) => s.times.map((t) => `${t} (${s.name})`)) || [];
        return {
          ok: false,
          error: `Время ${time} ${date} уже занято.${times.length ? ` Свободно в этот день: ${times.join(", ")}.` : " В этот день свободного времени нет."}`,
        };
      }
      if (code === 432) return { ok: false, error: "В YCLIENTS включено подтверждение записи по SMS-коду, бот так записать не может. Позови мастера (handoff)." };
      if (code === 431) return { ok: false, error: "YCLIENTS не принял номер телефона. Уточни номер у клиента." };
      if (code === 434) return { ok: false, error: "YCLIENTS не разрешает онлайн-запись для этого клиента. Позови мастера (handoff)." };
      if (code === 436 || code === 438) return { ok: false, error: "На это время у этого мастера услуга недоступна. Предложи другое время через get_free_slots." };
      log.warn("YCLIENTS book_record:", e.message);
      return { ok: false, error: ycProblem(e) };
    }

    // Мастера и длительность уточняем по созданной записи (если клиент выбрал «любого»)
    let staffName = who.name || "";
    let durationMin = service.durationMin || service.slots * shop.slotMinutes;
    let staffIdOut = who.any ? null : who.id;
    try {
      const rec = await api.getBookRecord(cid, created.record_id, created.record_hash);
      if (rec?.staff?.name) {
        const st = staffFromYc(shop, rec.staff);
        staffName = st.name;
        staffIdOut = st.id;
      }
      const len = Number(rec?.seance_length || rec?.length) || 0;
      if (len > 0) durationMin = Math.round(len / 60);
    } catch (e) {
      log.warn("YCLIENTS запись создана, но детали не получены:", e.message);
    }
    if (!staffName) staffName = who.any ? "любой свободный" : findStaff(shop, who.id)?.name || "мастер";

    const booking = {
      id: localId,
      date,
      start,
      durationMin,
      slots: service.slots,
      serviceId: service.id,
      serviceName: service.name,
      price: service.price,
      staffId: staffIdOut,
      staffName,
      client: { ...(client || {}), phone: client.phone || phone },
      comment: comment || "",
      status: "active",
      source: "yclients",
      yc: { companyId: cid, recordId: String(created.record_id), recordHash: created.record_hash || "" },
      createdAt: now,
    };
    state.bookings.push(booking);
    return { ok: true, booking };
  }

  async function cancel(bookingId, { clientKey, by = "client", now = Date.now() } = {}) {
    const b = state.bookings.find((x) => x.id === String(bookingId).toUpperCase() && x.status === "active");
    if (!b) return { ok: false, error: `Активной записи ${bookingId} нет.` };
    if (clientKey && b.client?.key !== clientKey) return { ok: false, error: "Это не ваша запись." };
    if (b.yc?.recordId) {
      try {
        await api.deleteUserRecord(b.yc.recordId, b.yc.recordHash);
      } catch (e) {
        if (!(e instanceof YclientsError && e.status === 404)) {
          log.warn("YCLIENTS отмена:", e.message);
          return { ok: false, error: `Не получилось отменить запись в YCLIENTS (${e.message}). Позови мастера (handoff).` };
        }
      }
    }
    return schedule.cancelBooking(state, b.id, { by, now });
  }

  // Запись могли удалить в самом YCLIENTS — проверяем перед напоминанием
  async function stillActive(b) {
    if (!b.yc?.recordId || !b.yc.recordHash) return true;
    try {
      const rec = await api.getBookRecord(b.yc.companyId || cid, b.yc.recordId, b.yc.recordHash);
      return !(rec && (rec.deleted === true || rec.deleted === 1));
    } catch (e) {
      if (e instanceof YclientsError && e.status === 404) return false;
      return true; // не знаем — лучше напомнить
    }
  }

  return { kind: "yclients", freeSlots, book, cancel, stillActive };
}

// Точка привязана к YCLIENTS, но ключа партнёра нет: записывать некуда — честно зовём мастера
function unavailableBackend(state) {
  const error = "Запись сейчас недоступна: бот не подключён к YCLIENTS (нет ключа партнёра). Позови мастера (handoff).";
  return {
    kind: "unavailable",
    async freeSlots() {
      return { error };
    },
    async book() {
      return { ok: false, error };
    },
    async cancel() {
      return { ok: false, error };
    },
    async stillActive() {
      return true;
    },
  };
}

function bookingBackend({ state, shop, yclients, log }) {
  if (shop.yclients?.companyId) return yclients ? yclientsBackend(state, shop, yclients, { log }) : unavailableBackend(state);
  return localBackend(state, shop);
}

module.exports = { bookingBackend, localBackend, yclientsBackend, mapLimit };
