#!/usr/bin/env node
'use strict';
/**
 * One-time import from the old Google Sheets system.
 * Export each sheet as CSV (File > Download > CSV) and run:
 *
 *   node scripts/import-sheets.js doers ./doer-list.csv --default-password 1234
 *   node scripts/import-sheets.js delegations ./delegation.csv
 *   node scripts/import-sheets.js archive ./archive.csv
 *
 * Column names are matched loosely (case/spacing ignored). Expected columns:
 *   doers:        name, phone?, email?, role?, password?
 *   delegations:  doer, task|description, first date, revision 1?, revision 2?, status?, completed?
 *   archive:      doer, week start|date, planned, actual        (score computed)
 *                 ...or doer, week start|date, score            (score taken as-is)
 * Rows whose doer name doesn't match an existing user are reported and skipped —
 * import doers first.
 */
require('dotenv').config();
if (process.env.APP_TZ) process.env.TZ = process.env.APP_TZ;

const fs = require('fs');
const bcrypt = require('bcryptjs');
const { pool, q, one, insert, sql } = require('../src/db');
const { fmt, weekStartOf, weekNumberOf, addDaysStr, isValidDateStr } = require('../src/dates');
const { computeScore, ratingFor, getThresholds } = require('../src/scoring');

// ---------- tiny CSV parser (quotes, commas, CRLF) ----------
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function headerIndex(headers, ...names) {
  const h = headers.map(norm);
  for (const n of names) {
    const i = h.indexOf(norm(n));
    if (i !== -1) return i;
  }
  // partial match fallback
  for (const n of names) {
    const i = h.findIndex(x => x.includes(norm(n)));
    if (i !== -1) return i;
  }
  return -1;
}

/** Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, MM/DD/YYYY-with-obvious-day>12. */
function flexDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (isValidDateStr(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    a = Number(a); b = Number(b); y = Number(y.length === 2 ? '20' + y : y);
    // default DD/MM/YYYY (Indian sheets); flip only when that is impossible
    let day = a, mon = b;
    if (mon > 12 && day <= 12) { day = b; mon = a; }
    const out = `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return isValidDateStr(out) ? out : null;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : fmt(d);
}

async function findUserByName(name) {
  return one('SELECT id, name FROM users WHERE LOWER(name) = LOWER(?)', [String(name).trim()]);
}

async function importDoers(rows, headers, opts) {
  const iName = headerIndex(headers, 'name', 'doer');
  const iPhone = headerIndex(headers, 'phone', 'mobile', 'contact');
  const iEmail = headerIndex(headers, 'email');
  const iRole = headerIndex(headers, 'role');
  const iPass = headerIndex(headers, 'password', 'pin');
  if (iName === -1) throw new Error('Could not find a "name" column.');

  let added = 0, skipped = 0;
  for (const r of rows) {
    const name = String(r[iName] || '').trim();
    if (!name) continue;
    if (await findUserByName(name)) { console.log(`  skip (exists): ${name}`); skipped++; continue; }
    const phone = iPhone !== -1 ? String(r[iPhone] || '').trim() || null : null;
    const email = iEmail !== -1 ? String(r[iEmail] || '').trim().toLowerCase() || null : null;
    const roleRaw = iRole !== -1 ? norm(r[iRole]) : '';
    const role = roleRaw.includes('owner') ? 'owner' : roleRaw.includes('manager') || roleRaw.includes('ea') ? 'manager' : 'doer';
    const password = (iPass !== -1 && String(r[iPass] || '').trim()) || opts.defaultPassword;
    await q('INSERT INTO users (name, phone, email, role, password_hash) VALUES (?, ?, ?, ?, ?)',
      [name, phone, email, role, bcrypt.hashSync(password, 10)]);
    console.log(`  added: ${name} (${role})`);
    added++;
  }
  console.log(`Doers: ${added} added, ${skipped} already existed.`);
}

async function importDelegations(rows, headers) {
  const iDoer = headerIndex(headers, 'doer', 'name', 'who');
  const iDesc = headerIndex(headers, 'task', 'description', 'work');
  const iFirst = headerIndex(headers, 'firstdate', 'first date', 'date', 'deadline');
  const iRev1 = headerIndex(headers, 'revision1', 'rev1');
  const iRev2 = headerIndex(headers, 'revision2', 'rev2');
  const iStatus = headerIndex(headers, 'status');
  const iDone = headerIndex(headers, 'completed', 'actualdate', 'actual');
  if (iDoer === -1 || iDesc === -1 || iFirst === -1) {
    throw new Error('Need at least doer, task/description and first date columns.');
  }

  let added = 0, noUser = 0, bad = 0;
  for (const r of rows) {
    const doerName = String(r[iDoer] || '').trim();
    const desc = String(r[iDesc] || '').trim().slice(0, 500);
    const first = flexDate(r[iFirst]);
    if (!doerName || !desc || !first) { bad++; continue; }
    const user = await findUserByName(doerName);
    if (!user) { console.log(`  no matching user: "${doerName}" — import doers first`); noUser++; continue; }

    const rev1 = iRev1 !== -1 ? flexDate(r[iRev1]) : null;
    const rev2 = iRev2 !== -1 ? flexDate(r[iRev2]) : null;
    const latest = rev2 || rev1 || null;
    const due = latest || first;
    const revisions = (rev1 ? 1 : 0) + (rev2 ? 1 : 0);
    const statusRaw = iStatus !== -1 ? norm(r[iStatus]) : '';
    const doneDate = iDone !== -1 ? flexDate(r[iDone]) : null;
    let status = 'assigned';
    if (statusRaw.includes('complete') || statusRaw.includes('done') || doneDate) status = 'completed';
    else if (statusRaw.includes('shift') || revisions > 0) status = 'week_shifted';

    const newId = await insert(
      `INSERT INTO delegations (doer_id, description, first_date, due_date, revision_1_date, revision_2_date,
         latest_revision_date, total_revisions, status, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user.id, desc, first, due, rev1, rev2, latest, revisions, status, status === 'completed' ? (doneDate || due) : null]
    );
    await q('UPDATE delegations SET public_task_id = ? WHERE id = ?',
      ['T-' + String(newId).padStart(4, '0'), newId]);
    added++;
  }
  console.log(`Delegations: ${added} added, ${noUser} skipped (unknown doer), ${bad} skipped (missing data).`);
  console.log('Now open Scores in the app and use "Rebuild older weeks" to score the imported history.');
}

