'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { one } = require('../db');
const { flash, loginLimiter, clearLoginAttempts } = require('../auth');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Log in' });
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const identifier = String(req.body.identifier || '').trim();
    const password = String(req.body.password || '');
    if (!identifier || !password) {
      flash(req, 'error', 'Enter your phone/email and password.');
      return res.redirect('/login');
    }
    // Email match is case-insensitive on every engine (Postgres and TiDB compare
    // strings case-sensitively by default, so "Owner@Firm.com" must still work).
    const user = await one(
      'SELECT * FROM users WHERE (LOWER(email) = LOWER(?) OR phone = ?) AND active = TRUE',
      [identifier, identifier]
    );
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      flash(req, 'error', 'Wrong phone/email or password.');
      return res.redirect('/login');
    }
    clearLoginAttempts(req);
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.userId = user.id;
      res.redirect('/');
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
