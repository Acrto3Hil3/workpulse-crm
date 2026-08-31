'use strict';
// Email is optional: it turns on when SMTP_HOST is set in .env.
// On Hostinger, an email account from hPanel works directly:
//   SMTP_HOST=smtp.hostinger.com  SMTP_PORT=465  SMTP_USER=crm@your-domain  SMTP_PASS=...
// Special value SMTP_HOST=json sends nothing and prints mails to the log (testing).

const nodemailer = require('nodemailer');

let transport = null;

function isEnabled() {
  return Boolean(process.env.SMTP_HOST);
}

function getTransport() {
  if (!isEnabled()) return null;
  if (!transport) {
    if (process.env.SMTP_HOST === 'json') {
      transport = nodemailer.createTransport({ jsonTransport: true });
    } else {
      const port = Number(process.env.SMTP_PORT || 587);
      transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined
      });
    }
  }
  return transport;
}

async function sendMail(to, subject, text) {
  const t = getTransport();
  if (!t || !to) return false;
  const info = await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'crm@localhost',
    to, subject, text
  });
  if (process.env.SMTP_HOST === 'json') {
    console.log('[mail:test-mode]', subject, '->', to);
  }
  return true;
}

module.exports = { isEnabled, sendMail };
