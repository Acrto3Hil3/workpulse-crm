'use strict';
// Database layer. One setting picks the database:
//
//   DATABASE_URL=postgres://user:pass@host/db     -> PostgreSQL (Neon, Supabase, any Postgres)
//   DATABASE_URL=mysql://user:pass@host:port/db   -> MySQL / MariaDB (TiDB Cloud, Hostinger, Aiven)
//   (no DATABASE_URL)                             -> MySQL using the DB_HOST/DB_USER/... variables
//
// Cloud hosts get TLS automatically. The rest of the app only ever calls
// q / one / exec / insert and the `sql` helpers below, so it never has to know
// which engine is underneath.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

function parseConfig() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const u = new URL(url);
    const dialect = /^postgres/i.test(u.protocol) ? 'pg' : 'mysql';
    const host = u.hostname;
    const isLocal = ['localhost', '127.0.0.1', '::1'].includes(host);
    const sslmode = u.searchParams.get('sslmode') || u.searchParams.get('ssl');
    const wantSsl = sslmode ? !['disable', 'false', '0'].includes(sslmode) : !isLocal;
    return {
      dialect,
      host,
      port: Number(u.port) || (dialect === 'pg' ? 5432 : 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
      // Encrypted by default for cloud hosts; set DB_SSL_VERIFY=true to also verify the certificate.
      ssl: wantSsl ? { rejectUnauthorized: process.env.DB_SSL_VERIFY === 'true' } : undefined
    };
  }
  return {
    dialect: 'mysql',
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'workpulse',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_VERIFY === 'true' } : undefined
  };
}

const dbConfig = parseConfig();
const dialect = dbConfig.dialect;
const POOL_SIZE = Number(process.env.DB_POOL || 10);

let pool;
if (dialect === 'pg') {
  const pg = require('pg');
  // Keep dates as plain strings and counts as numbers — same shapes MySQL gives us.
  pg.types.setTypeParser(1082, v => v);                 // DATE      -> 'YYYY-MM-DD'
  pg.types.setTypeParser(1114, v => v.slice(0, 19));    // TIMESTAMP -> 'YYYY-MM-DD HH:MM:SS'
  pg.types.setTypeParser(20, v => parseInt(v, 10));     // BIGINT (COUNT/SUM) -> number
  pool = new pg.Pool({
    host: dbConfig.host, port: dbConfig.port, user: dbConfig.user,
    password: dbConfig.password, database: dbConfig.database, ssl: dbConfig.ssl,
    max: POOL_SIZE, idleTimeoutMillis: 30000
  });
  pool.on('error', err => console.error('[db] idle client error', err.message));
} else {
  const mysql = require('mysql2/promise');
  pool = mysql.createPool({
    host: dbConfig.host, port: dbConfig.port, user: dbConfig.user,
    password: dbConfig.password, database: dbConfig.database, ssl: dbConfig.ssl,
    charset: 'utf8mb4',
    dateStrings: true,
    waitForConnections: true,
    connectionLimit: POOL_SIZE,
    queueLimit: 0,
    connectTimeout: 20000,
    // Cloud MySQL (TiDB Cloud, Aiven) closes idle connections server-side —
    // TiDB's public endpoint after ~340s. Recycle ours well before that, so the
    // pool never hands out a connection the server has already dropped.
    maxIdle: 2,
    idleTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  });
}

/** Connection-level hiccups (a dropped cloud connection, a serverless cold start). */
function isTransient(err) {
  const code = String(err && err.code || '');
  if (['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED',
       'ENOTFOUND', 'EAI_AGAIN', '08006', '08003', '57P01'].includes(code)) return true;
  if (err && err.fatal) return true;
  return /connection lost|server closed|socket hang up|terminating connection/i.test(String(err && err.message));
}

/** Runs a query, retrying once if the connection (not the SQL) was the problem. */
async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isTransient(err)) throw err;
    console.warn('[db] connection hiccup, retrying once:', err.code || err.message);
    await new Promise(r => setTimeout(r, 300));
    return fn();
  }
}

/** '?' placeholders -> '$1, $2, ...' for Postgres. */
function prepare(sqlText) {
  if (dialect !== 'pg') return sqlText;
  let i = 0;
  return sqlText.replace(/\?/g, () => `$${++i}`);
}

/** SELECT: returns rows. */
async function q(sqlText, params = []) {
  return run(async () => {
    if (dialect === 'pg') return (await pool.query(prepare(sqlText), params)).rows;
    const [rows] = await pool.query(sqlText, params);
    return rows;
  });
}

