// ---------- Shift schedule logic ----------
// Reference: Aug 3, 2026 is day 0 of an off-block (3 off, then 3 work, repeating every 6 days).
// The 6-day cycle is continuous, so it naturally extends backward too —
// Aug 1–2, 2026 fall on the tail of the previous work-block and are correctly 'work' days.
// This reference date always describes Бригада 1 — Бригада 2 is the exact
// mirror of the same 6-day cycle (see getStatus below), never a second
// hardcoded date, so the two stay perfectly in sync forever.
const REF_OFF_START = Date.UTC(2026, 7, 3); // Aug 3 2026

// ---------- Бригада / Тип зміни ----------
// Ці два налаштування ніколи не торкаються самих записів заробітку
// (shiftTrackerEarnings лишається прив'язаним лише до календарної дати) —
// вони лише міняють, як дні розфарбовуються "робочий/вихідний" і яку дату
// вважати "сьогодні". Тому перемикання туди-сюди нічого не губить: жоден
// запис не видаляється і не переноситься, просто інакше читається той
// самий календар.
const SHIFT_CONFIG_KEY = 'shiftTrackerShiftConfig';
function loadShiftConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(SHIFT_CONFIG_KEY) || '{}');
    return {
      brigade: raw.brigade === 2 ? 2 : 1,
      shiftType: raw.shiftType === 'night' ? 'night' : 'day',
    };
  } catch (e) {
    return { brigade: 1, shiftType: 'day' };
  }
}
let shiftConfig = loadShiftConfig();

function saveShiftConfig(next) {
  shiftConfig = {
    brigade: next.brigade === 2 ? 2 : 1,
    shiftType: next.shiftType === 'night' ? 'night' : 'day',
  };
  try { localStorage.setItem(SHIFT_CONFIG_KEY, JSON.stringify(shiftConfig)); } catch (e) { /* сховище недоступне */ }
  if (window.CloudSync && typeof window.CloudSync.updateShiftConfig === 'function') {
    window.CloudSync.updateShiftConfig(shiftConfig);
  }
  window.dispatchEvent(new CustomEvent('shiftconfig:change', { detail: shiftConfig }));
}

function utcDay(y, m, d) { return Date.UTC(y, m, d); }

function getStatus(y, m, d) {
  const t = utcDay(y, m, d);
  const diffDays = Math.round((t - REF_OFF_START) / 86400000);
  const mod = ((diffDays % 6) + 6) % 6;
  const brigade1 = mod < 3 ? 'off' : 'work';
  // Бригада 2 — дзеркальний графік відносно Бригади 1, той самий цикл.
  return shiftConfig.brigade === 2 ? (brigade1 === 'work' ? 'off' : 'work') : brigade1;
}

// "Сьогодні" для нічної зміни — це календарна дата, коли зміна
// РОЗПОЧАЛАСЬ (20:00), а не та, де вона закінчується о 08:00. Тобто до
// 08:00 ранку "сьогодні" все ще вчорашня дата. Обчислюється щоразу
// заново (а не один раз при завантаженні), інакше застосунок, залишений
// відкритим на фоні через зміну, "застрягне" на вчорашньому дні.
function getEffectiveNow() {
  const raw = new Date();
  if (shiftConfig.shiftType === 'night' && raw.getHours() < 8) {
    return new Date(raw.getTime() - 86400000);
  }
  return raw;
}

const monthNames = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
const monthNamesNom = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
const weekdayNames = ['неділя','понеділок','вівторок','середа','четвер','пʼятниця','субота'];

let viewYear = getEffectiveNow().getFullYear();
let viewMonth = getEffectiveNow().getMonth();

// ---------- Earnings logic ----------
const CORE_PRODUCTS = [
  { code: '3115', rate: 7.47 },
  { code: '4320', rate: 14.21 }
];

// R&D: не "виріб" процесу, а фіксований виняток — одноденне переміщення
// людини на інший процес для підмоги. Рахується по годинах (не шт) і
// буде присутній однаково для всіх процесів, які додамо пізніше.
const RND_PRODUCT = { code: 'R&D', rate: 210 };
function isHourlyCode(code) { return code === RND_PRODUCT.code; }
function unitFor(code) { return isHourlyCode(code) ? 'год' : 'шт'; }

const STORAGE_KEY = 'shiftTrackerEarnings';

let earningsData = {};   // { 'YYYY-MM-DD': [{code, qty, rate, amount}, ...] }
let dataReady = false;
let selectedProduct = CORE_PRODUCTS[0].code;
let activeDateKey = null; // date currently open in the modal

// ---------- Products: 2 built-in + any the person adds themselves ----------
// Extra products stay hidden behind a "показати всі" toggle so the modal
// doesn't get cluttered once someone has added a handful of them.
const PRODUCTS_KEY = 'shiftTrackerCustomProducts';
let customProducts = [];        // [{code, rate}]
let showAllProducts = false;    // toggle inside the entry modal (resets each open)
let statsShowAllProducts = false; // toggle inside the "По виробах" stats card

function loadCustomProducts() {
  try {
    const raw = localStorage.getItem(PRODUCTS_KEY);
    customProducts = raw ? JSON.parse(raw) : [];
  } catch (e) {
    customProducts = [];
  }
}
function saveCustomProducts() {
  try {
    localStorage.setItem(PRODUCTS_KEY, JSON.stringify(customProducts));
    syncToCloudIfPossible();
    return true;
  } catch (e) {
    return false;
  }
}
function deleteCustomProduct(code) {
  // Only removes it from the pick-list for new entries — earnings already
  // logged with this code keep their own stored code/rate regardless.
  customProducts = customProducts.filter(p => p.code !== code);
  saveCustomProducts();
  if (selectedProduct === code) selectedProduct = CORE_PRODUCTS[0].code;
}
function allProducts() { return [RND_PRODUCT].concat(CORE_PRODUCTS, customProducts); }
function findProduct(code) { return allProducts().find(p => p.code === code); }

// ---------- Unpaid leave days ("вихідний за свій рахунок") ----------
// A day that's a scheduled work day per the 3/3 rotation, but manually
// marked as taken off without pay (air raid alerts, personal reasons,
// etc). It shouldn't count toward earnings pacing or the trend chart.
const LEAVE_KEY = 'shiftTrackerLeaveDays';
let leaveDays = {}; // { 'YYYY-MM-DD': true }

function loadLeaveDays() {
  try {
    const raw = localStorage.getItem(LEAVE_KEY);
    leaveDays = raw ? JSON.parse(raw) : {};
  } catch (e) {
    leaveDays = {};
  }
}
function saveLeaveDays() {
  try {
    localStorage.setItem(LEAVE_KEY, JSON.stringify(leaveDays));
    syncToCloudIfPossible();
    return true;
  } catch (e) {
    return false;
  }
}
function isLeaveDay(key) { return !!leaveDays[key]; }

function pad(n) { return String(n).padStart(2, '0'); }
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function dateKey(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }
function fmtMoney(v) {
  return v.toLocaleString('uk-UA', { maximumFractionDigits: 2, minimumFractionDigits: v % 1 === 0 ? 0 : 2 }) + ' ₴';
}
function fmtMoneyShort(v) {
  // compact for tiny calendar cells
  if (v >= 1000) return Math.round(v / 100) / 10 + 'к';
  return Math.round(v) + '';
}
function dayTotal(key) {
  const entries = earningsData[key] || [];
  return entries.reduce((s, e) => s + (e.deleted ? 0 : e.amount), 0);
}

// ---------- Animated number helper ----------
// Smoothly counts a displayed value from its previous number to the new
// one instead of just snapping the text, so entering an amount *feels*
// like it lands rather than just appearing.
const animFrames = new WeakMap();
function animateNumber(el, toValue, formatFn) {
  if (!el) return;
  const fromValue = parseFloat(el.dataset.rawValue || '0');
  if (Math.abs(fromValue - toValue) < 0.005) {
    el.dataset.rawValue = toValue;
    el.textContent = formatFn(toValue);
    return;
  }
  if (animFrames.has(el)) cancelAnimationFrame(animFrames.get(el));
  const duration = 500;
  const start = performance.now();
  function step(ts) {
    const t = Math.min(1, (ts - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = fromValue + (toValue - fromValue) * eased;
    el.textContent = formatFn(current);
    if (t < 1) {
      animFrames.set(el, requestAnimationFrame(step));
    } else {
      el.dataset.rawValue = toValue;
      el.textContent = formatFn(toValue);
    }
  }
  animFrames.set(el, requestAnimationFrame(step));
}

// ---------- Persistence ----------
// Earnings are kept in the browser's localStorage, so they survive page
// reloads and browser restarts automatically, with no server needed.
// On top of that, "Експорт JSON" / "Імпорт JSON" let you save a real .json
// backup file to disk (or move your data to another device/browser).
function loadEarnings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    earningsData = raw ? JSON.parse(raw) : {};
  } catch (e) {
    earningsData = {};
  }
  dataReady = true;
  resumePendingPurges();
}

