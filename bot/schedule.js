// Расписание: слоты, свободное время, записи.
// Услуга занимает N слотов подряд (обычно 1–4). Время начала — по сетке слотов от открытия.
const {
  nowParts,
  isDate,
  addDays,
  diffDays,
  weekdayOf,
  parseTime,
  fmtTime,
  fmtDate,
  fmtDateRelative,
  fmtDuration,
  minutesUntil,
} = require("./time");
const { findService, findStaff } = require("./shop");
const { seededRandom, clamp } = require("./util");

function dayHours(shop, date) {
  const h = shop.hours[weekdayOf(date)];
  if (!h) return null;
  return { open: parseTime(h[0]), close: parseTime(h[1]) };
}

// Правдоподобная занятость для демо: детерминированная для (дата, мастер),
// чтобы расписание не «прыгало» между запросами.
function demoBusy(shop, staffId, date) {
  if (!shop.demoBusy) return [];
  const h = dayHours(shop, date);
  if (!h) return [];
  const rnd = seededRandom(`${shop.name}|${staffId}|${date}`);
  const step = shop.slotMinutes;
  const out = [];
  for (let t = h.open; t + step <= h.close; ) {
    if (rnd() < 0.3) {
      const len = (1 + Math.floor(rnd() * 3)) * step;
      out.push({ start: t, end: Math.min(t + len, h.close), demo: true });
      t += len;
    } else {
      t += step;
    }
  }
  return out;
}

function bookingEnd(b) {
  return b.start + b.durationMin;
}

function busyIntervals(state, shop, staffId, date) {
  const real = state.bookings
    .filter((b) => b.status === "active" && b.staffId === staffId && b.date === date)
    .map((b) => ({ start: b.start, end: bookingEnd(b), bookingId: b.id }));
  return [...real, ...demoBusy(shop, staffId, date)];
}

// Все допустимые времена начала услуги длиной `slots` у мастера в этот день.
function freeStarts(state, shop, { date, staffId, slots, now = Date.now() }) {
  const h = dayHours(shop, date);
  if (!h) return [];
  const today = nowParts(shop.timezone, now);
  const dayDiff = diffDays(date, today.date);
  if (dayDiff < 0 || dayDiff >= shop.bookingDays) return [];
  const step = shop.slotMinutes;
  const need = slots * step;
  const busy = busyIntervals(state, shop, staffId, date);
  const out = [];
  for (let t = h.open; t + need <= h.close; t += step) {
    const fromNow = dayDiff * 1440 + t - today.minutes;
    if (fromNow < (shop.minLeadMinutes || 0)) continue;
    if (busy.some((b) => t < b.end && b.start < t + need)) continue;
    out.push(t);
  }
  return out;
}

// Ответ для инструмента get_free_slots
function findFreeSlots(state, shop, { serviceId, dateFrom, days, staffId, now = Date.now(), maxPerDay = 14 }) {
  const service = findService(shop, serviceId);
  if (!service) return { error: `Нет услуги с id «${serviceId}». Возьми id из списка услуг.` };
  let staffList = shop.staff;
  if (staffId) {
    const st = findStaff(shop, staffId);
    if (!st) return { error: `Нет мастера с id «${staffId}».` };
    staffList = [st];
  }
  const today = nowParts(shop.timezone, now).date;
  let from = isDate(dateFrom) ? dateFrom : today;
  if (diffDays(from, today) < 0) from = today;
  const n = clamp(Number(days) || 3, 1, 7);
  const result = [];
  for (let i = 0; i < n; i++) {
    const date = addDays(from, i);
    const h = dayHours(shop, date);
    const day = { date, label: fmtDateRelative(date, today), staff: [] };
    if (!h) {
      day.closed = true;
      result.push(day);
      continue;
    }
    for (const st of staffList) {
      const starts = freeStarts(state, shop, { date, staffId: st.id, slots: service.slots, now });
      if (starts.length) {
        day.staff.push({
          staff_id: st.id,
          name: st.name,
          times: starts.slice(0, maxPerDay).map(fmtTime),
          more: Math.max(0, starts.length - maxPerDay),
        });
      }
    }
    result.push(day);
  }
  return {
    service: { id: service.id, name: service.name, price: service.price, duration: fmtDuration(service.slots * shop.slotMinutes) },
    days: result,
    note:
      diffDays(addDays(from, n - 1), today) >= shop.bookingDays
        ? `Запись открыта только на ${shop.bookingDays} дн вперёд.`
        : undefined,
  };
}

