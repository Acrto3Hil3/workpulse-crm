#!/usr/bin/env node
'use strict';
/**
 * Fills the database with realistic demo data so you can try the app.
 * Run AFTER the first boot (npm start once, so tables exist):
 *   npm run demo
 * Creates 4 doers (password 1234), a manager (password 1234), tasks across
 * the last 4 weeks, FMS + checklist items, and computes all scores.
 * Safe guard: refuses to run if any delegation already exists.
 */
require('dotenv').config();
if (process.env.APP_TZ) process.env.TZ = process.env.APP_TZ;

const bcrypt = require('bcryptjs');
const { pool, q, one, insert } = require('../src/db');
const { todayStr, addDaysStr, currentWeekBounds, lastNWeekStarts } = require('../src/dates');
const { computeWeek } = require('../src/scoring');
const { generateRecurringEntries, flagMissedEntries } = require('../src/cron');

async function main() {
  const [{ c }] = await q('SELECT COUNT(*) c FROM delegations');
  if (c > 0) {
    console.log('Database already has tasks — demo seeding skipped (it only runs on an empty system).');
    await pool.end();
    return;
  }

  const hash = bcrypt.hashSync('1234', 10);
  const people = [
    { name: 'Ramesh Kumar', phone: '9800000001', role: 'doer' },
    { name: 'Priya Sharma', phone: '9800000002', role: 'doer' },
    { name: 'Sunil Verma', phone: '9800000003', role: 'doer' },
    { name: 'Kavita Joshi', phone: '9800000004', role: 'doer' },
    { name: 'Anil (EA)', phone: '9800000005', role: 'manager' }
  ];
  const ids = {};
  for (const p of people) {
    const existing = await one('SELECT id FROM users WHERE phone = ?', [p.phone]);
    if (existing) { ids[p.name] = existing.id; continue; }
    ids[p.name] = await insert('INSERT INTO users (name, phone, role, password_hash) VALUES (?, ?, ?, ?)',
      [p.name, p.phone, p.role, hash]);
  }
  console.log('People created (login = phone number, password = 1234)');

  const { ws } = currentWeekBounds();
  const today = todayStr();
  // [doer, description, dueOffsetDaysFromWeekStart (can be negative = past weeks), done?, doneOffset?, revisions?]
  const tasks = [
    ['Ramesh Kumar', 'Service the compressor in Unit 2', 2, false, 0, 0],
    ['Ramesh Kumar', 'Send pending GST invoices to accountant', -5, true, -5, 0],
    ['Ramesh Kumar', 'Get quotation for new conveyor belt', -12, true, -11, 1],
    ['Ramesh Kumar', 'Arrange fire extinguisher refill', -1, false, 0, 1],
    ['Priya Sharma', 'Update the dispatch register format', 3, false, 0, 0],
    ['Priya Sharma', 'Call transporter about weekly rate', -6, true, -6, 0],
    ['Priya Sharma', 'Prepare salary sheet for August', -8, true, -8, 0],
    ['Priya Sharma', 'File the pending purchase bills', -13, true, -13, 0],
    ['Sunil Verma', 'Repair the packing machine sensor', -2, false, 0, 2],
    ['Sunil Verma', 'Stock count of raw material store', -7, false, 0, 1],
    ['Sunil Verma', 'Label the new inventory racks', -9, true, -6, 0],
    ['Kavita Joshi', 'Follow up with 3 pending customers', 1, false, 0, 0],
    ['Kavita Joshi', 'Send samples to the Ludhiana buyer', -6, true, -7, 0],
    ['Kavita Joshi', 'Update the price list with new rates', -12, true, -12, 0],
    ['Kavita Joshi', 'Collect C-forms from the Delhi party', -14, true, -13, 0]
  ];
  for (const [who, desc, off, done, doneOff, revs] of tasks) {
    const due = addDaysStr(ws, off);
    const first = revs ? addDaysStr(due, -7 * revs) : due;
    const rev1 = revs >= 1 ? (revs === 1 ? due : addDaysStr(due, -7)) : null;
    const rev2 = revs >= 2 ? due : null;
    const status = done ? 'completed' : (revs ? 'week_shifted' : 'assigned');
    const completedAt = done ? addDaysStr(ws, doneOff) : null;
    const newId = await insert(
      `INSERT INTO delegations (doer_id, description, first_date, due_date, revision_1_date, revision_2_date,
         latest_revision_date, total_revisions, status, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ids[who], desc, first, due, rev1, rev2, revs ? due : null, revs, status, completedAt]
    );
    await q('UPDATE delegations SET public_task_id = ? WHERE id = ?',
      ['T-' + String(newId).padStart(4, '0'), newId]);
  }
  console.log(`${tasks.length} delegated tasks created`);

  const items = [
    ['fms', 'Follow up pending customer payments', 'Kavita Joshi', 'Call list from Tally outstanding report', 'weekly'],
    ['fms', 'Check generator diesel level', 'Ramesh Kumar', 'Dip check, log in register', 'weekly'],
    ['checklist', 'Backup the billing computer', 'Priya Sharma', 'Copy Tally data to pen drive', 'weekly'],
    ['checklist', 'Factory floor safety walk', 'Sunil Verma', 'Walk all 3 units with the checklist card', 'daily']
  ];
  for (const [type, name, who, method, freq] of items) {
    await q('INSERT INTO recurring_items (type, name, doer_id, method, frequency) VALUES (?, ?, ?, ?, ?)',
      [type, name, ids[who], method, freq]);
  }
  await generateRecurringEntries();
  // Mark a couple done so the demo shows variety.
  const entries = await q('SELECT id, planned_date FROM recurring_entries LIMIT 2');
  for (const e of entries) {
    await q("UPDATE recurring_entries SET actual_date = ?, status = 'done', delay_days = 0 WHERE id = ?", [today, e.id]);
  }
  await flagMissedEntries();
  console.log('Recurring FMS + checklist items created');

  for (const w of lastNWeekStarts(4)) await computeWeek(w);
  console.log('Weekly scores computed for the last 4 weeks');
  console.log('\nDemo ready. Log in as the owner (from .env), or as a doer e.g. 9800000001 / 1234');
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