// Every local write funnels through one of the four save*() functions
// below, so hooking the cloud push in here (rather than at every call
// site that triggers a save) guarantees nothing slips through — add a
// product, log an entry, set a goal, mark a leave day, it all reaches
// the cloud the same way, automatically, whenever CloudSync is signed
// in and approved. If it isn't (not logged in, offline, still pending
// admin approval), this is a harmless no-op — the app works exactly as
// it did before cloud sync existed.
function syncToCloudIfPossible() {
  if (window.CloudSync && window.CloudSync.isReady()) {
    window.CloudSync.pushLocalData();
  }
}

function saveEarnings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(earningsData));
    syncToCloudIfPossible();
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- Soft delete ("phantom" entries) ----------
// Deleting an entry doesn't remove it right away — it's flagged `deleted`
// and kept faded-but-visible with a restore option for a grace period,
// so an accidental tap doesn't mean losing data for good. dayTotal() and
// every other aggregate above already skip flagged entries, so a phantom
// entry stops "counting" the instant it's marked, well before it's
// actually purged from storage.
const PURGE_DELAY_MS = 15000; // how long an entry stays recoverable (0.8.2: 10s → 15s)

function scheduleEntryPurge(key, entry, delay) {
  setTimeout(() => {
    if (!entry.deleted) return; // restored in the meantime — nothing to do
    const arr = earningsData[key];
    if (!arr) return;
    const i = arr.indexOf(entry);
    if (i !== -1) arr.splice(i, 1);
    if (arr.length === 0) delete earningsData[key];
    saveEarnings();
    if (activeDateKey === key) renderEntryList();
    renderCalendar();
    renderToday();
    renderStats();
    renderGoal();
    renderTodayEntries();
  }, delay != null ? delay : PURGE_DELAY_MS);
}

// Called once at startup: entries that were mid-countdown when the app
// was last closed either get their timer resumed (grace period still
// has time left) or get cleaned up immediately (it fully elapsed while
// the app was closed).
function resumePendingPurges() {
  const nowMs = Date.now();
  Object.keys(earningsData).forEach(key => {
    earningsData[key] = (earningsData[key] || []).filter(entry => {
      if (!entry.deleted) return true;
      const elapsed = nowMs - (entry.deletedAt || 0);
      if (elapsed >= PURGE_DELAY_MS) return false; // grace period already over
      scheduleEntryPurge(key, entry, PURGE_DELAY_MS - elapsed);
      return true;
    });
    if (earningsData[key].length === 0) delete earningsData[key];
  });
}

function exportData() {
  const blob = new Blob([JSON.stringify(earningsData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'earnings-' + dateKey(getEffectiveNow().getFullYear(), getEffectiveNow().getMonth(), getEffectiveNow().getDate()) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  const note = document.getElementById('dataNote');
  note.textContent = 'Файл завантажено';
}

function importDataFromFile(file) {
  const note = document.getElementById('dataNote');
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('bad shape');
      earningsData = parsed;
      saveEarnings();
      renderToday();
      renderCalendar();
      renderStats();
      renderGoal();
      renderTodayEntries();
      note.textContent = 'Дані імпортовано';
    } catch (err) {
      note.textContent = 'Помилка: файл не схожий на коректний бекап';
    }
  };
  reader.onerror = () => { note.textContent = 'Не вдалося прочитати файл'; };
  reader.readAsText(file);
}

function renderToday() {
  const y = getEffectiveNow().getFullYear(), m = getEffectiveNow().getMonth(), d = getEffectiveNow().getDate();
  document.getElementById('todayDate').textContent =
    d + ' ' + monthNames[m] + ', ' + weekdayNames[getEffectiveNow().getDay()];

  const status = getStatus(y, m, d);
  const card = document.getElementById('statusCard');
  card.className = 'status-card is-' + status;
  document.getElementById('statusValue').textContent = status === 'work' ? 'Робочий день' : 'Вихідний';
  document.getElementById('statusIcon').src = status === 'work' ? 'workDay.png' : 'offDay.png';
  document.getElementById('statusIcon').alt = status === 'work' ? 'Робочий день' : 'Вихідний день';

  let nd = new Date(Date.UTC(y, m, d));
  let cur = status;
  let steps = 0;
  while (steps < 10) {
    nd = new Date(nd.getTime() + 86400000);
    steps++;
    const s = getStatus(nd.getUTCFullYear(), nd.getUTCMonth(), nd.getUTCDate());
    if (s !== cur) break;
  }
  // Phrased around *what's coming*, not a "current → next" arrow — the
  // label already says what kind of day it is, so the value only needs
  // to answer "when".
  const daysWord = steps === 1 ? 'день' : (steps < 5 ? 'дні' : 'днів');
  const whenText = steps === 1 ? 'завтра' : 'за ' + steps + ' ' + daysWord;
  document.getElementById('statusNextLabel').textContent =
    cur === 'work' ? 'Наступний вихідний' : 'Наступна робоча зміна';
  document.getElementById('statusNextValue').textContent =
    nd.getUTCDate() + ' ' + monthNames[nd.getUTCMonth()] + ' · ' + whenText;

  const strip = document.getElementById('cycleStrip');
  strip.innerHTML = '';
  for (let off = -2; off <= 3; off++) {
    const dt = new Date(Date.UTC(y, m, d) + off * 86400000);
    const s = getStatus(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
    const cell = document.createElement('div');
    cell.className = 'cycle-tick ' + s + (off === 0 ? ' current' : '');
    cell.textContent = dt.getUTCDate();
    strip.appendChild(cell);
  }

  const tKey = dateKey(y, m, d);
  const tTotal = dayTotal(tKey);
  const row = document.getElementById('todayEarnRow');
  if (tTotal > 0) {
    row.style.display = 'flex';
    animateNumber(document.getElementById('todayEarnValue'), tTotal, fmtMoney);
  } else {
    row.style.display = 'none';
  }

  const addBtn = document.getElementById('addEarnToday');
  if (status === 'work') {
    addBtn.disabled = false;
    addBtn.textContent = '+ Записати заробіток за сьогодні';
  } else {
    addBtn.disabled = true;
    addBtn.textContent = 'Сьогодні вихідний — запис недоступний';
  }
}

// Always visible regardless of any goal being set or its progress — a
// plain, ungated log of today's records, newest first, so the newest
// entry always lands right at the top the moment it's saved.
function renderTodayEntries() {
  const section = document.getElementById('todayEntriesSection');
  const wrap = document.getElementById('todayEntriesList');
  const todayKey = dateKey(getEffectiveNow().getFullYear(), getEffectiveNow().getMonth(), getEffectiveNow().getDate());
  const entries = earningsData[todayKey] || [];

  if (entries.length === 0) {
    section.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  section.style.display = '';

  // Newest first, and carry the original index so a restore click can
  // find its way back to the exact entry object.
  const withIdx = entries.map((e, idx) => ({ e, idx })).reverse();

  wrap.innerHTML = withIdx.map(({ e, idx }) =>
    '<div class="today-entry-row' + (e.deleted ? ' phantom' : '') + '" data-idx="' + idx + '">' +
      '<span class="today-entry-code">' + e.code + '</span>' +
      '<span>' + e.qty + ' ' + unitFor(e.code) + '</span>' +
      (e.order ? '<span class="today-entry-order">№' + e.order + '</span>' : '') +
      (fmtTime(e.time) ? '<span class="today-entry-time">' + fmtTime(e.time) + '</span>' : '') +
      '<span class="today-entry-amount">' + fmtMoney(e.amount) + '</span>' +
      (e.deleted ? '<button class="today-entry-restore" data-idx="' + idx + '" title="Відновити">↺</button>' : '') +
    '</div>'
  ).join('');

  wrap.querySelectorAll('.today-entry-row').forEach(row => {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('.today-entry-restore')) return; // handled separately below
      openModal(getEffectiveNow().getFullYear(), getEffectiveNow().getMonth(), getEffectiveNow().getDate());
    });
  });

  wrap.querySelectorAll('.today-entry-restore').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const idx = parseInt(ev.currentTarget.getAttribute('data-idx'), 10);
      const entry = entries[idx];
      if (!entry) return;
      delete entry.deleted;
      delete entry.deletedAt;
      saveEarnings();
      if (activeDateKey === todayKey) renderEntryList();
      renderCalendar();
      renderToday();
      renderStats();
      renderGoal();
      renderTodayEntries();
    });
  });
}

