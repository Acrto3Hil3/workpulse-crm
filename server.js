'use strict';
require('dotenv').config();
// Set the business timezone before any Date is created (week boundaries depend on it).
if (process.env.APP_TZ) process.env.TZ = process.env.APP_TZ;

const path = require('path');
const express = require('express');
const session = require('express-session');

const db = require('./src/db');
const { dbConfig, ensureSchema } = db;
const { attachUser } = require('./src/auth');
const { startCron, runAllJobs, runDailyJobs } = require('./src/cron');
const dates = require('./src/dates');

const PORT = Number(process.env.PORT || 3000);
const APP_NAME = process.env.APP_NAME || 'WorkPulse';

const STATUS_LABELS = { assigned: 'Assigned', completed: 'Completed', week_shifted: 'Week shifted' };
const STATUS_CLASSES = { assigned: 'gray', completed: 'green', week_shifted: 'yellow' };

const escapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Two-tone wordmark for WorkPulse; a plain (escaped) name when white-labelled via APP_NAME.
const BRAND_HTML = APP_NAME === 'WorkPulse'
  ? 'Work<span class="brand-accent">Pulse</span>'
  : escapeHtml(APP_NAME);
const TAGLINE = process.env.APP_TAGLINE || (APP_NAME === 'WorkPulse' ? 'Every task, tracked.' : '');

async function main() {
  await ensureSchema();

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'src', 'views'));
  app.set('trust proxy', 1); // behind Hostinger / Nginx proxy
  app.disable('x-powered-by');

  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

  // Sessions live in the database so they survive restarts and work under PM2 cluster mode.
  let store;
  if (db.dialect === 'pg') {
    const PgStore = require('connect-pg-simple')(session);
    store = new PgStore({ pool: db.pool, createTableIfMissing: true, pruneSessionInterval: 15 * 60 });
  } else {
    const MySQLStore = require('express-mysql-session')(session);
    // Hand the store our own pool rather than letting it build one: its option
    // whitelist silently drops `ssl`, and cloud MySQL (TiDB Cloud) rejects any
    // plaintext connection outright. Sharing the pool also halves connection use.
    store = new MySQLStore(
      { createDatabaseTable: true, clearExpired: true, checkExpirationInterval: 15 * 60 * 1000 },
      db.pool
    );
  }

  // Brand/helper locals first, so an error thrown anywhere below — including in
  // the session store — still renders a proper error page.
  app.use(setBaseLocals);

  app.use(session({
    name: 'crm.sid',
    store,
    secret: process.env.SESSION_SECRET || 'set-a-real-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.SECURE_COOKIES === 'true', // turn on once HTTPS is set up
      maxAge: 30 * 24 * 60 * 60 * 1000
    }
  }));

  app.use(attachUser);

  // Locals every view can use. Note: setBaseLocals runs before the session
  // middleware (above) so the error page can still render if that fails.
  app.use((req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.flash = req.session ? req.session.flash : null;
    if (req.session) delete req.session.flash;
    next();
  });

  function setBaseLocals(req, res, next) {
    res.locals.appName = APP_NAME;
    res.locals.brandHtml = BRAND_HTML;
    res.locals.tagline = TAGLINE;
    res.locals.user = null;
    res.locals.path = req.path;
    res.locals.flash = null;
    res.locals.h = {
      fmtNice: dates.fmtNice,
      fmtFull: dates.fmtFull,
      today: dates.todayStr(),
      score: s => String(Math.round(Number(s))),
      statusLabel: s => STATUS_LABELS[s] || s,
      statusClass: s => STATUS_CLASSES[s] || 'gray',
      weekNum: ws => dates.weekNumberOf(ws),
      // '2026-08-30 14:05:12' -> '30 Aug, 14:05'
      fmtDT: s => {
        if (!s) return '—';
        const [d, t] = String(s).split(' ');
        return `${dates.fmtNice(d)}, ${(t || '').slice(0, 5)}`;
      },
      // WhatsApp deep link with a prefilled message; null when no phone.
      wa: (phone, text) => {
        if (!phone) return null;
        let p = String(phone).replace(/\D/g, '');
        if (p.length === 10) p = (process.env.WHATSAPP_CC || '91') + p;
        return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
      }
    };
    next();
  }

  // Routes
  app.use('/', require('./src/routes/auth'));
  app.use('/', require('./src/routes/dashboard'));
  app.use('/doers', require('./src/routes/doers'));
  app.use('/delegations', require('./src/routes/delegations'));
  app.use('/recurring', require('./src/routes/recurring'));
  app.use('/scores', require('./src/routes/scores'));
  app.use('/activity', require('./src/routes/activity'));
  app.use('/settings', require('./src/routes/settings'));

  app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // PWA manifest (dynamic so it carries APP_NAME).
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').json({
      name: APP_NAME,
      short_name: APP_NAME.length > 12 ? APP_NAME.slice(0, 12) : APP_NAME,
      start_url: '/',
      display: 'standalone',
      background_color: '#f2f4f7',
      theme_color: '#2456d6',
      description: TAGLINE || APP_NAME,
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    });
  });

  // For Hostinger cron / uptime pingers on shared hosting.
  // /cron/run   — hourly: entries + scores (no emails)
  // /cron/daily — once a day at ~08:00: same + reminder emails (+ Sunday summary)
  const cronGuard = (req, res) => {
    if (!process.env.CRON_SECRET || req.query.key !== process.env.CRON_SECRET) {
      res.status(403).json({ ok: false, error: 'bad key' });
      return false;
    }
    return true;
  };
  app.get('/cron/run', async (req, res) => {
    if (!cronGuard(req, res)) return;
    try {
      res.json({ ok: true, ...(await runAllJobs()) });
    } catch (err) {
      console.error('[cron/run]', err);
      res.status(500).json({ ok: false });
    }
  });
  app.get('/cron/daily', async (req, res) => {
    if (!cronGuard(req, res)) return;
    try {
      res.json({ ok: true, ...(await runDailyJobs()) });
    } catch (err) {
      console.error('[cron/daily]', err);
      res.status(500).json({ ok: false });
    }
  });

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', code: 404, message: 'That page does not exist.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(new Date().toISOString(), err);
    res.status(500).render('error', { title: 'Error', code: 500, message: 'Something went wrong. Please try again.' });
  });

  // First boot on an empty database: make sure recurring entries + this week's scores exist.
  runAllJobs().catch(err => console.error('[boot jobs]', err.message));

  if (process.env.CRON_ENABLED === 'true') startCron();

  app.listen(PORT, () => console.log(`${APP_NAME} running on port ${PORT}`));
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
