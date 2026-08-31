'use strict';
const express = require('express');
const { q } = require('../db');
const { requireRole } = require('../auth');
const { ACTION_LABELS } = require('../activity');

const router = express.Router();
const PAGE_SIZE = 40;

router.get('/', requireRole('manager'), async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const [{ c: total }] = await q('SELECT COUNT(*) c FROM activity_log');
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rows = await q(
      `SELECT a.*, actor.name AS actor_name, subj.name AS subject_name
       FROM activity_log a
       LEFT JOIN users actor ON actor.id = a.user_id
       LEFT JOIN users subj ON subj.id = a.subject_user_id
       ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      [PAGE_SIZE, (page - 1) * PAGE_SIZE]
    );
    res.render('activity', { title: 'Activity', rows, page, pages, total, labels: ACTION_LABELS });
  } catch (err) { next(err); }
});

module.exports = router;