function renderCalendar() {
  document.getElementById('calTitle').textContent = monthNamesNom[viewMonth] + ' ' + viewYear;
  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';

  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const leadingEmpty = (firstDay + 6) % 7;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  for (let i = 0; i < leadingEmpty; i++) {
    const e = document.createElement('div');
    e.className = 'day-cell empty';
    grid.appendChild(e);
  }

  let monthSum = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const s = getStatus(viewYear, viewMonth, day);
    const key = dateKey(viewYear, viewMonth, day);
    const total = dayTotal(key);
    const leave = s === 'work' && isLeaveDay(key);
    monthSum += total;

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'day-cell ' + s + (leave ? ' leave' : '');
    const isToday = viewYear === getEffectiveNow().getFullYear() && viewMonth === getEffectiveNow().getMonth() && day === getEffectiveNow().getDate();
    if (isToday) cell.classList.add('today');

    let inner = day;
    if (leave) {
      // Заглушка під іконку дня "за свій рахунок": постав leaveDay.png у
      // корінь репозиторію поруч з workDay.png/offDay.png/calendar.png.
      inner += '<img class="leave-mark" src="leaveDay.png" alt="">';
    } else if (total > 0) {
      inner += '<span class="earn-tag">' + fmtMoneyShort(total) + '₴</span>';
    } else {
      inner += '<span class="dot"></span>';
    }
    cell.innerHTML = inner;
    cell.addEventListener('click', () => openModal(viewYear, viewMonth, day));
    grid.appendChild(cell);
  }

  animateNumber(document.getElementById('monthTotal'), monthSum, fmtMoney);
}

// ---------- Statistics ----------
function allDatesSorted() {
  return Object.keys(earningsData).filter(k => dayTotal(k) > 0).sort();
}

function computeRecord() {
  let best = 0, bestKey = null;
  for (const key of Object.keys(earningsData)) {
    const t = dayTotal(key);
    if (t > best) { best = t; bestKey = key; }
  }
  return { amount: best, key: bestKey };
}

function computeAllTimeTotal() {
  let sum = 0;
  for (const key of Object.keys(earningsData)) sum += dayTotal(key);
  return sum;
}

function computeProductTotals() {
  const totals = {};
  for (const key of Object.keys(earningsData)) {
    (earningsData[key] || []).forEach(e => {
      if (e.deleted) return;
      if (!totals[e.code]) totals[e.code] = { qty: 0, amount: 0 };
      totals[e.code].qty += e.qty;
      totals[e.code].amount += e.amount;
    });
  }
  return totals;
}

function last14Days() {
  // Returns [{key, date, total}] for the 14-day window ending today.
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(getEffectiveNow().getFullYear(), getEffectiveNow().getMonth(), getEffectiveNow().getDate());
    dt.setDate(dt.getDate() - i);
    const key = dateKey(dt.getFullYear(), dt.getMonth(), dt.getDate());
    days.push({ key, date: dt, total: dayTotal(key) });
  }
  return days;
}

// Used for the chart specifically: off days always have 0 earned (nothing
// to earn), so mixing them in made the line dip in a way that had nothing
// to do with performance. This walks backward from today and only keeps
// actually-worked days — real off days AND unpaid-leave days are both
// skipped, so the chart reflects actual shifts worked, not schedule gaps.
function last14WorkDays() {
  const days = [];
  const cursor = new Date(getEffectiveNow().getFullYear(), getEffectiveNow().getMonth(), getEffectiveNow().getDate());
  let guard = 0;
  while (days.length < 14 && guard < 120) {
    const y = cursor.getFullYear(), m = cursor.getMonth(), d = cursor.getDate();
    const key = dateKey(y, m, d);
    if (getStatus(y, m, d) === 'work' && !isLeaveDay(key)) {
      days.unshift({ key, date: new Date(y, m, d), total: dayTotal(key) });
    }
    cursor.setDate(cursor.getDate() - 1);
    guard++;
  }
  return days;
}

function formatShortDate(dt) {
  return dt.getDate() + ' ' + monthNames[dt.getMonth()];
}

function renderTrendBadge(days) {
  const badge = document.getElementById('trendBadge');
  const todayTotal = days[days.length - 1].total;
  const priorDays = days.slice(0, -1).filter(d => d.total > 0);
  if (todayTotal <= 0 || priorDays.length === 0) {
    badge.style.display = 'none';
    return;
  }
  const avg = priorDays.reduce((s, d) => s + d.total, 0) / priorDays.length;
  const diff = todayTotal - avg;
  const pct = avg > 0 ? Math.round((diff / avg) * 100) : 0;
  badge.style.display = 'inline-flex';
  if (diff >= 0) {
    badge.className = 'trend-badge up';
    badge.textContent = '↑ на ' + Math.abs(pct) + '% більше за середнє';
  } else {
    badge.className = 'trend-badge down';
    badge.textContent = '↓ на ' + Math.abs(pct) + '% менше за середнє';
  }
}

function renderChart(days) {
  const workDays = days.filter(d => d.total > 0);
  const avg = workDays.length ? workDays.reduce((s, d) => s + d.total, 0) / workDays.length : 0;
  document.getElementById('chartAvgLabel').textContent = 'сер. ' + fmtMoney(Math.round(avg));

  const w = 320, h = 130, padL = 4, padR = 4, padT = 14, padB = 18;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const maxVal = Math.max(...days.map(d => d.total), avg, 1) * 1.15;

  const stepX = innerW / (days.length - 1);
  const xAt = (i) => padL + i * stepX;
  const yAt = (v) => padT + innerH - (v / maxVal) * innerH;

  const linePts = days.map((d, i) => xAt(i) + ',' + yAt(d.total).toFixed(1)).join(' ');
  const avgY = yAt(avg).toFixed(1);

  let dots = '';
  let labels = '';
  const todayKeyStr = dateKey(getEffectiveNow().getFullYear(), getEffectiveNow().getMonth(), getEffectiveNow().getDate());
  days.forEach((d, i) => {
    const x = xAt(i), y = yAt(d.total);
    const isToday = d.key === todayKeyStr;
    const above = d.total >= avg;
    const color = d.total === 0 ? 'var(--line)' : (above ? 'var(--off)' : 'var(--work)');
    const r = isToday ? 4.5 : 3;
    dots += '<circle class="chart-dot" cx="' + x + '" cy="' + y.toFixed(1) + '" r="' + r + '" fill="' + color + '"' +
      (isToday ? ' stroke="var(--today-ring)" stroke-width="2"' : '') + '></circle>';
    if (i % 2 === 0 || isToday) {
      labels += '<text x="' + x + '" y="' + (h - 4) + '" text-anchor="middle" class="chart-day-label">' + d.date.getDate() + '</text>';
    }
  });

  const svg =
    '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" xmlns="http://www.w3.org/2000/svg">' +
    '<line x1="' + padL + '" y1="' + avgY + '" x2="' + (w - padR) + '" y2="' + avgY + '" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4 4" opacity="0.5"></line>' +
    '<polyline id="earningsPolyline" class="chart-line-path" points="' + linePts + '" fill="none" stroke="var(--money)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>' +
    dots + labels +
    '</svg>';

  document.getElementById('earningsChart').innerHTML = svg;
  requestAnimationFrame(() => {
    const card = document.querySelector('.chart-card');
    if (card && isInViewport(card)) playChartAnimation();
  });
}

// Draws the earnings line in stroke-by-stroke and pops each dot in,
// either right away (if already on screen) or the moment it scrolls
// into view — set up once via IntersectionObserver below.
function isInViewport(el) {
  const r = el.getBoundingClientRect();
  return r.top < window.innerHeight * 0.92 && r.bottom > 0;
}

function playChartAnimation() {
  const poly = document.getElementById('earningsPolyline');
  if (poly && poly.getTotalLength) {
    const length = poly.getTotalLength();
    poly.style.transition = 'none';
    poly.style.strokeDasharray = length;
    poly.style.strokeDashoffset = length;
    poly.getBoundingClientRect(); // force reflow
    poly.style.transition = 'stroke-dashoffset 0.9s cubic-bezier(0.22, 0.9, 0.32, 1)';
    poly.style.strokeDashoffset = '0';
  }
  document.querySelectorAll('.chart-dot').forEach((dot, i) => {
    setTimeout(() => {
      dot.style.transition = 'opacity 0.35s ease, transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
      dot.style.opacity = '1';
      dot.style.transform = 'scale(1)';
    }, 500 + i * 35);
  });
}

let chartObserver;
function setupChartObserver() {
  if (chartObserver) return;
  const card = document.querySelector('.chart-card');
  if (!card) return;
  chartObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) playChartAnimation();
    });
  }, { threshold: 0.35 });
  chartObserver.observe(card);
}

function productStatRowHtml(t) {
  const pct = t.pct;
  return (
    '<div class="product-stat-row">' +
      '<div class="product-stat-top">' +
        '<span class="code">' + t.code + '</span>' +
        '<span class="qty">' + t.qty.toLocaleString('uk-UA') + ' ' + unitFor(t.code) + '</span>' +
        '<span class="amt">' + fmtMoney(t.amount) + '</span>' +
      '</div>' +
      '<div class="product-bar-track"><div class="product-bar-fill" style="width:' + pct + '%"></div></div>' +
    '</div>'
  );
}

