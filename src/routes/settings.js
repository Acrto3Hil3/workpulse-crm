'use strict';
const express = require('express');
const { requireRole, flash } = require('../auth');
const mailer = require('../mailer');
const whatsapp = require('../whatsapp');
const { sendDailyDigests, sendOwnerReport, sendWeeklySummary } = require('../reminders');

const router = express.Router();

const splitList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

router.get('/', requireRole('owner'), (req, res) => {
  res.render('settings', {
    title: 'Settings',
    mail: {
      enabled: mailer.isEnabled(),
      testMode: process.env.SMTP_HOST === 'json',
      from: process.env.SMTP_FROM || process.env.SMTP_USER || null
    },
    wa: {
      enabled: whatsapp.isEnabled(),
      testMode: whatsapp.isTestMode(),
      template: process.env.WHATSAPP_TEMPLATE || null
    },
    reports: {
      emails: splitList(process.env.REPORT_EMAIL),
      phones: splitList(process.env.REPORT_WHATSAPP)
    },
    cronInProcess: process.env.CRON_ENABLED === 'true',
    appTz: process.env.APP_TZ || 'server default',
    appUrl: process.env.APP_URL || null
  });
});

router.post('/test-email', requireRole('owner'), async (req, res) => {
  try {
    if (!mailer.isEnabled()) {
      flash(req, 'error', 'Email is not configured — set SMTP_HOST in .env first.');
      return res.redirect('/settings');
    }
    const to = splitList(process.env.REPORT_EMAIL)[0] || req.user.email || process.env.ADMIN_EMAIL;
    if (!to) {
      flash(req, 'error', 'No address to send to — set REPORT_EMAIL in .env or add an email to your account.');
      return res.redirect('/settings');
    }
    await mailer.sendMail(to, `Test email — ${res.locals.appName}`,
      'This is a test email from your CRM. If you are reading this, email reports will work.');
    flash(req, 'success', `Test email sent to ${to}.`);
  } catch (err) {
    console.error('[test-email]', err.message);
    flash(req, 'error', `Sending failed: ${err.message}`);
  }
  res.redirect('/settings');
});

router.post('/test-whatsapp', requireRole('owner'), async (req, res) => {
  try {
    if (!whatsapp.isEnabled()) {
      flash(req, 'error', 'WhatsApp is not configured — set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID in .env first.');
      return res.redirect('/settings');
    }
    const to = splitList(process.env.REPORT_WHATSAPP)[0] || req.user.phone;
    if (!to) {
      flash(req, 'error', 'No number to send to — set REPORT_WHATSAPP in .env or add a phone to your account.');
      return res.redirect('/settings');
    }
    const ok = await whatsapp.sendWhatsApp(to,
      `Test message from ${res.locals.appName}. If you are reading this, WhatsApp reports will work.`);
    flash(req, ok ? 'success' : 'error',
      ok ? `Test WhatsApp sent to ${whatsapp.normalizeNumber(to)}.` : 'WhatsApp send failed — check the server log.');
  } catch (err) {
    console.error('[test-whatsapp]', err.message);
    flash(req, 'error', `Sending failed: ${err.message}`);
  }
  res.redirect('/settings');
});

router.post('/send-digests', requireRole('owner'), async (req, res, next) => {
  try {
    const r = await sendDailyDigests();
    const n = r.emails + r.whatsapps;
    flash(req, n ? 'success' : 'error',
      n ? `Digests sent — ${r.emails} email(s), ${r.whatsapps} WhatsApp message(s).`
        : `No digests sent (${r.reason || 'nobody has pending work, or doers have no email/WhatsApp'}).`);
    res.redirect('/settings');
  } catch (err) { next(err); }
});

router.post('/send-report', requireRole('owner'), async (req, res, next) => {
  try {
    const r = await sendOwnerReport();
    const n = r.emails + r.whatsapps;
    flash(req, n ? 'success' : 'error',
      n ? `Overdue report sent — ${r.emails} email(s), ${r.whatsapps} WhatsApp message(s).`
        : `No report sent (${r.reason || 'no recipients configured'}).`);
    res.redirect('/settings');
  } catch (err) { next(err); }
});

router.post('/send-summary', requireRole('owner'), async (req, res, next) => {
  try {
    const r = await sendWeeklySummary();
    const n = r.emails + r.whatsapps;
    flash(req, n ? 'success' : 'error',
      n ? `Weekly summary sent — ${r.emails} email(s), ${r.whatsapps} WhatsApp message(s).`
        : `No summary sent (${r.reason || 'no recipients configured'}).`);
    res.redirect('/settings');
  } catch (err) { next(err); }
});

module.exports = router;