function nextBookingId(state) {
  state.seq = state.seq || {};
  state.seq.booking = (state.seq.booking || 0) + 1;
  return "B" + state.seq.booking;
}

function createBooking(state, shop, { serviceId, date, time, staffId, client, comment, now = Date.now(), source = "bot" }) {
  const service = findService(shop, serviceId);
  if (!service) return { ok: false, error: `Нет услуги «${serviceId}».` };
  if (!isDate(date)) return { ok: false, error: "Дата должна быть в формате YYYY-MM-DD." };
  const start = parseTime(time);
  if (start == null) return { ok: false, error: "Время должно быть в формате HH:MM." };
  let candidates = shop.staff;
  if (staffId) {
    const st = findStaff(shop, staffId);
    if (!st) return { ok: false, error: `Нет мастера «${staffId}».` };
    candidates = [st];
  }
  const staff = candidates.find((st) =>
    freeStarts(state, shop, { date, staffId: st.id, slots: service.slots, now }).includes(start)
  );
  if (!staff) {
    const alt = findFreeSlots(state, shop, { serviceId: service.id, dateFrom: date, days: 1, staffId, now, maxPerDay: 8 });
    const times = alt.days?.[0]?.staff?.flatMap((s) => s.times.map((t) => `${t} (${s.name})`)) || [];
    return {
      ok: false,
      error: `Время ${time} ${date} недоступно для «${service.name}».${
        times.length ? ` Свободно в этот день: ${times.join(", ")}.` : " В этот день свободного времени нет."
      }`,
    };
  }
  const booking = {
    id: nextBookingId(state),
    date,
    start,
    durationMin: service.slots * shop.slotMinutes,
    slots: service.slots,
    serviceId: service.id,
    serviceName: service.name,
    price: service.price,
    staffId: staff.id,
    staffName: staff.name,
    client: client || {},
    comment: comment || "",
    status: "active",
    source,
    createdAt: now,
  };
  state.bookings.push(booking);
  return { ok: true, booking };
}

function cancelBooking(state, bookingId, { clientKey, by = "client", now = Date.now() } = {}) {
  const b = state.bookings.find((x) => x.id === String(bookingId).toUpperCase() && x.status === "active");
  if (!b) return { ok: false, error: `Активной записи ${bookingId} нет.` };
  if (clientKey && b.client?.key !== clientKey) return { ok: false, error: "Это не ваша запись." };
  b.status = "cancelled";
  b.cancelledAt = now;
  b.cancelledBy = by;
  return { ok: true, booking: b };
}

function minutesUntilStart(b, shop, now = Date.now()) {
  return minutesUntil(b.date, b.start, shop.timezone, now);
}

function isUpcoming(shop, b, now = Date.now()) {
  return minutesUntil(b.date, bookingEnd(b), shop.timezone, now) > 0;
}

function upcomingBookings(state, shop, { clientKey, days, now = Date.now() } = {}) {
  const today = nowParts(shop.timezone, now).date;
  return state.bookings
    .filter((b) => b.status === "active" && isUpcoming(shop, b, now))
    .filter((b) => !clientKey || b.client?.key === clientKey)
    .filter((b) => !days || diffDays(b.date, today) < days)
    .sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1));
}

function bookingLabel(b, today) {
  const when = today ? fmtDateRelative(b.date, today) : fmtDate(b.date);
  return `${when}, ${fmtTime(b.start)}–${fmtTime(bookingEnd(b))}`;
}

function bookingForTool(b, shop, now) {
  const today = nowParts(shop.timezone, now).date;
  return {
    booking_id: b.id,
    service: b.serviceName,
    price: b.price,
    when: bookingLabel(b, today),
    date: b.date,
    time: fmtTime(b.start),
    master: b.staffName,
    client_name: b.client?.name || "",
    phone: b.client?.phone || "",
  };
}

module.exports = {
  dayHours,
  demoBusy,
  busyIntervals,
  freeStarts,
  findFreeSlots,
  createBooking,
  cancelBooking,
  upcomingBookings,
  bookingLabel,
  bookingForTool,
  bookingEnd,
  isUpcoming,
  minutesUntilStart,
};