function renderProductStats() {
  const totals = computeProductTotals();
  const wrap = document.getElementById('productStats');
  const grandTotal = Object.values(totals).reduce((s, t) => s + t.amount, 0);

  if (grandTotal === 0) {
    wrap.innerHTML = '<p class="stats-empty">Ще немає жодного запису</p>';
    return;
  }

  const withPct = (code) => {
    const t = totals[code] || { qty: 0, amount: 0 };
    const pct = grandTotal > 0 ? Math.round((t.amount / grandTotal) * 100) : 0;
    return { code, qty: t.qty, amount: t.amount, pct };
  };

  const core = CORE_PRODUCTS.map(p => withPct(p.code));
  const extraUsed = customProducts
    .map(p => withPct(p.code))
    .filter(p => p.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const visible = statsShowAllProducts ? core.concat(extraUsed) : core;
  const hiddenCount = statsShowAllProducts ? 0 : extraUsed.length;

  wrap.innerHTML = visible.map(productStatRowHtml).join('') +
    (hiddenCount > 0 ? '<button type="button" class="product-stats-toggle" id="productStatsToggle">Показати ще ' + hiddenCount + '</button>' : '');

  const toggleBtn = document.getElementById('productStatsToggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => { statsShowAllProducts = true; renderProductStats(); });
  }
}

function renderStats() {
  animateNumber(document.getElementById('statAllTime'), computeAllTimeTotal(), fmtMoney);

  const record = computeRecord();
  document.getElementById('statRecord').textContent = fmtMoney(record.amount);
  document.getElementById('statRecordDate').textContent = record.key
    ? formatShortDate(new Date(record.key + 'T00:00:00'))
    : '—';

  renderTrendBadge(last14Days());
  renderChart(last14WorkDays());
  renderProductStats();
}

// ---------- Monthly income goal ----------
const GOALS_KEY = 'shiftTrackerGoals';
let goalsData = {};
let goalEditing = false;

function loadGoals() {
  try {
    const raw = localStorage.getItem(GOALS_KEY);
    goalsData = raw ? JSON.parse(raw) : {};
  } catch (e) {
    goalsData = {};
  }
}
function saveGoals() {
  try {
    localStorage.setItem(GOALS_KEY, JSON.stringify(goalsData));
    syncToCloudIfPossible();
    return true;
  } catch (e) {
    return false;
  }
}
function currentMonthKey() { return getEffectiveNow().getFullYear() + '-' + pad(getEffectiveNow().getMonth() + 1); }

function countWorkDaysInMonth(y, m) {
  const days = new Date(y, m + 1, 0).getDate();
  let count = 0;
  for (let d = 1; d <= days; d++) if (getStatus(y, m, d) === 'work') count++;
  return count;
}
function monthEarnedSoFar(y, m) {
  const days = new Date(y, m + 1, 0).getDate();
  let sum = 0;
  for (let d = 1; d <= days; d++) sum += dayTotal(dateKey(y, m, d));
  return sum;
}

// The core "compensation" logic: whatever is left of the goal gets spread
// evenly across the work days still ahead (today included). Fall behind
// one day, and the split over the remaining days quietly grows to catch up.
function computeGoalPlan() {
  const mk = currentMonthKey();
  const goal = goalsData[mk];
  if (!(goal > 0)) return null;

  const y = getEffectiveNow().getFullYear(), m = getEffectiveNow().getMonth(), today = getEffectiveNow().getDate();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const totalWorkDays = countWorkDaysInMonth(y, m);
  const earned = monthEarnedSoFar(y, m); // whole month, including today — used for the overall progress bar
  const remaining = Math.max(0, goal - earned);
  const reached = earned >= goal;

  const todayKey = dateKey(y, m, today);
  const earnedToday = dayTotal(todayKey);

  // The daily target must stay flat across a single day, no matter how
  // much gets logged today — otherwise earning today's exact quota (or
  // more) would retroactively shrink today's own remaining-target math,
  // since today would still occupy a slot in the divisor below while its
  // own earnings had already shrunk the numerator. So this version of
  // "remaining" deliberately excludes today's own earnings; "залишок
  // сьогодні" is computed once, separately, by simply subtracting
  // earnedToday from this stable target — never fed back into it.
  const remainingExcludingToday = Math.max(0, goal - (earned - earnedToday));

  // Two counts: every remaining work day (used to know if the month is
  // simply over), and only the ones that are still genuinely "open" — no
  // earnings recorded for them yet. Today always counts as open even if
  // it already has something logged, since the shift isn't over yet.
  // Splitting the remaining amount only across open days is what makes
  // the compensation logic correct: a day that already has money on it
  // shouldn't also get a slice of what's still owed. Days marked as
  // unpaid leave are skipped entirely — they're not expected to earn
  // anything, so they shouldn't dilute the pace of the days that are.
  let trueWorkDaysLeft = 0;
  let openWorkDaysLeft = 0;
  for (let d = today; d <= daysInMonth; d++) {
    if (getStatus(y, m, d) !== 'work') continue;
    if (isLeaveDay(dateKey(y, m, d))) continue;
    trueWorkDaysLeft++;
    if (d === today || dayTotal(dateKey(y, m, d)) === 0) openWorkDaysLeft++;
  }
  const workDaysLeft = openWorkDaysLeft > 0 ? openWorkDaysLeft : trueWorkDaysLeft;

  const perDayTarget = workDaysLeft > 0 ? remainingExcludingToday / workDaysLeft : 0;
  const todayIsWork = getStatus(y, m, today) === 'work' && !isLeaveDay(todayKey);
  const progressPct = goal > 0 ? Math.min(100, (earned / goal) * 100) : 0;

  return { goal, earned, remaining, totalWorkDays, workDaysLeft, trueWorkDaysLeft, perDayTarget, todayIsWork, reached, progressPct, y, m, today, daysInMonth, earnedToday };
}

function partsForAmount(amount) {
  return CORE_PRODUCTS.map(p => ({ code: p.code, qty: Math.ceil(amount / p.rate) }));
}

function renderGoal() {
  const card = document.getElementById('goalCard');
  const plan = computeGoalPlan();

  if (!plan || goalEditing) {
    card.dataset.state = plan ? 'editing' : 'setup';
    document.getElementById('goalSetupIcon').style.display = plan ? 'none' : '';
    document.getElementById('goalSetupTitle').textContent = plan
      ? 'Змінити ціль на ' + monthNames[getEffectiveNow().getMonth()]
      : 'Встанови ціль на місяць';
    document.getElementById('goalSetupSub').style.display = plan ? 'none' : '';
    document.getElementById('goalInput').value = plan ? plan.goal : '';
    return;
  }

  document.getElementById('goalMonthName').textContent = monthNamesNom[getEffectiveNow().getMonth()];
  document.getElementById('goalFill').classList.toggle('reached', plan.reached);
  requestAnimationFrame(() => {
    document.getElementById('goalFill').style.width = plan.progressPct + '%';
    document.getElementById('goalShimmer').style.setProperty('--fill-pct', plan.progressPct + '%');
  });
  animateNumber(document.getElementById('goalEarned'), plan.earned, fmtMoney);
  document.getElementById('goalTargetLabel').textContent = fmtMoney(plan.goal);
  document.getElementById('goalPct').textContent = Math.round(plan.progressPct) + '%';

  if (plan.reached) {
    card.dataset.state = 'reached';
    document.getElementById('goalReachedMsg').textContent =
      '🎉 Ціль досягнута! Понад план: +' + fmtMoney(plan.earned - plan.goal);
  } else if (plan.trueWorkDaysLeft === 0) {
    card.dataset.state = 'no-shifts';
  } else {
    card.dataset.state = 'normal';

    const todayBox = document.getElementById('goalTodayBox');
    const valueEl = document.getElementById('goalTodayValue');
    const labelEl = document.getElementById('goalTodayLabel');
    const partsRow = document.getElementById('goalPartsRow');
    todayBox.classList.remove('next-shift', 'day-exceeded');
    valueEl.classList.remove('next-shift', 'day-exceeded');

    if (plan.todayIsWork) {
      // Live figure: subtract whatever's already been recorded today, so
      // this number actually moves down as entries come in — and flips
      // to a green "over target" state instead of just hitting zero.
      const remainingToday = plan.perDayTarget - plan.earnedToday;

      if (remainingToday <= 0) {
        todayBox.classList.add('day-exceeded');
        valueEl.classList.add('day-exceeded');
        labelEl.textContent = '✓ Сьогодні зароблено більше норми';
        valueEl.textContent = '+' + fmtMoney(Math.abs(remainingToday));
        partsRow.innerHTML = '';
      } else {
        labelEl.textContent = 'Лишилось заробити сьогодні';
        valueEl.textContent = fmtMoney(Math.round(remainingToday));
        const parts = partsForAmount(remainingToday);
        partsRow.innerHTML = parts.map(p =>
          '<div class="goal-part-chip"><b>' + p.qty + '</b><span>шт (' + p.code + ')</span></div>'
        ).join('<span class="goal-part-or">або</span>');
      }
    } else {
      todayBox.classList.add('next-shift');
      valueEl.classList.add('next-shift');
      labelEl.textContent = 'Потрібно у наступну зміну';
      valueEl.textContent = fmtMoney(Math.round(plan.perDayTarget));
      const parts = partsForAmount(plan.perDayTarget);
      partsRow.innerHTML = parts.map(p =>
        '<div class="goal-part-chip"><b>' + p.qty + '</b><span>шт (' + p.code + ')</span></div>'
      ).join('<span class="goal-part-or">або</span>');
    }

    renderGoalUpcoming(plan);
  }
}

// The list of upcoming days genuinely varies in content each time (which
// days, whether they already have earnings), so it stays dynamically
// built — unlike the rest of the card, which no longer rebuilds itself.
function renderGoalUpcoming(plan) {
  const chipsWrap = document.getElementById('goalUpcoming');
  let chipsHtml = '';
  let shown = 0;
  for (let d = plan.today; d <= plan.daysInMonth && shown < 6; d++) {
    const key = dateKey(plan.y, plan.m, d);
    const scheduledWork = getStatus(plan.y, plan.m, d) === 'work';
    const isLeave = scheduledWork && isLeaveDay(key);
    const isWork = scheduledWork && !isLeave;
    const isToday = d === plan.today;
    const dayEarned = dayTotal(key);
    let valueHtml;
    let isDone = !isToday && dayEarned > 0;

    if (isLeave) {
      valueHtml = 'своя';
    } else if (!isWork) {
      valueHtml = 'вих.';
    } else if (isToday) {
      const remainingToday = plan.perDayTarget - dayEarned;
      if (remainingToday <= 0) {
        valueHtml = '✓ ' + fmtMoneyShort(Math.round(dayEarned)) + '₴';
        isDone = true;
      } else {
        valueHtml = fmtMoneyShort(Math.round(remainingToday)) + '₴';
      }
    } else if (isDone) {
      valueHtml = '✓ ' + fmtMoneyShort(Math.round(dayEarned)) + '₴';
    } else {
      valueHtml = fmtMoneyShort(Math.round(plan.perDayTarget)) + '₴';
    }

    chipsHtml +=
      '<div class="goal-chip' + (isToday ? ' chip-today' : '') + (isWork ? '' : ' chip-off') + (isLeave ? ' chip-leave' : '') + (isDone ? ' chip-done' : '') + '" style="animation-delay:' + (shown * 0.06).toFixed(2) + 's">' +
        '<p class="chip-day">' + (isToday ? 'сьогодні' : d + ' ' + monthNames[plan.m].slice(0, 3)) + '</p>' +
        '<p class="chip-val">' + valueHtml + '</p>' +
      '</div>';
    shown++;
  }
  chipsWrap.innerHTML = chipsHtml;
}

// Wired once at startup since the goal-card elements are now permanent
// DOM nodes that renderGoal() never tears down.
function initGoalCardListeners() {
  document.getElementById('goalSetBtn').addEventListener('click', () => {
    const val = parseFloat(document.getElementById('goalInput').value);
    if (!(val > 0)) return;
    goalsData[currentMonthKey()] = val;
    saveGoals();
    goalEditing = false;
    renderGoal();
  });
  document.getElementById('goalInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('goalSetBtn').click();
  });
  document.getElementById('goalEditBtn').addEventListener('click', () => { goalEditing = true; renderGoal(); });
  document.getElementById('goalRemoveBtn').addEventListener('click', () => {
    delete goalsData[currentMonthKey()];
    saveGoals();
    goalEditing = false;
    renderGoal();
  });
}

