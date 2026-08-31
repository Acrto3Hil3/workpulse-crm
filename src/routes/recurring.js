'use strict';
const express = require('express');
const { q, one } = require('../db');
const { requireRole, requireLogin, flash, backTo } = require('../auth');
const { todayStr, diffDays, currentWeekBounds } = require('../dates');
const { generateRecurringEntries } = require('../cron');
const { logActivity } = require('../activity');

const router = express.Router();

// Items list (tabs: FMS / Checklist) + everything due now.
router.get('/', requireRole('manager'), async (req, res, next) => {
  try {
    const type = req.query.type === 'checklist' ? 'checklist' : 'fms';
    const { we } = currentWeekBounds();

    const items = await q(
      `SELECT i.*, u.name AS doer_name,
              (SELECT COUNT(*) FROM recurring_entries e WHERE e.recurring_item_id = i.id AND e.actual_date IS NULL) AS pending
       FROM recurring_items i JOIN users u ON u.id = i.doer_id
       WHERE i.type = ? ORDER BY i.active DESC, u.name, i.name`,
      [type]
    );
    const dueNow = await q(
      `SELECT e.id, e.planned_date, e.status, i.name, i.type, u.name AS doer_name
       FROM recurring_entries e
       JOIN recurring_items i ON i.id = e.recurring_item_id
       JOIN users u ON u.id = i.doer_id
       WHERE i.type = ? AND i.active = TRUE AND e.actual_date IS NULL AND e.planned_date <= ?
       ORDER BY e.planned_date ASC LIMIT 200`,
      [type, we]
    );
    res.render('recurring/index', { title: type === 'fms' ? 'FMS' : 'Checklist', type, items, dueNow });
  } catch (err) { next(err); }
});

router.get('/new', requireRole('manager'), async (req, res, next) => {
  try {
    const type = req.query.type === 'checklist' ? 'checklist' : 'fms';
    const doers = await q("SELECT id, name FROM users WHERE role = 'doer' AND active = TRUE ORDER BY name");
    res.render('recurring/form', { title: type === 'fms' ? 'New FMS item' : 'New checklist item', type, doers });
  } catch (err) { next(err); }
});

router.post('/', requireRole('manager'), async (req, res, next) => {
  try {
    const type = req.body.type === 'checklist' ? 'checklist' : 'fms';
    const name = String(req.body.name || '').trim().slice(0, 200);
    const method = String(req.body.method || '').trim().slice(0, 500) || null;
    const frequency = ['daily', 'weekly', 'monthly'].includes(req.body.frequency) ? req.body.frequency : 'weekly';
    const doerId = Number(req.body.doer_id);
    if (!name || !doerId) {
      flash(req, 'error', 'A name and a person are required.');
      return res.redirect(`/recurring/new?type=${type}`);
    }
    const doer = await one("SELECT id FROM users WHERE id = ? AND role = 'doer' AND active = TRUE", [doerId]);
    if (!doer) {
      flash(req, 'error', 'That person was not found.');
      return res.redirect(`/recurring/new?type=${type}`);
    }
    await q(
      'INSERT INTO recurring_items (type, name, doer_id, method, frequency) VALUES (?, ?, ?, ?, ?)',
      [type, name, doerId, method, frequency]
    );
    await generateRecurringEntries(); // create the current cycle right away
    logActivity(req.user.id, 'item_added', `${type === 'fms' ? 'FMS' : 'Checklist'}: ${name} (${frequency})`, doerId);
    flash(req, 'success', `${name} added and its first cycle created.`);
    res.redirect(`/recurring?type=${type}`);
  } catch (err) { next(err); }
});

router.post('/:id(\\d+)/toggle', requireRole('manager'), async (req, res, next) => {
  try {
    await q('UPDATE recurring_items SET active = NOT active WHERE id = ?', [req.params.id]);
    flash(req, 'success', 'Updated.');
    res.redirect(backTo(req, '/recurring'));
  } catch (err) { next(err); }
});

// Mark a cycle entry done — the doer for their own item, or any manager.
router.post('/entries/:id(\\d+)/done', requireLogin, async (req, res, next) => {
  try {
    const entry = await one(
      `SELECT e.*, i.doer_id, i.name FROM recurring_entries e
       JOIN recurring_items i ON i.id = e.recurring_item_id WHERE e.id = ?`,
      [req.params.id]
    );
    if (!entry) return res.redirect(backTo(req));
    const isManager = req.user.role === 'owner' || req.user.role === 'manager';
    if (!isManager && entry.doer_id !== req.user.id) {
      flash(req, 'error', 'That item is not yours.');
      return res.redirect(backTo(req));
    }
    if (entry.actual_date) return res.redirect(backTo(req));
    const today = todayStr();
    const delay = Math.max(0, diffDays(entry.planned_date, today));
    await q(
      "UPDATE recurring_entries SET actual_date = ?, status = 'done', delay_days = ? WHERE id = ?",
      [today, delay, entry.id]
    );
    logActivity(req.user.id, 'entry_done', `${entry.name}${delay ? ` (${delay} day${delay > 1 ? 's' : ''} late)` : ''}`, entry.doer_id);
    flash(req, 'success', `${entry.name} marked done${delay ? ` (${delay} day${delay > 1 ? 's' : ''} late)` : ''}.`);
    res.redirect(backTo(req));
  } catch (err) { next(err); }
});

router.post('/entries/:id(\\d+)/undo', requireRole('manager'), async (req, res, next) => {
  try {
    const entry = await one('SELECT * FROM recurring_entries WHERE id = ?', [req.params.id]);
    if (!entry) return res.redirect(backTo(req, '/recurring'));
    const status = entry.planned_date < todayStr() ? 'missed' : 'pending';
    await q(
      'UPDATE recurring_entries SET actual_date = NULL, status = ?, delay_days = NULL WHERE id = ?',
      [status, entry.id]
    );
    const item = await one('SELECT name, doer_id FROM recurring_items WHERE id = ?', [entry.recurring_item_id]);
    if (item) logActivity(req.user.id, 'entry_undone', item.name, item.doer_id);
    flash(req, 'success', 'Entry reset.');
    res.redirect(backTo(req, '/recurring'));
  } catch (err) { next(err); }
});

module.exports = router;
