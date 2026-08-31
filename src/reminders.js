'use strict';
// Reminders & reports, over two channels:
//   Email    — doers/managers with an email address (src/mailer.js, SMTP_*)
//   WhatsApp — doers/managers by phone number (src/whatsapp.js, WHATSAPP_*)
// Reports (the owner-facing summaries) go to the addresses in REPORT_EMAIL /
// REPORT_WHATSAPP (.env, comma-separated). If those are empty, they fall back
// to the email/phone of every active owner account.

const { q } = require('./db');
const mailer = require('./mailer');
const whatsapp = require('./whatsapp');
const { todayStr, currentWeekBounds, previousWeekBounds, weekNumberOf, fmtNice } = require('./dates');

const appName = () => process.env.APP_NAME || 'WorkPulse';
const appLink = () => (process.env.APP_URL ? `\nOpen the app: ${process.env.APP_URL}` : '');

const splitList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

/** Report recipients per channel, with owner-account fallback. */
async function reportRecipients() {
  let emails = splitList(process.env.REPORT_EMAIL);
  let phones = splitList(process.env.REPORT_WHATSAPP);
  if (!emails.length || !phones.length) {
    const owners = await q("SELECT email, phone FROM users WHERE role = 'owner' AND active = TRUE");
    if (!emails.length) emails = owners.map(o => o.email).filter(Boolean);
    if (!phones.length) phones = owners.map(o => o.phone).filter(Boolean);
  }
  return { emails: [...new Set(emails)], phones: [...new Set(phones)] };
}

async function deliver(text, subject, emails, phones) {
  let sentEmails = 0, sentWhatsapps = 0;
  if (mailer.isEnabled()) {
    for (const to of emails) {
      if (await mailer.sendMail(to, subject, text)) sentEmails++;
    }
  }
  if (whatsapp.isEnabled()) {
    for (const to of phones) {
      if (await whatsapp.sendWhatsApp(to, text)) sentWhatsapps++;
    }
  }
  return { sentEmails, sentWhatsapps };
}

/** What a doer still owes right now. Null when they're fully caught up. */
async function pendingWorkFor(doerId) {
  const today = todayStr();
  const { we } = currentWeekBounds();
  const overdue = await q(
    `SELECT description, due_date FROM delegations
     WHERE doer_id = ? AND status <> 'completed' AND due_date < ? ORDER BY due_date LIMIT 10`,
    [doerId, today]
  );
  const dueToday = await q(
    `SELECT description FROM delegations
     WHERE doer_id = ? AND status <> 'completed' AND due_date = ? LIMIT 10`,
    [doerId, today]
  );
  const routine = await q(
    `SELECT i.name, e.planned_date FROM recurring_entries e
     JOIN recurring_items i ON i.id = e.recurring_item_id
     WHERE i.doer_id = ? AND i.active = TRUE AND e.actual_date IS NULL AND e.planned_date <= ?
     ORDER BY e.planned_date LIMIT 10`,
    [doerId, we]
  );
  if (!overdue.length && !dueToday.length && !routine.length) return null;
  return { overdue, dueToday, routine };
}

function digestText(firstName, work) {
  const lines = [`Namaste ${firstName},`, ''];
  if (work.overdue.length) {
    lines.push('OVERDUE — do these first:');
    work.overdue.forEach(t => lines.push(`• ${t.description} (was due ${fmtNice(t.due_date)})`));
    lines.push('');
  }
  if (work.dueToday.length) {
    lines.push('DUE TODAY:');
    work.dueToday.forEach(t => lines.push(`• ${t.description}`));
    lines.push('');
  }
  if (work.routine.length) {
    lines.push('ROUTINE WORK PENDING:');
    work.routine.forEach(r => lines.push(`• ${r.name} (by ${fmtNice(r.planned_date)})`));
    lines.push('');
  }
  lines.push(appLink());
  lines.push(`— ${appName()}`);
  return lines.join('\n');
}