// ---------- Modal ----------
function statusLabel(s) { return s === 'work' ? 'Робочий день' : 'Вихідний'; }

function productTile(p) {
  // Only ever used for custom products now — the two core tiles are
  // static nodes in index.html, set up once by initCoreProductTiles().
  const btn = document.createElement('div');
  btn.className = 'product-btn' + (p.code === selectedProduct ? ' active' : '');
  btn.dataset.code = p.code;
  btn.innerHTML =
    '<span class="code">' + p.code + '</span>' +
    '<span class="rate">' + p.rate.toFixed(2) + ' ₴/шт</span>' +
    '<span class="product-del" title="Видалити виріб">✕</span>';
  btn.addEventListener('click', () => { selectedProduct = p.code; updateProductSelection(); updatePreview(); });
  btn.querySelector('.product-del').addEventListener('click', (e) => {
    e.stopPropagation(); // don't let the click also select the tile
    if (confirm('Видалити виріб ' + p.code + ' зі списку?')) {
      deleteCustomProduct(p.code);
      renderProductChoice();
      updatePreview();
    }
  });
  return btn;
}

// Sets the two fixed built-in tiles' text once at startup and wires their
// click handlers — they never get torn down or rebuilt after this.
function initCoreProductTiles() {
  const rndTile = document.getElementById('rndTile');
  if (rndTile) {
    document.getElementById('rndTileRate').textContent = RND_PRODUCT.rate.toFixed(2) + ' ₴/год';
    rndTile.dataset.code = RND_PRODUCT.code;
    rndTile.addEventListener('click', () => { selectedProduct = RND_PRODUCT.code; updateProductSelection(); updatePreview(); });
  }

  const tileIds = ['coreTile0', 'coreTile1'];
  CORE_PRODUCTS.forEach((p, i) => {
    const tile = document.getElementById(tileIds[i]);
    if (!tile) return;
    tile.dataset.code = p.code;
    document.getElementById(tileIds[i] + 'Code').textContent = p.code;
    document.getElementById(tileIds[i] + 'Rate').textContent = p.rate.toFixed(2) + ' ₴/шт';
    tile.addEventListener('click', () => { selectedProduct = p.code; updateProductSelection(); updatePreview(); });
  });

  document.getElementById('productToggleTile').addEventListener('click', () => {
    showAllProducts = true;
    renderProductChoice();
  });
  document.getElementById('productAddTile').addEventListener('click', openAddProductForm);
  document.getElementById('newProdCancel').addEventListener('click', closeAddProductForm);
  document.getElementById('newProdSave').addEventListener('click', () => {
    const code = document.getElementById('newProdCode').value.trim();
    const rate = parseFloat(document.getElementById('newProdRate').value);
    const err = document.getElementById('productAddError');
    if (!code || !(rate > 0)) {
      err.textContent = 'Вкажи код і ставку більше нуля';
      return;
    }
    if (findProduct(code)) {
      err.textContent = 'Такий код вже є';
      return;
    }
    customProducts.push({ code, rate });
    saveCustomProducts();
    selectedProduct = code;
    showAllProducts = true;
    closeAddProductForm();
    renderProductChoice();
    updatePreview();
  });
}

// Updates just the "active" highlight on whichever tile matches the
// current selection — no rebuild, just a class toggle.
function updateProductSelection() {
  document.querySelectorAll('#productChoice .product-btn[data-code]').forEach(tile => {
    tile.classList.toggle('active', tile.dataset.code === selectedProduct);
  });
}

function renderProductChoice() {
  // The core tiles, toggle tile, and add tile are permanent DOM nodes —
  // only the custom-products list actually needs rebuilding, since it's
  // the one part with a genuinely variable length.
  const customWrap = document.getElementById('customProductTiles');
  customWrap.innerHTML = '';
  if (showAllProducts) {
    customProducts.forEach(p => customWrap.appendChild(productTile(p)));
  }

  const toggleTile = document.getElementById('productToggleTile');
  if (!showAllProducts && customProducts.length > 0) {
    toggleTile.style.display = '';
    document.getElementById('toggleCountLabel').textContent = '+' + customProducts.length;
  } else {
    toggleTile.style.display = 'none';
  }

  updateProductSelection();
}

function openAddProductForm() {
  document.getElementById('productChoice').style.display = 'none';
  document.getElementById('productAddForm').style.display = 'flex';
  document.getElementById('newProdCode').value = '';
  document.getElementById('newProdRate').value = '';
  document.getElementById('productAddError').textContent = '';
}

function closeAddProductForm() {
  document.getElementById('productAddForm').style.display = 'none';
  document.getElementById('productChoice').style.display = '';
  renderProductChoice();
}

function updatePreview() {
  const qty = parseFloat(document.getElementById('qtyInput').value);
  const product = findProduct(selectedProduct);
  const preview = document.getElementById('previewLine');
  const submitBtn = document.getElementById('submitEntry');
  const qtyLabel = document.getElementById('qtyLabel');
  const qtyInput = document.getElementById('qtyInput');
  const hourly = !!product && isHourlyCode(product.code);
  if (qtyLabel) qtyLabel.textContent = hourly ? 'Кількість годин' : 'Кількість, шт';
  if (qtyInput) qtyInput.placeholder = hourly ? 'напр. 8' : 'напр. 173';
  if (qty > 0 && product) {
    const amount = qty * product.rate;
    preview.innerHTML = qty + ' ' + unitFor(product.code) + ' × ' + product.rate.toFixed(2) + ' ₴ = <b>' + fmtMoney(amount) + '</b>';
    submitBtn.disabled = false;
  } else {
    preview.textContent = '';
    submitBtn.disabled = true;
  }
}

