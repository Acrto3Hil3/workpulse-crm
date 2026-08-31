'use strict';
const { q } = require('./db');

/** Fire-and-forget audit trail. Never breaks the main action if logging fails. */
async function logActivity(actorId, action, detail, subjectUserId) {
  try {
    await q(
      'INSERT INTO activity_log (user_id, action, detail, subject_user_id) VALUES (?, ?, ?, ?)',
      [actorId || null, action, String(detail || '').slice(0, 300) || null, subjectUserId || null]
    );
  } catch (err) {
    console.error('[activity]', err.message);
  }
}

const ACTION_LABELS = {
  task_assigned: '📌 assigned a task',
  task_completed: '✅ completed a task',
  task_revised: '📅 moved a deadline',
  task_reopened: '↩️ reopened a task',
  task_deleted: '🗑️ deleted a task',
  entry_done: '✅ did routine work',
  entry_undone: '↩️ reset a routine entry',
  user_added: '👤 added a person',
  item_added: '🔁 added a routine item'
};

module.exports = { logActivity, ACTION_LABELS };