async function importArchive(rows, headers) {
  const iDoer = headerIndex(headers, 'doer', 'name');
  const iWeek = headerIndex(headers, 'weekstart', 'week', 'date');
  const iPlanned = headerIndex(headers, 'planned');
  const iActual = headerIndex(headers, 'actual', 'done');
  const iScore = headerIndex(headers, 'score');
  if (iDoer === -1 || iWeek === -1) throw new Error('Need doer and week start/date columns.');
  const thresholds = await getThresholds();

  let added = 0, noUser = 0, bad = 0;
  for (const r of rows) {
    const user = await findUserByName(r[iDoer]);
    if (!user) { noUser++; continue; }
    const anyDate = flexDate(r[iWeek]);
    if (!anyDate) { bad++; continue; }
    const ws = fmt(weekStartOf(anyDate));
    const we = addDaysStr(ws, 6);

    let planned = iPlanned !== -1 ? Number(r[iPlanned]) : NaN;
    let actual = iActual !== -1 ? Number(r[iActual]) : NaN;
    let score;
    if (Number.isFinite(planned) && Number.isFinite(actual)) {
      score = Math.round(computeScore(planned, actual) * 100) / 100;
    } else if (iScore !== -1 && Number.isFinite(Number(r[iScore]))) {
      score = Math.max(-100, Math.min(0, Number(r[iScore])));
      planned = 0; actual = 0;
    } else { bad++; continue; }

    await q(
      `INSERT INTO weekly_scores (doer_id, week_number, week_start, week_end, planned_count, actual_count, score, rating, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ${sql.upsert('doer_id, week_start', ['planned_count', 'actual_count', 'score', 'rating', 'computed_at'])}`,
      [user.id, weekNumberOf(ws), ws, we, planned || 0, actual || 0, score, ratingFor(score, thresholds)]
    );
    added++;
  }
  console.log(`Archive: ${added} weekly scores imported, ${noUser} skipped (unknown doer), ${bad} skipped (missing data).`);
}

async function main() {
  const [kind, file, ...rest] = process.argv.slice(2);
  const opts = { defaultPassword: '1234' };
  const dpIdx = rest.indexOf('--default-password');
  if (dpIdx !== -1 && rest[dpIdx + 1]) opts.defaultPassword = rest[dpIdx + 1];

  if (!['doers', 'delegations', 'archive'].includes(kind) || !file) {
    console.log('Usage: node scripts/import-sheets.js <doers|delegations|archive> <file.csv> [--default-password 1234]');
    process.exit(1);
  }
  if (!fs.existsSync(file)) { console.error(`File not found: ${file}`); process.exit(1); }

  const rows = parseCSV(fs.readFileSync(file, 'utf8'));
  if (rows.length < 2) { console.error('CSV has no data rows.'); process.exit(1); }
  const headers = rows[0];
  const data = rows.slice(1);
  console.log(`Importing ${data.length} rows from ${file} as "${kind}"...`);

  if (kind === 'doers') await importDoers(data, headers, opts);
  if (kind === 'delegations') await importDelegations(data, headers);
  if (kind === 'archive') await importArchive(data, headers);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