// Tallies quantity per product code for the currently open day, so
// there's no need to manually add up 5+ entries at the end of a shift.
function renderDayProductSummary() {
  const wrap = document.getElementById('dayProductSummary');
  const entries = (earningsData[activeDateKey] || []).filter(e => !e.deleted);

  if (entries.length === 0) {
    wrap.innerHTML = '';
    return;
  }

  // Detail: group by (code, order) — same code but different order stays
  // separate, same code+order from multiple entries gets summed together.
  const groups = {};
  const groupOrder = [];
  entries.forEach(e => {
    const gKey = e.code + '|' + (e.order || '');
    if (!(gKey in groups)) {
      groups[gKey] = { code: e.code, order: e.order || null, qty: 0 };
      groupOrder.push(gKey);
    }
    groups[gKey].qty += e.qty;
  });

  // Total: per product code across all orders, for a quick day-end tally.
  const codeTotals = {};
  const codeOrder = [];
  entries.forEach(e => {
    if (!(e.code in codeTotals)) { codeTotals[e.code] = 0; codeOrder.push(e.code); }
    codeTotals[e.code] += e.qty;
  });

  const groupsHtml = groupOrder.map(gKey => {
    const g = groups[gKey];
    return (
      '<div class="day-summary-row">' +
        '<span class="day-summary-qty"><b>' + g.qty + '</b> ' + unitFor(g.code) + '</span>' +
        '<span class="day-summary-code">' + g.code + '</span>' +
        (g.order
          ? '<span class="day-summary-order">Зам. №' + g.order + '</span>'
          : '<span class="day-summary-order muted">без замовлення</span>') +
      '</div>'
    );
  }).join('');

  const totalsHtml = codeOrder.map(code =>
    '<span class="day-summary-chip"><b>' + codeTotals[code] + '</b> ' + unitFor(code) + ' · ' + code + '</span>'
  ).join('');

  wrap.innerHTML =
    '<div class="day-summary-groups">' + groupsHtml + '</div>' +
    '<p class="day-summary-total-label">Всього за день</p>' +
    '<div class="day-summary-totals">' + totalsHtml + '</div>';
}

function renderEntryList() {
  const list = document.getElementById('entryList');
  const entries = earningsData[activeDateKey] || [];
  list.innerHTML = '';
  renderDayProductSummary();
  if (entries.length === 0) {
    list.innerHTML = '<p class="empty-note">Ще немає записів за цей день</p>';
  } else {
    entries.forEach((e, idx) => {
      const row = document.createElement('div');
      row.className = 'entry-row' + (e.deleted ? ' phantom' : '');
      const remainingMs = e.deleted ? Math.max(0, PURGE_DELAY_MS - (Date.now() - (e.deletedAt || 0))) : 0;
      row.innerHTML =
        '<div class="entry-info"><b>' + e.code + '</b><span> · ' + e.qty + ' ' + unitFor(e.code) + '</span><span class="entry-rate">' + (e.order ? 'Зам. №' + e.order + ' · ' : '') + e.rate.toFixed(2) + ' ₴/' + unitFor(e.code) + '</span></div>' +
        '<div class="entry-row-right">' +
          (fmtTime(e.time) ? '<span class="entry-time">' + fmtTime(e.time) + '</span>' : '') +
          '<div class="entry-row-bottom"><span class="entry-amount">' + fmtMoney(e.amount) + '</span>' +
          (e.deleted
            ? '<button class="entry-restore" data-idx="' + idx + '" title="Скасувати видалення">↺</button>'
            : '<button class="entry-del" data-idx="' + idx + '">✕</button>') +
          '</div>' +
        '</div>' +
        (e.deleted ? '<div class="phantom-timer-track"><div class="delete-line-left" data-remaining="' + remainingMs + '"></div><div class="delete-line-right" data-remaining="' + remainingMs + '"></div></div>' : '');
      list.appendChild(row);
    });

    list.querySelectorAll('.entry-del').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        const idx = parseInt(ev.currentTarget.getAttribute('data-idx'), 10);
        const entry = entries[idx];
        if (!entry) return;
        entry.deleted = true;
        entry.deletedAt = Date.now();
        const ok = saveEarnings();
        document.getElementById('saveNote').textContent = ok ? '' : 'Не вдалося зберегти, спробуйте ще раз';
        scheduleEntryPurge(activeDateKey, entry);
        renderEntryList();
        document.getElementById('dayTotal').textContent = fmtMoney(dayTotal(activeDateKey));
        renderCalendar();
        renderToday();
        renderStats();
        renderGoal();
        renderTodayEntries();
      });
    });

    list.querySelectorAll('.entry-restore').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        const idx = parseInt(ev.currentTarget.getAttribute('data-idx'), 10);
        const entry = entries[idx];
        if (!entry) return;
        delete entry.deleted;
        delete entry.deletedAt;
        saveEarnings();
        renderEntryList();
        document.getElementById('dayTotal').textContent = fmtMoney(dayTotal(activeDateKey));
        renderCalendar();
        renderToday();
        renderStats();
        renderGoal();
        renderTodayEntries();
      });
    });

    // Дві лінії ростуть від країв до центру за час, що лишився до
    // остаточного видалення — зустрічаються посередині рівно в момент
    // покупки. Той самий подвійний rAF-трюк, що й раніше: перший кадр
    // фіксує стартовий стан (0%), другий — стартує саму transition.
    list.querySelectorAll('.delete-line-left, .delete-line-right').forEach(line => {
      const remaining = parseInt(line.getAttribute('data-remaining'), 10) || 0;
      line.style.transitionDuration = remaining + 'ms';
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { line.style.width = '50%'; });
      });
    });
  }
  document.getElementById('dayTotal').textContent = fmtMoney(dayTotal(activeDateKey));
}

function openModal(y, m, d) {
  activeDateKey = dateKey(y, m, d);
  const status = getStatus(y, m, d);
  const dt = new Date(y, m, d);
  document.getElementById('modalTitle').textContent = d + ' ' + monthNames[m] + ' ' + y;
  document.getElementById('modalStatus').textContent = statusLabel(status) + ' · ' + weekdayNames[dt.getDay()];
  document.getElementById('qtyInput').value = '';
  document.getElementById('orderInput').value = '';
  document.getElementById('saveNote').textContent = '';
  document.getElementById('modalBox').classList.toggle('day-off', status !== 'work');
  document.getElementById('modalBox').classList.toggle('day-leave', status === 'work' && isLeaveDay(activeDateKey));
  updateLeaveToggleButton(status);
  document.getElementById('productAddForm').style.display = 'none';
  document.getElementById('productChoice').style.display = '';
  showAllProducts = false;
  renderProductChoice();
  updatePreview();
  renderEntryList();
  document.getElementById('overlay').classList.add('open');
  document.body.classList.add('day-modal-open');
}

// Shows/labels the "вихідний за свій рахунок" toggle — only relevant on
// scheduled work days; a real off-day already has nothing to toggle.
function updateLeaveToggleButton(status) {
  const btn = document.getElementById('leaveToggleBtn');
  if (status !== 'work') {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  const leave = isLeaveDay(activeDateKey);
  // Заглушка під іконку: <img class="leave-btn-icon" src="leaveDay.png" alt="">
  btn.innerHTML = leave
    ? '✕ Скасувати «вихідний за свій рахунок»'
    : '<img class="leave-btn-icon" src="leaveDay.png" alt=""> Позначити вихідним за свій рахунок';
  btn.classList.toggle('active', leave);
}

document.getElementById('leaveToggleBtn').addEventListener('click', () => {
  const key = activeDateKey;
  const turningOn = !isLeaveDay(key);
  if (turningOn) {
    const hasEntries = (earningsData[key] || []).length > 0;
    if (hasEntries && !confirm('У цей день вже є записи заробітку. Все одно позначити його вихідним за свій рахунок?')) return;
    leaveDays[key] = true;
  } else {
    delete leaveDays[key];
  }
  saveLeaveDays();

  const [ey, em, ed] = key.split('-').map(Number);
  const status = getStatus(ey, em - 1, ed);
  document.getElementById('modalBox').classList.toggle('day-leave', status === 'work' && isLeaveDay(key));
  updateLeaveToggleButton(status);

  renderCalendar();
  renderToday();
  renderStats();
  renderGoal();
  renderTodayEntries();
});

function closeModal() {
  document.getElementById('overlay').classList.remove('open');
  document.body.classList.remove('day-modal-open');
}

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('overlay').addEventListener('click', (e) => {
  if (e.target.id === 'overlay') closeModal();
});
document.getElementById('qtyInput').addEventListener('input', updatePreview);

document.getElementById('submitEntry').addEventListener('click', () => {
  const qty = parseFloat(document.getElementById('qtyInput').value);
  const product = findProduct(selectedProduct);
  const order = document.getElementById('orderInput').value.trim();
  const [ey, em, ed] = activeDateKey.split('-').map(Number);
  if (!(qty > 0) || !product || getStatus(ey, em - 1, ed) !== 'work') return;

  const amount = Math.round(qty * product.rate * 100) / 100;
  if (!earningsData[activeDateKey]) earningsData[activeDateKey] = [];
  earningsData[activeDateKey].push({ code: product.code, qty: qty, rate: product.rate, amount: amount, order: order || null, time: new Date().toISOString() });

  const ok = saveEarnings();
  document.getElementById('saveNote').textContent = ok ? 'Збережено' : 'Не вдалося зберегти, спробуйте ще раз';

  document.getElementById('qtyInput').value = '';
  document.getElementById('orderInput').value = '';
  updatePreview();
  renderEntryList();
  renderCalendar();
  renderToday();
  renderStats();
  renderGoal();
  renderTodayEntries();
});

document.getElementById('addEarnToday').addEventListener('click', () => {
  openModal(getEffectiveNow().getFullYear(), getEffectiveNow().getMonth(), getEffectiveNow().getDate());
});

document.getElementById('prevMonth').addEventListener('click', () => {
  viewMonth--;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  renderCalendar();
});
document.getElementById('nextMonth').addEventListener('click', () => {
  viewMonth++;
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  renderCalendar();
});

document.getElementById('exportBtn').addEventListener('click', exportData);
document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) importDataFromFile(file);
  e.target.value = '';
});

