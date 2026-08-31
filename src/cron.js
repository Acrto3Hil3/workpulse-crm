'use strict';
// Scheduled work. Two ways to run it:
//  1. In-process node-cron (CRON_ENABLED=true) — for a VPS / always-on Node process.
//  2. GET /cron/run?key=CRON_SECRET — for shared hosting: point a Hostinger cron job
//     (or any uptime pinger) at that URL hourly. Both call runAllJobs().

const cron = require('node-cron');
const { q, exec, sql } = require('./db');
const { computeCurrentAndPrevious } = require('./scoring');
const { sendDailyDigests, sendOwnerReport, sendWeeklySummary } = require('./reminders');
const {
  todayStr, weekBoundsOf, weekLabelOf, lastDayOfMonthStr, monthLabelOf, parseDate
} = require('./dates');

/**
 * Make sure every active recurring item has an entry for its current cycle.
 * daily  -> one entry per day        (label 2026-08-30, planned = that day)
 * weekly -> one entry per week       (label 2026-W35,  planned = Saturday of the week)
 * monthly-> one entry per month      (label 2026-08,   planned = last day of month)
 * INSERT IGNORE + a unique key keeps this idempotent however often it runs.
 */
async function generateRecurringEntries() {
  const items = await q('SELECT id, frequency FROM recurring_items WHERE active = TRUE');
  const today = todayStr();
  const { we } = weekBoundsOf(today);
  let created = 0;

  for (const item of items) {
    let label, planned;
    if (item.frequency === 'daily') {
      label = today; planned = today;
    } else if (item.frequency === 'monthly') {
      label = monthLabelOf(today); planned = lastDayOfMonthStr(today);
    } else {
      label = weekLabelOf(today); planned = we;
    }
    const res = await exec(
      `${sql.insertIgnore} recurring_entries (recurring_item_id, cycle_label, planned_date, status)
       VALUES (?, ?, ?, 'pending') ${sql.ignoreSuffix}`,
      [item.id, label, planned]
    );
    if (res.affectedRows) created += res.affectedRows;
  }
  return created;
}

/** Mark pending recurring entries whose planned date is past as 'missed' (still completable). */
async function flagMissedEntries() {
  await q(
    "UPDATE recurring_entries SET status = 'missed' WHERE status = 'pending' AND planned_date < ?",
    [todayStr()]
  );
}

async function runAllJobs() {
  const created = await generateRecurringEntries();
  await flagMissedEntries();
  const weeks = await computeCurrentAndPrevious();
  return { entriesCreated: created, ...weeks };
}

/**
 * Once-a-day work (safe to trigger via /cron/daily on shared hosting):
 * entries + scores + reminder emails; the Sunday summary goes out on Sundays.
 */
async function runDailyJobs() {
  const base = await runAllJobs();
  const digests = await sendDailyDigests();
  const report = await sendOwnerReport();
  let summary = { emails: 0, whatsapps: 0, reason: 'not sunday' };
  if (parseDate(todayStr()).getDay() === 0) summary = await sendWeeklySummary();
  return {
    ...base,
    digests: { emails: digests.emails, whatsapps: digests.whatsapps },
    ownerReport: { emails: report.emails, whatsapps: report.whatsapps },
    weeklySummary: { emails: summary.emails, whatsapps: summary.whatsapps }
  };
}

function startCron() {
  // 00:15 daily — generate the day's recurring entries, flag missed ones.
  cron.schedule('15 0 * * *', () => {
    generateRecurringEntries().then(flagMissedEntries).catch(err => console.error('[cron] generate failed', err));
  });
  // Hourly during working hours — refresh current + previous week scores (cheap; keeps the
  // dashboard live). Skipping the night lets a serverless database (Neon etc.) sleep.
  cron.schedule('0 6-22 * * *', () => {
    computeCurrentAndPrevious().catch(err => console.error('[cron] scoring failed', err));
  });
  // Sunday 00:30 — close out the week that just ended.
  cron.schedule('30 0 * * 0', () => {
    runAllJobs().catch(err => console.error('[cron] weekly close failed', err));
  });
  // 08:00 daily — reminders to doers (email/WhatsApp) + the overdue report to the boss.
  cron.schedule('0 8 * * *', () => {
    sendDailyDigests()
      .then(() => sendOwnerReport())
      .catch(err => console.error('[cron] digests/report failed', err));
  });
  // Sunday 08:30 — weekly score summary to managers + report recipients.
  cron.schedule('30 8 * * 0', () => {
    sendWeeklySummary().catch(err => console.error('[cron] summary failed', err));
  });
  console.log('[cron] in-process schedules started (daily 00:15 + 08:00, hourly, Sunday 00:30 + 08:30)');
}

module.exports = { generateRecurringEntries, flagMissedEntries, runAllJobs, runDailyJobs, startCron };
