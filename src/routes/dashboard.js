'use strict';
const express = require('express');
const { q } = require('../db');
const { requireLogin, requireRole } = require('../auth');
const { currentWeekBounds, weekNumberOf, todayStr, lastNWeekStarts } = require('../dates');
const { ACTION_LABELS } = require('../activity');

const router = express.Router();

/** Everything the doer home screen needs. */
async function doerHomeData(doerId) {
  const today = todayStr();
  const { ws, we } = currentWeekBounds();

  const overdue = await q(
    `SELECT id, public_task_id, description, due_date, total_revisions FROM delegations
     WHERE doer_id = ? AND status <> 'completed' AND due_date < ?
     ORDER BY due_date ASC LIMIT 50`,
    [doerId, today]
  );
  const dueThisWeek = await q(
    `SELECT id, public_task_id, description, due_date, total_revisions FROM delegations
     WHERE doer_id = ? AND status <> 'completed' AND due_date BETWEEN ? AND ?
     ORDER BY due_date ASC LIMIT 100`,
    [doerId, today, we]
  );
  const routine = await q(
    `SELECT e.id, e.planned_date, e.status, i.name, i.type FROM recurring_entries e
     JOIN recurring_items i ON i.id = e.recurring_item_id
     WHERE i.doer_id = ? AND i.active = TRUE AND e.actual_date IS NULL AND e.planned_date <= ?
     ORDER BY e.planned_date ASC LIMIT 100`,
    [doerId, we]
  );
  const scores = await q(
    `SELECT week_start, week_number, planned_count, actual_count, score, rating
     FROM weekly_scores WHERE doer_id = ? ORDER BY week_start DESC LIMIT 8`,
    [doerId]
  );
  return { overdue, dueThisWeek, routine, scores, ws, we };
}

router.get('/', requireLogin, async (req, res, next) => {
  try {
    if (req.user.role === 'doer') {
      const data = await doerHomeData(req.user.id);
      return res.render('dash-doer', { title: 'My tasks', ...data });
    }

    const { ws, we } = currentWeekBounds();
    const tiles = await q(
      `SELECT u.id, u.name,
              (SELECT COUNT(*) FROM delegations d WHERE d.doer_id = u.id AND d.status <> 'completed') AS open_tasks,
              (SELECT COUNT(*) FROM delegations d WHERE d.doer_id = u.id AND d.status <> 'completed' AND d.due_date < CURRENT_DATE) AS overdue,
              ws.planned_count, ws.actual_count, ws.score, ws.rating
       FROM users u
       LEFT JOIN weekly_scores ws ON ws.doer_id = u.id AND ws.week_start = ?
       WHERE u.role = 'doer' AND u.active = TRUE
       ORDER BY u.name`,
      [ws]
    );

    const totals = tiles.reduce((t, r) => {
      t.planned += r.planned_count || 0;
      t.actual += r.actual_count || 0;
      t.overdue += r.overdue || 0;
      return t;
    }, { planned: 0, actual: 0, overdue: 0 });

    const recent = await q(
      `SELECT a.action, a.detail, a.created_at, actor.name AS actor_name
       FROM activity_log a LEFT JOIN users actor ON actor.id = a.user_id
       ORDER BY a.id DESC LIMIT 8`
    );

    res.render('dash-admin', {
      title: 'Dashboard',
      tiles, totals, ws, we,
      weekNumber: weekNumberOf(ws),
      recent, labels: ACTION_LABELS
    });
  } catch (err) {
    next(err);
  }
});

/** Doer's own full score history. */
router.get('/my/scores', requireRole('doer', 'manager'), async (req, res, next) => {
  try {
    const scores = await q(
      `SELECT week_start, week_end, week_number, planned_count, actual_count, score, rating
       FROM weekly_scores WHERE doer_id = ? ORDER BY week_start DESC LIMIT 26`,
      [req.user.id]
    );
    res.render('my-scores', { title: 'My scores', scores });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
