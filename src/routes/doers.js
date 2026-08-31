'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { q, one, insert } = require('../db');
const { requireRole, flash } = require('../auth');
const { lastNWeekStarts } = require('../dates');
const { logActivity } = require('../activity');

const router = express.Router();

function cleanUserInput(body) {
  const name = String(body.name || '').trim().slice(0, 100);
  const phone = String(body.phone || '').trim().slice(0, 30) || null;
  const email = String(body.email || '').trim().toLowerCase().slice(0, 190) || null;
  const role = ['owner', 'manager', 'doer'].includes(body.role) ? body.role : 'doer';
  const password = String(body.password || '');
  return { name, phone, email, role, password };
}

// Team list — managers can view, owner manages.
router.get('/', requireRole('manager'), async (req, res, next) => {
  try {
    const people = await q(
      `SELECT id, name, phone, email, role, active FROM users
       ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, active DESC, name`
    );
    res.render('doers/index', { title: 'Team', people });
  } catch (err) { next(err); }
});

router.get('/new', requireRole('owner'), (req, res) => {
  res.render('doers/form', { title: 'Add person', person: null });
});

router.post('/', requireRole('owner'), async (req, res, next) => {
  try {
    const { name, phone, email, role, password } = cleanUserInput(req.body);
    if (!name || (!phone && !email) || password.length < 4) {
      flash(req, 'error', 'Name, a phone or email, and a password of at least 4 characters are required.');
      return res.redirect('/doers/new');
    }
    const clash = await one(
      'SELECT id FROM users WHERE (email IS NOT NULL AND LOWER(email) = LOWER(?)) OR (phone IS NOT NULL AND phone = ?)',
      [email || '', phone || '']
    );
    if (clash) {
      flash(req, 'error', 'Someone with that phone or email already exists.');
      return res.redirect('/doers/new');
    }
    const newId = await insert(
      'INSERT INTO users (name, phone, email, role, password_hash) VALUES (?, ?, ?, ?, ?)',
      [name, phone, email, role, bcrypt.hashSync(password, 10)]
    );
    logActivity(req.user.id, 'user_added', `${name} (${role})`, newId);
    flash(req, 'success', `${name} added. They log in with their ${phone ? 'phone number' : 'email'}.`);
    res.redirect('/doers');
  } catch (err) { next(err); }
});

// Drill-in: one person's tasks + score history.
router.get('/:id(\\d+)', requireRole('manager'), async (req, res, next) => {
  try {
    const person = await one('SELECT id, name, phone, email, role, active FROM users WHERE id = ?', [req.params.id]);
    if (!person) return res.redirect('/doers');

    const weekStarts = lastNWeekStarts(12);
    const scores = await q(
      `SELECT week_start, week_number, planned_count, actual_count, score, rating
       FROM weekly_scores WHERE doer_id = ? AND week_start >= ? ORDER BY week_start DESC`,
      [person.id, weekStarts[0]]
    );
    const openTasks = await q(
      `SELECT id, public_task_id, description, first_date, due_date, total_revisions, status
       FROM delegations WHERE doer_id = ? AND status <> 'completed' ORDER BY due_date ASC LIMIT 100`,
      [person.id]
    );
    const recentDone = await q(
      `SELECT id, public_task_id, description, due_date, completed_at, total_revisions
       FROM delegations WHERE doer_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 10`,
      [person.id]
    );
    const items = await q(
      `SELECT i.id, i.type, i.name, i.frequency, i.active,
              (SELECT COUNT(*) FROM recurring_entries e WHERE e.recurring_item_id = i.id AND e.actual_date IS NULL) AS pending
       FROM recurring_items i WHERE i.doer_id = ? ORDER BY i.type, i.name`,
      [person.id]
    );
    res.render('doers/show', { title: person.name, person, scores, openTasks, recentDone, items });
  } catch (err) { next(err); }
});

router.get('/:id(\\d+)/edit', requireRole('owner'), async (req, res, next) => {
  try {
    const person = await one('SELECT id, name, phone, email, role, active FROM users WHERE id = ?', [req.params.id]);
    if (!person) return res.redirect('/doers');
    res.render('doers/form', { title: `Edit ${person.name}`, person });
  } catch (err) { next(err); }
});

router.post('/:id(\\d+)', requireRole('owner'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { name, phone, email, role, password } = cleanUserInput(req.body);
    if (!name || (!phone && !email)) {
      flash(req, 'error', 'Name and a phone or email are required.');
      return res.redirect(`/doers/${id}/edit`);
    }
    const clash = await one(
      'SELECT id FROM users WHERE id <> ? AND ((email IS NOT NULL AND LOWER(email) = LOWER(?)) OR (phone IS NOT NULL AND phone = ?))',
      [id, email || '', phone || '']
    );
    if (clash) {
      flash(req, 'error', 'Someone else already uses that phone or email.');
      return res.redirect(`/doers/${id}/edit`);
    }
    await q('UPDATE users SET name = ?, phone = ?, email = ?, role = ? WHERE id = ?', [name, phone, email, role, id]);
    if (password) {
      if (password.length < 4) {
        flash(req, 'error', 'Password must be at least 4 characters. Other details were saved.');
        return res.redirect(`/doers/${id}/edit`);
      }
      await q('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(password, 10), id]);
    }
    flash(req, 'success', 'Saved.');
    res.redirect('/doers');
  } catch (err) { next(err); }
});

// Deactivate instead of delete — history stays intact.
router.post('/:id(\\d+)/toggle', requireRole('owner'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) {
      flash(req, 'error', 'You cannot deactivate your own account.');
      return res.redirect('/doers');
    }
    await q('UPDATE users SET active = NOT active WHERE id = ?', [id]);
    flash(req, 'success', 'Updated.');
    res.redirect('/doers');
  } catch (err) { next(err); }
});

module.exports = router;
