'use strict';
const { one } = require('./db');

/** Loads the logged-in user onto req.user (and hides deactivated accounts). */
async function attachUser(req, res, next) {
  if (!req.session || !req.session.userId) return next();
  try {
    const user = await one(
      'SELECT id, name, phone, email, role, active FROM users WHERE id = ?',
      [req.session.userId]
    );
    if (user && user.active) req.user = user;
    else req.session.destroy(() => {});
    next();
  } catch (err) {
    next(err);
  }
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

/**
 * requireRole('manager') allows managers AND owners.
 * requireRole('owner') is owner-only. Doer routes list 'doer' explicitly.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.role === 'owner' || roles.includes(req.user.role)) return next();
    flash(req, 'error', 'You do not have permission for that.');
    return res.redirect('/');
  };
}

function flash(req, type, msg) {
  if (req.session) req.session.flash = { type, msg };
}

/** Where to send the user after a POST: back to the page the form was on. */
function backTo(req, fallback = '/') {
  const ref = req.get('referer');
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.host === req.get('host')) return u.pathname + u.search;
    } catch (e) { /* ignore bad referer */ }
  }
  return fallback;
}

// --- tiny in-memory login rate limiter (per IP, no extra dependency) ---
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRIES = 20;

function loginLimiter(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { n: 0, resetAt: now + WINDOW_MS };
    attempts.set(ip, rec);
  }
  rec.n += 1;
  if (attempts.size > 5000) { // keep the map bounded
    for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
  }
  if (rec.n > MAX_TRIES) {
    return res.status(429).send('Too many login attempts. Please wait 15 minutes and try again.');
  }
  next();
}

function clearLoginAttempts(req) {
  attempts.delete(req.ip || 'unknown');
}

module.exports = { attachUser, requireLogin, requireRole, flash, backTo, loginLimiter, clearLoginAttempts };
