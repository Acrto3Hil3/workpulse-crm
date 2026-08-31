'use strict';
const express = require('express');
const { q, one, insert } = require('../db');
const { requireRole, requireLogin, flash, backTo } = require('../auth');
const { todayStr, isValidDateStr, weekStartOf, fmtNice } = require('../dates');
const { logActivity } = require('../activity');

const router = express.Router();
const PAGE_SIZE = 25;

// List with filters + pagination (managers/owner).
router.get('/', requireRole('manager'), async (req, res, next) => {
  try {
    const doerId = Number(req.query.doer_id) || 0;
    const status = ['assigned', 'completed', 'week_shifted'].includes(req.query.status) ? req.query.status : '';
    const search = String(req.query.q || '').trim().slice(0, 100);
    const page = Math.max(1, Number(req.query.page) || 1);

    const where = [];
    const params = [];
    if (doerId) { where.push('d.doer_id = ?'); params.push(doerId); }
    if (status) { where.push('d.status = ?'); params.push(status); }
    if (search) {
      where.push('(LOWER(d.description) LIKE LOWER(?) OR LOWER(d.public_task_id) LIKE LOWER(?))');
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [{ c: total }] = await q(`SELECT COUNT(*) c FROM delegations d ${whereSql}`, params);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rows = await q(
      `SELECT d.*, u.name AS doer_name FROM delegations d
       JOIN users u ON u.id = d.doer_id
       ${whereSql}
       ORDER BY (d.status = 'completed'), d.due_date ASC, d.id DESC
       LIMIT ? OFFSET ?`,
      [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
    );
    const doers = await q("SELECT id, name FROM users WHERE role = 'doer' AND active = TRUE ORDER BY name");

    res.render('delegations/index', {
      title: 'Tasks', rows, doers, total, page, pages,
      filters: { doer_id: doerId, status, q: search }
    });
  } catch (err) { next(err); }
});

router.get('/new', requireRole('manager'), async (req, res, next) => {
  try {
    const doers = await q("SELECT id, name FROM users WHERE role = 'doer' AND active = TRUE ORDER BY name");
    res.render('delegations/form', { title: 'Assign task', doers, selectedDoer: Number(req.query.doer_id) || 0 });
  } catch (err) { next(err); }
});

router.post('/', requireRole('manager'), async (req, res, next) => {
  try {
    const doerId = Number(req.body.doer_id);
    const description = String(req.body.description || '').trim().slice(0, 500);
    const firstDate = String(req.body.first_date || '').trim();
    if (!doerId || !description || !isValidDateStr(firstDate)) {
      flash(req, 'error', 'Pick a person, write the task, and choose a valid date.');
      return res.redirect('/delegations/new');
    }
    const doer = await one("SELECT id FROM users WHERE id = ? AND role = 'doer' AND active = TRUE", [doerId]);
    if (!doer) {
      flash(req, 'error', 'That person was not found.');
      return res.redirect('/delegations/new');
    }
    const newId = await insert(
      `INSERT INTO delegations (doer_id, description, first_date, due_date, status, created_by)
       VALUES (?, ?, ?, ?, 'assigned', ?)`,
      [doerId, description, firstDate, firstDate, req.user.id]
    );
    const publicId = 'T-' + String(newId).padStart(4, '0');
    await q('UPDATE delegations SET public_task_id = ? WHERE id = ?', [publicId, newId]);
    logActivity(req.user.id, 'task_assigned', `${publicId}: ${description} (due ${fmtNice(firstDate)})`, doerId);
    flash(req, 'success', `Task ${publicId} assigned.`);
    res.redirect('/delegations');
  } catch (err) { next(err); }
});

// Mark done — a doer can complete their own task; managers can complete anyone's.
router.post('/:id(\\d+)/complete', requireLogin, async (req, res, next) => {
  try {
    const d = await one('SELECT * FROM delegations WHERE id = ?', [req.params.id]);
    if (!d) return res.redirect(backTo(req));
    const isManager = req.user.role === 'owner' || req.user.role === 'manager';
    if (!isManager && d.doer_id !== req.user.id) {
      flash(req, 'error', 'That task is not yours.');
      return res.redirect(backTo(req));
    }
    if (d.status === 'completed') return res.redirect(backTo(req));
    await q("UPDATE delegations SET status = 'completed', completed_at = ? WHERE id = ?", [todayStr(), d.id]);
    logActivity(req.user.id, 'task_completed', `${d.public_task_id}: ${d.description}`, d.doer_id);
    flash(req, 'success', `${d.public_task_id || 'Task'} marked done. Good work!`);
    res.redirect(backTo(req));
  } catch (err) { next(err); }
});

// Push the deadline — records Revision 1 / Revision 2 and counts every slip.
router.post('/:id(\\d+)/revise', requireRole('manager'), async (req, res, next) => {
  try {
    const d = await one('SELECT * FROM delegations WHERE id = ?', [req.params.id]);
    const newDate = String(req.body.new_date || '').trim();
    if (!d || d.status === 'completed' || !isValidDateStr(newDate)) {
      flash(req, 'error', 'Could not move that date.');
      return res.redirect(backTo(req, '/delegations'));
    }
    const rev1 = d.revision_1_date || newDate;
    const rev2 = d.revision_1_date ? (d.revision_2_date || newDate) : d.revision_2_date;
    // "Week shifted" = the commitment moved out of its original week.
    const shifted = weekStartOf(newDate) > weekStartOf(d.first_date);
    await q(
      `UPDATE delegations SET due_date = ?, revision_1_date = ?, revision_2_date = ?,
         latest_revision_date = ?, total_revisions = total_revisions + 1, status = ?
       WHERE id = ?`,
      [newDate, rev1, rev2, newDate, shifted ? 'week_shifted' : 'assigned', d.id]
    );
    logActivity(req.user.id, 'task_revised',
      `${d.public_task_id}: due moved to ${fmtNice(newDate)} (revision #${d.total_revisions + 1})`, d.doer_id);
    flash(req, 'success', `Deadline moved (revision #${d.total_revisions + 1}).`);
    res.redirect(backTo(req, '/delegations'));
  } catch (err) { next(err); }
});

// Undo an accidental completion.
router.post('/:id(\\d+)/reopen', requireRole('manager'), async (req, res, next) => {
  try {
    const d = await one('SELECT * FROM delegations WHERE id = ?', [req.params.id]);
    if (!d || d.status !== 'completed') return res.redirect(backTo(req, '/delegations'));
    const shifted = d.total_revisions > 0 && weekStartOf(d.due_date) > weekStartOf(d.first_date);
    await q("UPDATE delegations SET status = ?, completed_at = NULL WHERE id = ?",
      [shifted ? 'week_shifted' : 'assigned', d.id]);
    logActivity(req.user.id, 'task_reopened', `${d.public_task_id}: ${d.description}`, d.doer_id);
    flash(req, 'success', 'Task reopened.');
    res.redirect(backTo(req, '/delegations'));
  } catch (err) { next(err); }
});

router.post('/:id(\\d+)/delete', requireRole('owner'), async (req, res, next) => {
  try {
    const d = await one('SELECT * FROM delegations WHERE id = ?', [req.params.id]);
    await q('DELETE FROM delegations WHERE id = ?', [req.params.id]);
    if (d) logActivity(req.user.id, 'task_deleted', `${d.public_task_id}: ${d.description}`, d.doer_id);
    flash(req, 'success', 'Task deleted.');
    res.redirect(backTo(req, '/delegations'));
  } catch (err) { next(err); }
});

module.exports = router;
