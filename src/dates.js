'use strict';
// All date logic. Weeks run Sunday -> Saturday (the business reviews Sunday-to-Sunday).
// Dates travel through the app as 'YYYY-MM-DD' strings (mysql2 dateStrings: true).

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parseDate(s) {
  if (s instanceof Date) return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmt(d) {
  const dt = d instanceof Date ? d : parseDate(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function todayStr() {
  return fmt(new Date());
}

function addDays(d, n) {
  const dt = parseDate(d);
  dt.setDate(dt.getDate() + n);
  return dt;
}

function addDaysStr(d, n) {
  return fmt(addDays(d, n));
}

/** Sunday of the week containing d. */
function weekStartOf(d) {
  const dt = parseDate(d);
  dt.setDate(dt.getDate() - dt.getDay()); // getDay(): 0 = Sunday
  return dt;
}

/** { ws, we } as 'YYYY-MM-DD' for the week containing d (Sunday..Saturday). */
function weekBoundsOf(d) {
  const start = weekStartOf(d);
  return { ws: fmt(start), we: fmt(addDays(start, 6)) };
}

function currentWeekBounds() {
  return weekBoundsOf(new Date());
}

function previousWeekBounds() {
  const { ws } = currentWeekBounds();
  return weekBoundsOf(addDays(ws, -7));
}

/** Week number within the year of the week's Sunday (week 1 = week containing Jan 1). */
function weekNumberOf(weekStart) {
  const ws = parseDate(weekStart);
  const firstWs = weekStartOf(new Date(ws.getFullYear(), 0, 1));
  return Math.floor((ws - firstWs) / (7 * DAY)) + 1;
}

/** e.g. '2026-W35' — used as the cycle label for weekly recurring items. */
function weekLabelOf(d) {
  const start = weekStartOf(d);
  return `${start.getFullYear()}-W${String(weekNumberOf(start)).padStart(2, '0')}`;
}

function lastDayOfMonthStr(d) {
  const dt = parseDate(d);
  return fmt(new Date(dt.getFullYear(), dt.getMonth() + 1, 0));
}

function monthLabelOf(d) {
  const dt = parseDate(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

/** Whole days from a to b (b - a). */
function diffDays(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / DAY);
}

function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const dt = parseDate(s);
  return !Number.isNaN(dt.getTime()) && fmt(dt) === s;
}

/** '30 Aug' — compact display. */
function fmtNice(s) {
  if (!s) return '—';
  const dt = parseDate(s);
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]}`;
}

/** '30 Aug 2026' — full display. */
function fmtFull(s) {
  if (!s) return '—';
  const dt = parseDate(s);
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}

/** Last n week starts (as 'YYYY-MM-DD'), oldest first, ending with the current week. */
function lastNWeekStarts(n) {
  const { ws } = currentWeekBounds();
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDaysStr(ws, -7 * i));
  return out;
}

module.exports = {
  parseDate, fmt, todayStr, addDays, addDaysStr,
  weekStartOf, weekBoundsOf, currentWeekBounds, previousWeekBounds,
  weekNumberOf, weekLabelOf, lastDayOfMonthStr, monthLabelOf,
  diffDays, isValidDateStr, fmtNice, fmtFull, lastNWeekStarts
};