// ---------- Init ----------
// Staged on purpose: the status card is what the person looks at first,
// so it's rendered synchronously. Everything else (calendar grid, chart,
// stats) is pushed one frame later via requestAnimationFrame, so the
// browser gets to paint in between instead of doing all the DOM work in
// a single blocking chunk. Barely matters today, but keeps things smooth
// as more months of history / products pile up.
(function init() {
  loadEarnings();
  loadGoals();
  loadCustomProducts();
  loadLeaveDays();

  initGoalCardListeners();
  initCoreProductTiles();
  initCloudSyncUI();
  initAppNav();
  initDevNoticeAccordion();
  initAuthReminder();
  initShiftSettings();

  renderToday();
  renderGoal();
  renderTodayEntries();

  requestAnimationFrame(() => {
    renderCalendar();
    requestAnimationFrame(() => {
      renderStats();
      setupChartObserver();
    });
  });
})();

// ---------- Bridge for firebase-sync.js ----------
// A module script can't see this file's top-level let/const bindings by
// name, so this is the one deliberate, explicit door between the two:
// firebase-sync.js only ever touches local data through these two
// functions, never by reaching into script.js's internals directly.
window.AppBridge = {
  getLocalBundle() {
    return { earnings: earningsData, goals: goalsData, customProducts, leaveDays };
  },
  applyCloudBundle(bundle) {
    earningsData = (bundle && bundle.earnings) || {};
    goalsData = (bundle && bundle.goals) || {};
    customProducts = (bundle && bundle.customProducts) || [];
    leaveDays = (bundle && bundle.leaveDays) || {};
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(earningsData)); } catch (e) { /* ignore */ }
    try { localStorage.setItem(GOALS_KEY, JSON.stringify(goalsData)); } catch (e) { /* ignore */ }
    try { localStorage.setItem(PRODUCTS_KEY, JSON.stringify(customProducts)); } catch (e) { /* ignore */ }
    try { localStorage.setItem(LEAVE_KEY, JSON.stringify(leaveDays)); } catch (e) { /* ignore */ }
    resumePendingPurges();
    renderToday();
    renderGoal();
    renderTodayEntries();
    renderCalendar();
    renderStats();
  },
  // Викликається firebase-sync.js лише коли на ЦЬОМУ пристрої ще немає
  // власного shiftTrackerShiftConfig (перший вхід) — щоб не затерти
  // налаштування, які людина вже свідомо обрала тут.
  hasLocalShiftConfig() {
    try { return localStorage.getItem(SHIFT_CONFIG_KEY) !== null; } catch (e) { return false; }
  },
  applyCloudShiftConfig(cfg) {
    if (!cfg) return;
    saveShiftConfig({ brigade: cfg.brigade, shiftType: cfg.shiftType });
  },
};

// ---------- Cloud sync / profile UI ----------
// firebase-sync.js dispatches a 'cloudsync:status' window event whenever
// sign-in state, admin approval, live DB connection, or the last sync
// time changes. This just reflects that into the profile window — it
// never talks to Firebase directly.
function initCloudSyncUI() {
  const loginBox = document.getElementById('profileLogin');
  const pendingBox = document.getElementById('profilePending');
  const fullBox = document.getElementById('profileFull');
  if (!loginBox || !pendingBox || !fullBox) return;

  const pendingDotWrap = document.getElementById('pendingDotWrap');
  const fullDotWrap = document.getElementById('fullDotWrap');
  const pendingEmail = document.getElementById('pendingEmail');
  const cloudSyncLabel = document.getElementById('cloudSyncLabel');
  const cloudSyncTime = document.getElementById('cloudSyncTime');
  const nameInput = document.getElementById('profileUserNameInput');
  const userEmail = document.getElementById('profileUserEmail');
  const avatarImg = document.getElementById('profileAvatarImg');
  const avatarInitials = document.getElementById('profileAvatarInitials');

  const signInBtn = document.getElementById('cloudSignInBtn');
  const signOutBtnPending = document.getElementById('cloudSignOutBtnPending');
  const signOutBtn = document.getElementById('cloudSignOutBtn');
  const forceSyncBtn = document.getElementById('cloudForceSyncBtn');

  function setDotState(wrapEl, state) {
    wrapEl.className = 'status-dot-wrap';
    if (state === 'connected') wrapEl.classList.add('is-green');
    else if (state === 'offline' || state === 'blocked') wrapEl.classList.add('is-red');
    else wrapEl.classList.add('is-orange'); // connecting
  }

  function formatSyncTime(ts) {
    if (!ts) return 'Ще не синхронізовано';
    const d = new Date(ts);
    const sameDay = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    return 'Синхронізовано: ' + (sameDay ? ('сьогодні о ' + time) : (d.toLocaleDateString('uk-UA') + ' о ' + time));
  }

  function initialsFrom(name, email) {
    const source = (name || '').trim() || (email || '').trim();
    if (!source) return '?';
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
  }

  // Google віддає URL з опційним "=sNN-c" на кінці (розмір+crop) — знімаємо
  // будь-який наявний розмір і просимо свій, під розмір кружечка (з запасом
  // під ретіну), щоб не тягнути повнорозмірне фото в 40px круг.
  function sizedPhotoUrl(url) {
    return url ? url.replace(/=s\d+-c$/, '') + '=s96-c' : url;
  }

  // Фото — пряме посилання на сервери Google (photoURL з Auth), ніколи
  // не проходить через нашу базу й нічого в ній не займає. Якщо фото
  // немає (або не завантажилось) — показуємо ініціали замість нього.
  function renderAvatar(photoUrl, name, email) {
    avatarInitials.textContent = initialsFrom(name, email);
    if (!photoUrl) {
      avatarImg.style.display = 'none';
      avatarInitials.style.display = '';
      return;
    }
    const sized = sizedPhotoUrl(photoUrl);
    avatarImg.onload = () => {
      avatarImg.style.display = '';
      avatarInitials.style.display = 'none';
    };
    avatarImg.onerror = () => {
      avatarImg.style.display = 'none';
      avatarInitials.style.display = '';
    };
    if (avatarImg.src !== sized) avatarImg.src = sized;
  }

  function render(status) {
    loginBox.style.display = 'none';
    pendingBox.style.display = 'none';
    fullBox.style.display = 'none';

    if (status.state === 'signed-out') {
      loginBox.style.display = '';
    } else if (status.state === 'blocked') {
      pendingBox.style.display = '';
      setDotState(pendingDotWrap, 'blocked');
      pendingEmail.textContent = status.email || '';
    } else {
      fullBox.style.display = '';
      setDotState(fullDotWrap, status.state); // connecting / connected / offline
      if (status.state === 'connected') cloudSyncLabel.textContent = 'Синхронізовано';
      else if (status.state === 'offline') cloudSyncLabel.textContent = 'Не вдалось синхронізувати — спробуємо ще раз пізніше';
      else cloudSyncLabel.textContent = 'Синхронізація…';
      cloudSyncTime.textContent = formatSyncTime(status.lastSyncedAt);
      renderAvatar(status.photo, status.name, status.email);
      if (document.activeElement !== nameInput) nameInput.value = status.name || '';
      userEmail.textContent = status.email || '—';
    }
  }

  window.addEventListener('cloudsync:status', (e) => render(e.detail));

  if (window.CloudSync) render(window.CloudSync.getStatus());
  else render({ state: 'signed-out' });

  signInBtn.addEventListener('click', () => {
    if (window.CloudSync && typeof window.CloudSync.signIn === 'function') {
      window.CloudSync.signIn();
    } else {
      console.warn('CloudSync ще не завантажився');
    }
  });

  [signOutBtnPending, signOutBtn].forEach((btn) => {
    btn.addEventListener('click', () => {
      if (window.CloudSync && typeof window.CloudSync.signOut === 'function') {
        window.CloudSync.signOut();
      }
    });
  });

  forceSyncBtn.addEventListener('click', () => {
    if (window.CloudSync && typeof window.CloudSync.forceSync === 'function') {
      window.CloudSync.forceSync();
    }
  });

  if (nameInput) {
    nameInput.addEventListener('input', () => {
      if (avatarImg.style.display === 'none') {
        avatarInitials.textContent = initialsFrom(nameInput.value, userEmail.textContent);
      }
    });
    nameInput.addEventListener('change', () => {
      const trimmed = nameInput.value.trim();
      if (!trimmed) { nameInput.value = ''; return; } // порожнє ім'я не зберігаємо
      if (window.CloudSync && typeof window.CloudSync.updateDisplayName === 'function') {
        window.CloudSync.updateDisplayName(trimmed).catch(() => {});
      }
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') nameInput.blur(); // тригерить 'change' і закриває клавіатуру
    });
  }

  // "Лінія роботи" / "Процес" — поки що суто локальні поля (окрема
  // заготовка під майбутні публічні профілі), не йдуть у Firebase.
  const lineInput = document.getElementById('profileLineInput');
  const processInput = document.getElementById('profileProcessInput');
  const META_KEY = 'shiftTrackerProfileMeta';

  try {
    const saved = JSON.parse(localStorage.getItem(META_KEY) || '{}');
    if (lineInput) lineInput.value = saved.line || '';
    if (processInput) processInput.value = saved.process || '';
  } catch (e) { /* ігноруємо биту локальну сесію */ }

  function saveProfileMeta() {
    try {
      localStorage.setItem(META_KEY, JSON.stringify({
        line: lineInput.value.trim(),
        process: processInput.value.trim(),
      }));
    } catch (e) { /* локальне сховище недоступне — просто нічого не зберігаємо */ }
  }
  if (lineInput) lineInput.addEventListener('change', saveProfileMeta);
  if (processInput) processInput.addEventListener('change', saveProfileMeta);
}