/** Morning digest to every doer with pending work — email and/or WhatsApp, whatever they have. */
async function sendDailyDigests() {
  if (!mailer.isEnabled() && !whatsapp.isEnabled()) {
    return { emails: 0, whatsapps: 0, reason: 'no channel configured' };
  }
  const doers = await q("SELECT id, name, email, phone FROM users WHERE role = 'doer' AND active = TRUE");
  let emails = 0, whatsapps = 0;
  for (const doer of doers) {
    const work = await pendingWorkFor(doer.id);
    if (!work) continue;
    const text = digestText(doer.name.split(' ')[0], work);
    const nOver = work.overdue.length;
    const subject = nOver
      ? `${nOver} overdue task${nOver > 1 ? 's' : ''} — ${appName()}`
      : `Your tasks today — ${appName()}`;
    const r = await deliver(text, subject, doer.email ? [doer.email] : [], doer.phone ? [doer.phone] : []);
    emails += r.sentEmails;
    whatsapps += r.sentWhatsapps;
  }
  return { emails, whatsapps };
}

/** Morning report to the boss: who is overdue, at a glance. Skipped when nobody is. */
async function sendOwnerReport() {
  if (!mailer.isEnabled() && !whatsapp.isEnabled()) {
    return { emails: 0, whatsapps: 0, reason: 'no channel configured' };
  }
  const today = todayStr();
  const rows = await q(
    `SELECT u.name,
            SUM(CASE WHEN d.due_date < ? THEN 1 ELSE 0 END) AS overdue,
            COUNT(*) AS open_tasks
     FROM delegations d JOIN users u ON u.id = d.doer_id
     WHERE d.status <> 'completed' AND u.active = TRUE
     GROUP BY u.id, u.name
     HAVING SUM(CASE WHEN d.due_date < ? THEN 1 ELSE 0 END) > 0
     ORDER BY overdue DESC, u.name`,
    [today, today]
  );
  if (!rows.length) return { emails: 0, whatsapps: 0, reason: 'nothing overdue' };

  const total = rows.reduce((n, r) => n + Number(r.overdue), 0);
  const lines = [
    `Overdue report — ${fmtNice(today)}:`,
    '',
    ...rows.map(r => `• ${r.name}: ${r.overdue} overdue (${r.open_tasks} open in total)`),
    appLink(),
    `— ${appName()}`
  ];
  const { emails: to, phones } = await reportRecipients();
  return normalizeDeliver(await deliver(
    lines.join('\n'),
    `${total} overdue task${total > 1 ? 's' : ''} in the team — ${appName()}`,
    to, phones
  ));
}

/** Sunday summary: last week's scores to managers (email) and report recipients (both channels). */
async function sendWeeklySummary() {
  if (!mailer.isEnabled() && !whatsapp.isEnabled()) {
    return { emails: 0, whatsapps: 0, reason: 'no channel configured' };
  }
  const { ws } = previousWeekBounds();
  const rows = await q(
    `SELECT u.name, ws.planned_count, ws.actual_count, ws.score, ws.rating
     FROM weekly_scores ws JOIN users u ON u.id = ws.doer_id
     WHERE ws.week_start = ? ORDER BY ws.score ASC, u.name`,
    [ws]
  );
  if (!rows.length) return { emails: 0, whatsapps: 0, reason: 'no scores for last week' };

  const text = [
    `Team scores for Week ${weekNumberOf(ws)} (starting ${fmtNice(ws)}):`,
    '',
    ...rows.map(r =>
      `${r.rating.toUpperCase().padEnd(7)} ${r.name.padEnd(22)} done ${r.actual_count}/${r.planned_count}   score ${Math.round(Number(r.score))}`
    ),
    '',
    '0 = everything done, -100 = nothing done.',
    appLink(),
    `— ${appName()}`
  ].join('\n');
  const subject = `Weekly team scores — Week ${weekNumberOf(ws)} — ${appName()}`;

  const managers = await q(
    "SELECT email FROM users WHERE role IN ('owner','manager') AND active = TRUE AND email IS NOT NULL"
  );
  const { emails: repEmails, phones } = await reportRecipients();
  const emails = [...new Set([...managers.map(m => m.email), ...repEmails])];
  return normalizeDeliver(await deliver(text, subject, emails, phones));
}

function normalizeDeliver(r) {
  return { emails: r.sentEmails, whatsapps: r.sentWhatsapps };
}

module.exports = { sendDailyDigests, sendOwnerReport, sendWeeklySummary };
