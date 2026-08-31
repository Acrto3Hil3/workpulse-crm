'use strict';
// The scoring engine — the same formula the Google Sheets MIS used:
//   score = min(0, max(-100, (actual / planned - 1) * 100))
// 100% completion -> 0.  Half done -> -50.  Floor -100.  No bonus for early work.
// Rating bands come from score_thresholds (configurable in Settings, not hardcoded).

const { q, sql } = require('./db');
const {
  fmt, addDaysStr, weekStartOf, weekNumberOf,
  currentWeekBounds, previousWeekBounds
} = require('./dates');

async function getThresholds() {
  const rows = await q('SELECT rating, min_score FROM score_thresholds');
  // Evaluate best rating first: highest min_score wins.
  return rows
    .map(r => ({ rating: r.rating, min: Number(r.min_score) }))
    .sort((a, b) => b.min - a.min);
}

function ratingFor(score, thresholds) {
  for (const t of thresholds) {
    if (score >= t.min) return t.rating;
  }
  return 'red';
}

function computeScore(planned, actual) {
  if (planned <= 0) return 0; // nothing planned -> no shortfall
  return Math.min(0, Math.max(-100, (actual / planned - 1) * 100));
}

/**
 * Compute (or recompute) the score for every active doer for the week that
 * starts on weekStart ('YYYY-MM-DD', a Sunday). Idempotent upsert.
 */
async function computeWeek(weekStart) {
  const ws = fmt(weekStartOf(weekStart)); // normalise to the Sunday
  const we = addDaysStr(ws, 6);
  const weekNumber = weekNumberOf(ws);
  const thresholds = await getThresholds();

  const doers = await q("SELECT id FROM users WHERE role = 'doer' AND active = TRUE");

  for (const doer of doers) {
    // One-off delegations due this week (due_date = current effective deadline).
    const [{ c: plannedD }] = await q(
      'SELECT COUNT(*) c FROM delegations WHERE doer_id = ? AND due_date BETWEEN ? AND ?',
      [doer.id, ws, we]
    );
    const [{ c: actualD }] = await q(
      `SELECT COUNT(*) c FROM delegations
       WHERE doer_id = ? AND due_date BETWEEN ? AND ?
         AND status = 'completed' AND (completed_at IS NULL OR completed_at <= ?)`,
      [doer.id, ws, we, we]
    );

    // Recurring (FMS + checklist) entries planned this week.
    const [{ c: plannedR }] = await q(
      `SELECT COUNT(*) c FROM recurring_entries e
       JOIN recurring_items i ON i.id = e.recurring_item_id
       WHERE i.doer_id = ? AND e.planned_date BETWEEN ? AND ?`,
      [doer.id, ws, we]
    );
    const [{ c: actualR }] = await q(
      `SELECT COUNT(*) c FROM recurring_entries e
       JOIN recurring_items i ON i.id = e.recurring_item_id
       WHERE i.doer_id = ? AND e.planned_date BETWEEN ? AND ?
         AND e.actual_date IS NOT NULL AND e.actual_date <= ?`,
      [doer.id, ws, we, we]
    );

    const planned = plannedD + plannedR;
    const actual = actualD + actualR;
    const score = Math.round(computeScore(planned, actual) * 100) / 100;
    const rating = ratingFor(score, thresholds);

    await q(
      `INSERT INTO weekly_scores
         (doer_id, week_number, week_start, week_end, planned_count, actual_count, score, rating, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ${sql.upsert('doer_id, week_start', ['week_number', 'week_end', 'planned_count', 'actual_count', 'score', 'rating', 'computed_at'])}`,
      [doer.id, weekNumber, ws, we, planned, actual, score, rating]
    );
  }
  return { weekStart: ws, weekEnd: we, doers: doers.length };
}

/** Refresh the current week (live view) and the previous week (final numbers). */
async function computeCurrentAndPrevious() {
  const prev = previousWeekBounds();
  const cur = currentWeekBounds();
  await computeWeek(prev.ws);
  await computeWeek(cur.ws);
  return { previous: prev.ws, current: cur.ws };
}

module.exports = { computeWeek, computeCurrentAndPrevious, computeScore, ratingFor, getThresholds };