// ---------- Bottom nav + full-screen windows ----------
// Три вікна ("Профіль" / "Налаштування" / "Топ") — постійні DOM-вузли,
// які лише перемикають клас .open (див. CSS: opacity/transform, той
// самий підхід, що й у .overlay для модалки дня). Повторний тап по вже
// активній кнопці нав-бару закриває вікно назад на головний екран.
function initAppNav() {
  const buttons = document.querySelectorAll('.nav-btn[data-window]');
  const windows = document.querySelectorAll('.app-window[data-window]');
  if (!buttons.length || !windows.length) return;

  let activeWindow = null;

  function closeAllWindows() {
    windows.forEach(w => w.classList.remove('open'));
    buttons.forEach(b => b.classList.remove('active'));
    document.body.classList.remove('nav-window-open');
    activeWindow = null;
  }

  function openWindow(name) {
    windows.forEach(w => w.classList.toggle('open', w.dataset.window === name));
    buttons.forEach(b => b.classList.toggle('active', b.dataset.window === name));
    document.body.classList.add('nav-window-open');
    activeWindow = name;
  }

  buttons.forEach(btn => {
    // touchend спрацьовує навіть тоді, коли цей самий дотик щойно
    // зупинив інерційний скрол сторінки — на відміну від click, який
    // браузер у такому разі просто не генерує (спрацював би лише на
    // наступному тапі). preventDefault тут же гасить "справжній" click,
    // що прийшов би слідом за touchend, щоб дія не викликалась двічі.
    let handledByTouch = false;
    function activate() {
      const name = btn.dataset.window;
      if (activeWindow === name) {
        closeAllWindows();
      } else {
        openWindow(name);
      }
    }
    btn.addEventListener('touchend', (e) => {
      e.preventDefault();
      handledByTouch = true;
      activate();
    }, { passive: false });
    btn.addEventListener('click', () => {
      if (handledByTouch) { handledByTouch = false; return; } // вже спрацювало по touchend
      activate(); // мишка/десктоп без touch-подій
    });
  });

  document.querySelectorAll('.app-window [data-close-window]').forEach(btn => {
    btn.addEventListener('click', closeAllWindows);
  });
}

// ---------- Shift settings (Бригада / Тип зміни) ----------
// Джерело правди — shiftConfig (script.js, синхронізовано з Firebase
// через CloudSync.updateShiftConfig). Ця функція лише малює поточний
// стан у двох місцях (Налаштування — перемикачі, Профіль — read-only
// чіпи) і слухає зміни, щоб обидва місця й сам календар лишались
// синхронними, звідки б зміна не прийшла (клік тут, чи підтягнута
// конфігурація з хмари при вході).
function initShiftSettings() {
  const brigadeToggle = document.getElementById('brigadeToggle');
  const shiftTypeToggle = document.getElementById('shiftTypeToggle');
  const chipProcess = document.getElementById('profileShiftProcess');
  const chipBrigade = document.getElementById('profileShiftBrigade');
  const chipType = document.getElementById('profileShiftType');
  const processInput = document.getElementById('profileProcessInput');
  if (!brigadeToggle || !shiftTypeToggle) return;

  function paintToggle(toggleEl, value) {
    toggleEl.querySelectorAll('.segmented-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.value === String(value));
    });
  }

  function paintChips() {
    if (chipBrigade) chipBrigade.textContent = shiftConfig.brigade === 2 ? '2 зміна' : '1 зміна';
    if (chipType) chipType.textContent = shiftConfig.shiftType === 'night' ? 'Нічна зміна' : 'Денна зміна';
    if (chipProcess) chipProcess.textContent = (processInput && processInput.value.trim()) || '—';
  }

  function render() {
    paintToggle(brigadeToggle, shiftConfig.brigade);
    paintToggle(shiftTypeToggle, shiftConfig.shiftType);
    paintChips();
  }

  render();

  brigadeToggle.querySelectorAll('.segmented-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const brigade = btn.dataset.value === '2' ? 2 : 1;
      if (brigade === shiftConfig.brigade) return;
      saveShiftConfig({ brigade: brigade, shiftType: shiftConfig.shiftType });
    });
  });
  shiftTypeToggle.querySelectorAll('.segmented-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const shiftType = btn.dataset.value === 'night' ? 'night' : 'day';
      if (shiftType === shiftConfig.shiftType) return;
      saveShiftConfig({ brigade: shiftConfig.brigade, shiftType: shiftType });
    });
  });

  // "Процес" у профілі так само лише дзеркалиться в чіп — сам вхідний
  // текст лишається редагованим тільки нижче, в profileProcessInput.
  if (processInput) processInput.addEventListener('input', paintChips);

  window.addEventListener('shiftconfig:change', () => {
    render();
    renderCalendar();
    renderToday();
    renderStats();
    renderGoal();
  });
}

// ---------- Dev notice accordion ----------
// max-height iде через JS (CSS max-height:none не анімується), а
// рядки тексту всередині проявляються самі через CSS transition-delay
// (див. .dev-notice-line в style.css) — тут лише перемикання класу.
function initDevNoticeAccordion() {
  const notice = document.getElementById('devNotice');
  const toggle = document.getElementById('devNoticeToggle');
  const body = document.getElementById('devNoticeBody');
  if (!notice || !toggle || !body) return;

  function open() {
    notice.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
    body.style.maxHeight = body.scrollHeight + 'px';
  }
  function close() {
    notice.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    body.style.maxHeight = '0px';
  }

  toggle.addEventListener('click', () => {
    if (notice.classList.contains('open')) close();
    else open();
  });

  document.addEventListener('click', (e) => {
    if (notice.classList.contains('open') && !notice.contains(e.target)) close();
  });
}

// ---------- Auth reminder (home screen) ----------
// Показується, поки немає підтвердженого cloud-аккаунту (signed-out або
// blocked) — ховається сама, щойно з'являється звʼязок із хмарою.
function initAuthReminder() {
  const reminder = document.getElementById('authReminder');
  if (!reminder) return;

  function render(status) {
    const show = !status || status.state === 'signed-out' || status.state === 'blocked';
    reminder.style.display = show ? '' : 'none';
  }

  window.addEventListener('cloudsync:status', (e) => render(e.detail));
  render(window.CloudSync ? window.CloudSync.getStatus() : { state: 'signed-out' });

  reminder.addEventListener('click', () => {
    const authBtn = document.querySelector('.nav-btn[data-window="auth"]');
    if (authBtn) authBtn.click();
  });
}

// ---------- Splash screen ----------
// Shown instantly on load; hidden once init() above has run, with a small
// minimum display time so it doesn't just flash on fast devices, then the
// app shell fades/slides in with a staggered entrance.
(function handleSplash() {
  const splash = document.getElementById('splash');
  const minVisible = 700;
  const shownAt = performance.now();

  function reveal() {
    const elapsed = performance.now() - shownAt;
    const wait = Math.max(0, minVisible - elapsed);
    setTimeout(() => {
      splash.classList.add('splash-hide');
      document.body.classList.add('app-ready');
      setTimeout(() => splash.remove(), 550);
    }, wait);
  }

  if (document.readyState === 'complete') {
    reveal();
  } else {
    window.addEventListener('load', reveal);
    // Safety net in case 'load' is delayed by slow external fonts/assets
    setTimeout(reveal, 2500);
  }
})();

// ---------- PWA: offline support + installability ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline caching just won't be available */ });
  });
}