async function one(sqlText, params = []) {
  const rows = await q(sqlText, params);
  return rows[0] || null;
}

/** INSERT/UPDATE/DELETE: returns { affectedRows }. */
async function exec(sqlText, params = []) {
  return run(async () => {
    if (dialect === 'pg') return { affectedRows: (await pool.query(prepare(sqlText), params)).rowCount };
    const [r] = await pool.query(sqlText, params);
    return { affectedRows: r.affectedRows };
  });
}

/** INSERT that returns the new row id. */
async function insert(sqlText, params = []) {
  return run(async () => {
    if (dialect === 'pg') return (await pool.query(prepare(sqlText) + ' RETURNING id', params)).rows[0].id;
    const [r] = await pool.query(sqlText, params);
    return r.insertId;
  });
}

/** The handful of statements that differ between engines. */
const sql = {
  // `${sql.insertIgnore} t (a, b) VALUES (?, ?) ${sql.ignoreSuffix}` — skip duplicates silently
  insertIgnore: dialect === 'pg' ? 'INSERT INTO' : 'INSERT IGNORE INTO',
  ignoreSuffix: dialect === 'pg' ? 'ON CONFLICT DO NOTHING' : '',
  // Upsert on a unique key: sql.upsert('doer_id, week_start', ['score', 'rating'])
  upsert: (conflictCols, updateCols) => dialect === 'pg'
    ? `ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`
    : `ON DUPLICATE KEY UPDATE ${updateCols.map(c => `${c} = VALUES(${c})`).join(', ')}`
};

/**
 * TiDB allocates auto-increment IDs in per-node batches, so ids (and therefore
 * task numbers like T-0001) can jump by 30000 after the serverless instance
 * restarts. AUTO_ID_CACHE 1 switches a table to continuous allocation — but TiDB
 * only accepts it at CREATE TABLE time ("Can't Alter AUTO_ID_CACHE between 1 and
 * non-1"), so it is injected into the schema before the tables are created.
 * Plain MySQL/MariaDB never sees this clause.
 */
function tiDBSchema(schemaText) {
  return schemaText.replace(/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/g,
    'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 AUTO_ID_CACHE 1;');
}

/**
 * Creates all tables if missing and seeds thresholds + the first owner account.
 * Runs on every boot; everything is idempotent.
 */
async function ensureSchema() {
  const file = dialect === 'pg' ? 'schema.pg.sql' : 'schema.sql';
  const schema = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

  if (dialect === 'pg') {
    const client = await pool.connect();
    try {
      await client.query(schema);
      await client.query(
        "INSERT INTO score_thresholds (rating, min_score) VALUES ('green',-10), ('yellow',-30), ('red',-100) ON CONFLICT (rating) DO NOTHING"
      );
    } finally {
      client.release();
    }
  } else {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({
      host: dbConfig.host, port: dbConfig.port, user: dbConfig.user,
      password: dbConfig.password, database: dbConfig.database, ssl: dbConfig.ssl,
      multipleStatements: true
    });
    try {
      const [[ver]] = await conn.query('SELECT VERSION() AS v');
      const isTiDB = /tidb/i.test(String(ver.v));
      await conn.query(isTiDB ? tiDBSchema(schema) : schema);
      await conn.query(
        "INSERT IGNORE INTO score_thresholds (rating, min_score) VALUES ('green',-10), ('yellow',-30), ('red',-100)"
      );
      if (isTiDB) console.log(`[db] TiDB detected (${ver.v}) — continuous ID allocation enabled`);
    } finally {
      await conn.end();
    }
  }

  const { c } = await one('SELECT COUNT(*) c FROM users');
  if (Number(c) === 0) {
    const name = process.env.ADMIN_NAME || 'Owner';
    const email = process.env.ADMIN_EMAIL || 'owner@example.com';
    const password = process.env.ADMIN_PASSWORD || 'changeme123';
    await exec(
      "INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, 'owner', ?)",
      [name, email, bcrypt.hashSync(password, 10)]
    );
    console.log(`[setup] Created first owner account: ${email} (password from ADMIN_PASSWORD env)`);
    if (password === 'changeme123') {
      console.warn('[setup] WARNING: using the default admin password. Set ADMIN_PASSWORD in .env and change it after first login.');
    }
  }
  console.log(`[db] connected to ${dialect === 'pg' ? 'PostgreSQL' : 'MySQL'} at ${dbConfig.host}${dbConfig.ssl ? ' (TLS)' : ''}`);
}

module.exports = { pool, dialect, dbConfig, q, one, exec, insert, sql, ensureSchema };
