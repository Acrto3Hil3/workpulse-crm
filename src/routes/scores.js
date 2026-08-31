'use strict';
const express = require('express');
const { q } = require('../db');
const { requireRole, flash, backTo } = require('../auth');
const { computeCurrentAndPrevious, computeWeek } = require('../scoring');
const { lastNWeekStarts, weekNumberOf } = require('../dates');

const router = express.Router();

// Score matrix: rows = doers, columns = last 12 weeks, red/yellow/green cells.
router.get('/', requireRole('manager'), async (req, res, next) => {
  try {
    const weekStarts = lastNWeekStarts(12);
    const doers = await q("SELECT id, name FROM users WHERE role = 'doer' AND active = TRUE ORDER BY name");
    const rows = await q(
      'SELECT doer_id, week_start, planned_count, actual_count, score, rating FROM weekly_scores WHERE week_start >= ?',
      [weekStarts[0]]
    );
    const byDoer = new Map();
    for (const r of rows) {
      if (!byDoer.has(r.doer_id)) byDoer.set(r.doer_id, {});
      byDoer.get(r.doer_id)[r.week_start] = r;
    }
    res.render('scores/index', {
      title: 'Scores',
      weekStarts,
      weekNumbers: weekStarts.map(weekNumberOf),
      doers,
      byDoer
    });
  } catch (err) { next(err); }
});

// Recompute button — refreshes current + previous week on demand.
router.post('/recompute', requireRole('manager'), async (req, res, next) => {
  try {
    await computeCurrentAndPrevious();
    flash(req, 'success', 'Scores refreshed for this week and last week.');
    res.redirect(backTo(req, '/scores'));
  } catch (err) { next(err); }
});

// Rebuild history further back (e.g. after importing old data).
router.post('/recompute-history', requireRole('owner'), async (req, res, next) => {
  try {
    const weeks = Math.min(52, Math.max(1, Number(req.body.weeks) || 12));
    for (const ws of lastNWeekStarts(weeks)) await computeWeek(ws);
    flash(req, 'success', `Recomputed the last ${weeks} weeks.`);
    res.redirect('/scores');
  } catch (err) { next(err); }
});

// CSV export — same shape the old system produced.
router.get('/export.csv', requireRole('manager'), async (req, res, next) => {
  try {
    const params = [];
    let where = '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { where += ' AND ws.week_start >= ?'; params.push(req.query.from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { where += ' AND ws.week_start <= ?'; params.push(req.query.to); }
    const rows = await q(
      `SELECT u.name, ws.week_number, ws.week_start, ws.week_end,
              ws.planned_count, ws.actual_count, ws.score, ws.rating
       FROM weekly_scores ws JOIN users u ON u.id = ws.doer_id
       WHERE 1=1 ${where}
       ORDER BY u.name, ws.week_start`,
      params
    );
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['doer,week_number,week_start,week_end,planned,actual,score,rating'];
    for (const r of rows) {
      lines.push([esc(r.name), r.week_number, r.week_start, r.week_end,
        r.planned_count, r.actual_count, r.score, r.rating].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="weekly-scores.csv"');
    res.send(lines.join('\r\n'));
  } catch (err) { next(err); }
});

// Rating bands (owner only): the one knob on the scoring system.
router.get('/thresholds', requireRole('owner'), async (req, res, next) => {
  try {
    const rows = await q('SELECT rating, min_score FROM score_thresholds');
    const th = Object.fromEntries(rows.map(r => [r.rating, Number(r.min_score)]));
    res.render('scores/thresholds', { title: 'Rating settings', th });
  } catch (err) { next(err); }
});

router.post('/thresholds', requireRole('owner'), async (req, res, next) => {
  try {
    const green = Number(req.body.green);
    const yellow = Number(req.body.yellow);
    const valid = [green, yellow].every(n => Number.isFinite(n) && n <= 0 && n >= -100);
    if (!valid || green <= yellow) {
      flash(req, 'error', 'Green must be higher than yellow, both between -100 and 0.');
      return res.redirect('/scores/thresholds');
    }
    await q("UPDATE score_thresholds SET min_score = ? WHERE rating = 'green'", [green]);
    await q("UPDATE score_thresholds SET min_score = ? WHERE rating = 'yellow'", [yellow]);
    await computeCurrentAndPrevious(); // re-rate current weeks with the new bands
    flash(req, 'success', 'Rating bands saved.');
    res.redirect('/scores/thresholds');
  } catch (err) { next(err); }
});

module.exports = router;
