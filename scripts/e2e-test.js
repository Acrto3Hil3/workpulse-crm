#!/usr/bin/env node
'use strict';
/**
 * Full browser end-to-end test of the CRM, exactly as a user would click it.
 * Run against a FRESH database instance so first-boot setup is tested too:
 *
 *   E2E_BASE=http://localhost:3100 \
 *   E2E_ADMIN_EMAIL=owner@e2e.local E2E_ADMIN_PASSWORD=test1234 \
 *   node scripts/e2e-test.js
 *
 * Requires the dev dependency:  npm i -D playwright-core
 * Optional env: E2E_CHROMIUM (path to a chromium binary), E2E_APP_LOG (server
 * log file, to verify test-mode email/WhatsApp dispatch), E2E_CRON_SECRET.
 * Writes e2e-report.md and e2e-screenshots/ into the current directory.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const BASE = process.env.E2E_BASE || 'http://localhost:3100';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'owner@e2e.local';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'test1234';
const CRON_SECRET = process.env.E2E_CRON_SECRET || 'local-cron-secret';
const SHOT_DIR = 'e2e-screenshots';

const results = [];
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

fs.mkdirSync(SHOT_DIR, { recursive: true });

async function main() {
  const launchOpts = {};
  if (process.env.E2E_CHROMIUM) launchOpts.executablePath = process.env.E2E_CHROMIUM;
  const browser = await chromium.launch(launchOpts);
  const ownerCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
  const doerCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
  const owner = await ownerCtx.newPage();
  const doer = await doerCtx.newPage();

  const shot = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) }).catch(() => {});
  const flashOf = async page => {
    try { return (await page.locator('.flash').textContent({ timeout: 4000 })) || ''; }
    catch { return ''; }
  };
  const html = page => page.content();

  let lastPage = owner;
  async function step(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  PASS  ${name}`);
    } catch (e) {
      const note = String(e.message || e).split('\n')[0].slice(0, 180);
      results.push({ name, ok: false, note });
      console.log(`  FAIL  ${name} — ${note}`);
      await shot(lastPage, `FAIL-${results.length}`);
    }
  }

  async function login(page, identifier, password) {
    await page.goto(`${BASE}/login`, { waitUntil: 'load' });
    await page.fill('input[name=identifier]', identifier);
    await page.fill('input[name=password]', password);
    await page.click('button[type=submit]');
    await page.waitForLoadState('load');
  }

  async function submitAndWait(page, clickTarget) {
    await clickTarget.click();
    await page.waitForLoadState('load');
  }

  // ---------------- the suite ----------------

  await step('Health endpoint responds', async () => {
    const res = await owner.request.get(`${BASE}/health`);
    assert(res.ok(), `status ${res.status()}`);
    assert((await res.json()).ok === true, 'health.ok !== true');
  });

  await step('Login rejects a wrong password', async () => {
    lastPage = owner;
    await login(owner, ADMIN_EMAIL, 'wrong-password');
    assert(owner.url().includes('/login'), 'should stay on /login');
    assert((await flashOf(owner)).includes('Wrong'), 'no error flash shown');
  });

  await step('Email login is case-insensitive (Postgres/TiDB compare case-sensitively)', async () => {
    const mixed = ADMIN_EMAIL.replace(/^./, c => c.toUpperCase()).replace(/@(.)/, (m, c) => '@' + c.toUpperCase());
    await login(owner, mixed, ADMIN_PASSWORD);
    assert(!owner.url().includes('/login'), `"${mixed}" was rejected`);
    await submitAndWait(owner, owner.locator('.topbar form[action="/logout"] button'));
  });

  await step('Owner logs in; fresh install shows empty dashboard', async () => {
    await login(owner, ADMIN_EMAIL, ADMIN_PASSWORD);
    assert(owner.url().replace(/\/$/, '') === BASE.replace(/\/$/, ''), `landed on ${owner.url()}`);
    assert((await html(owner)).includes('No team members yet'), 'empty state missing');
    await shot(owner, '01-empty-dashboard');
  });

  await step('Owner adds a doer (phone login)', async () => {
    await owner.goto(`${BASE}/doers/new`, { waitUntil: 'load' });
    await owner.fill('input[name=name]', 'Ramesh Kumar');
    await owner.fill('input[name=phone]', '9822222201');
    await owner.selectOption('select[name=role]', 'doer');
    await owner.fill('input[name=password]', '1111');
    await submitAndWait(owner, owner.locator('main form button[type=submit]').first());
    assert((await flashOf(owner)).includes('added'), 'no success flash');
    assert((await html(owner)).includes('Ramesh Kumar'), 'doer missing from team list');
  });

  await step('Owner adds a manager', async () => {
    await owner.goto(`${BASE}/doers/new`, { waitUntil: 'load' });
    await owner.fill('input[name=name]', 'Anil Kapoor');
    await owner.fill('input[name=phone]', '9822222202');
    await owner.selectOption('select[name=role]', 'manager');
    await owner.fill('input[name=password]', '2222');
    await submitAndWait(owner, owner.locator('main form button[type=submit]').first());
    assert((await html(owner)).includes('Anil Kapoor'), 'manager missing from team list');
    assert((await html(owner)).includes('MANAGER'), 'manager badge missing');
  });

  await step('Duplicate phone number is rejected', async () => {
    await owner.goto(`${BASE}/doers/new`, { waitUntil: 'load' });
    await owner.fill('input[name=name]', 'Duplicate Person');
    await owner.fill('input[name=phone]', '9822222201');
    await owner.fill('input[name=password]', '9999');
    await submitAndWait(owner, owner.locator('main form button[type=submit]').first());
    assert((await flashOf(owner)).includes('already exists'), 'duplicate not rejected');
  });

  let today;
  await step('Owner assigns a task (T-0001)', async () => {
    await owner.goto(`${BASE}/delegations/new`, { waitUntil: 'load' });
    today = await owner.inputValue('input[name=first_date]'); // the app's "today"
    await owner.selectOption('select[name=doer_id]', { label: 'Ramesh Kumar' });
    await owner.fill('textarea[name=description]', 'Service the boiler pump');
    await submitAndWait(owner, owner.locator('main form button[type=submit]').first());
    assert((await flashOf(owner)).includes('T-0001'), 'task id missing from flash');
    assert((await html(owner)).includes('Service the boiler pump'), 'task missing from list');
    assert((await html(owner)).includes('Assigned'), 'status badge missing');
  });

  await step('Moving a deadline records a revision + Week shifted', async () => {
    await owner.goto(`${BASE}/delegations/new`, { waitUntil: 'load' });
    await owner.selectOption('select[name=doer_id]', { label: 'Ramesh Kumar' });
    await owner.fill('textarea[name=description]', 'Order spare belts');
    await submitAndWait(owner, owner.locator('main form button[type=submit]').first());

    const d = new Date(today + 'T00:00:00');
    d.setDate(d.getDate() + 10);
    const plus10 = d.toISOString().slice(0, 10);

    const row = owner.locator('tr', { hasText: 'T-0002' });
    await row.locator('details.push summary').click();
    await row.locator('input[name=new_date]').fill(plus10);
    await submitAndWait(owner, row.locator('form[action$="/revise"] button'));
    assert((await flashOf(owner)).includes('revision #1'), 'revision flash missing');
    const rowHtml = await owner.locator('tr', { hasText: 'T-0002' }).innerHTML();
    assert(rowHtml.includes('Week shifted'), 'Week shifted status missing');
    assert(rowHtml.includes('1×'), 'revision count missing');
    await shot(owner, '02-tasks-with-revision');
  });

  await step('Owner creates a weekly FMS item', async () => {
    await owner.goto(`${BASE}/recurring/new?type=fms`, { waitUntil: 'load' });
    await owner.fill('input[name=name]', 'Follow up pending payments');
    await owner.selectOption('select[name=doer_id]', { label: 'Ramesh Kumar' });
    await owner.selectOption('select[name=frequency]', 'weekly');
    await submitAndWait(owner, owner.locator('main form button[type=submit]').first());
    assert((await flashOf(owner)).includes('first cycle created'), 'no cycle-created flash');
    assert((await html(owner)).includes('Follow up pending payments'), 'item missing');
  });

  await step('Owner creates a daily checklist item', async () => {
    await owner.goto(`${BASE}/recurring/new?type=checklist`, { waitUntil: 'load' });
    await owner.fill('input[name=name]', 'Morning safety walk');
    await owner.selectOption('select[name=doer_id]', { label: 'Ramesh Kumar' });
    await owner.selectOption('select[name=frequency]', 'daily');
    await submitAndWait(owner, owner.locator('main form button[type=submit]').first());
    assert((await html(owner)).includes('Morning safety walk'), 'checklist item missing');
  });

  await step('Doer logs in with phone number, sees only their work', async () => {
    lastPage = doer;
    await login(doer, '9822222201', '1111');
    const h = await html(doer);
    assert(h.includes('Hi Ramesh'), 'doer greeting missing');
    assert(h.includes('Service the boiler pump'), 'assigned task missing');
    assert(!h.includes('Team dashboard'), 'doer must not see the admin dashboard');
    await shot(doer, '03-doer-home');
  });

  await step('Doer completes their task and routine work (one tap each)', async () => {
    for (let i = 0; i < 6; i++) {
      const btn = doer.locator('form[action*="/complete"] button, form[action$="/done"] button').first();
      if (!(await btn.count())) break;
      await submitAndWait(doer, btn);
    }
    const h = await html(doer);
    assert(h.includes('Nothing else due this week') || h.includes('caught up'), 'tasks not cleared');
    assert(h.includes('No routine items pending'), 'routine not cleared');
    await shot(doer, '04-doer-all-done');
  });

  await step('Doer is blocked from admin pages', async () => {
    await doer.goto(`${BASE}/doers`, { waitUntil: 'load' });
    assert(!doer.url().includes('/doers'), 'doer reached the team page');
    assert((await flashOf(doer)).includes('permission'), 'no permission flash');
  });

  await step('Doer can open their own score history', async () => {
    await doer.goto(`${BASE}/my/scores`, { waitUntil: 'load' });
    assert((await html(doer)).includes('My scores'), 'my scores page missing');
  });

  await step('Score recompute turns the week green (3/3 done)', async () => {
    lastPage = owner;
    await owner.goto(`${BASE}/scores`, { waitUntil: 'load' });
    await submitAndWait(owner, owner.locator('form[action="/scores/recompute"] button'));
    assert((await flashOf(owner)).includes('refreshed'), 'recompute flash missing');
    const h = await html(owner);
    assert(h.includes('cell-green'), 'no green cell in matrix');
    assert(h.includes('3/3'), 'expected 3 planned / 3 done this week');
    await shot(owner, '05-score-matrix');
  });

  await step('Dashboard tile shows GREEN · 0 for the doer', async () => {
    await owner.goto(BASE, { waitUntil: 'load' });
    const tile = await owner.locator('.tile', { hasText: 'Ramesh Kumar' }).innerHTML();
    assert(tile.includes('GREEN · 0'), 'tile badge is not GREEN · 0');
  });

  await step('Rating bands: invalid rejected, valid saved', async () => {
    await owner.goto(`${BASE}/scores/thresholds`, { waitUntil: 'load' });
    await owner.fill('input[name=green]', '-40');
    await owner.fill('input[name=yellow]', '-25');
    await submitAndWait(owner, owner.locator('main form button[type=submit]').first());
    assert((await flashOf(owner)).includes('must be higher'), 'invalid bands not rejected');
    await owner.fill('input[name=green]', '-5');
    await owner.fill('input[name=yellow]', '-25');
    await submitAndWait(owner, owner.locator('main form button[type=submit]').first());
    assert((await flashOf(owner)).includes('saved'), 'bands not saved');
    assert(await owner.inputValue('input[name=green]') === '-5', 'green value not persisted');
  });

  await step('Settings shows both channels ON (test mode) + report recipients', async () => {
    await owner.goto(`${BASE}/settings`, { waitUntil: 'load' });
    const h = await html(owner);
    assert((h.match(/test mode/g) || []).length >= 2, 'both channels should show test mode');
    assert(h.includes('boss@e2e.local'), 'REPORT_EMAIL not shown');
    assert(h.includes('919811111111'), 'REPORT_WHATSAPP not shown');
    await shot(owner, '06-settings');
  });

  await step('Test email button works', async () => {
    await submitAndWait(owner, owner.locator('form[action="/settings/test-email"] button'));
    assert((await flashOf(owner)).includes('Test email sent to boss@e2e.local'), 'test email flash wrong');
  });

  await step('Test WhatsApp button works', async () => {
    await submitAndWait(owner, owner.locator('form[action="/settings/test-whatsapp"] button'));
    assert((await flashOf(owner)).includes('Test WhatsApp sent to 919811111111'), 'test whatsapp flash wrong');
  });

  await step('Overdue task appears in digests + owner report (both channels)', async () => {
    // Create an overdue task (due yesterday) straight through the UI.
    await owner.goto(`${BASE}/delegations/new`, { waitUntil: 'load' });
    const d = new Date(today + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    const yesterday = d.toISOString().slice(0, 10);
    await owner.selectOption('select[name=doer_id]', { label: 'Ramesh Kumar' });
    await owner.fill('textarea[name=description]', 'Clean the filter tank');
    await owner.fill('input[name=first_date]', yesterday);
    await submitAndWait(owner, owner.locator('main form button[type=submit]').first());

    await owner.goto(`${BASE}/settings`, { waitUntil: 'load' });
    await submitAndWait(owner, owner.locator('form[action="/settings/send-digests"] button'));
    let f = await flashOf(owner);
    assert(f.includes('Digests sent') && f.includes('1 WhatsApp'), `digest flash: ${f}`);
    await submitAndWait(owner, owner.locator('form[action="/settings/send-report"] button'));
    f = await flashOf(owner);
    assert(f.includes('Overdue report sent'), `report flash: ${f}`);
  });

  await step('Weekly summary dispatches to managers + report recipients', async () => {
    await owner.goto(`${BASE}/settings`, { waitUntil: 'load' });
    await submitAndWait(owner, owner.locator('form[action="/settings/send-summary"] button'));
    const f = await flashOf(owner);
    assert(f.includes('Weekly summary sent'), `summary flash: ${f}`);
  });

  await step('CSV export returns valid data', async () => {
    const res = await owner.request.get(`${BASE}/scores/export.csv`);
    assert(res.ok(), `status ${res.status()}`);
    const body = await res.text();
    assert(body.startsWith('doer,week_number,week_start'), 'csv header wrong');
    assert(body.includes('Ramesh Kumar'), 'csv missing doer rows');
  });

  await step('Cron endpoints: wrong key blocked, right key runs', async () => {
    const bad = await owner.request.get(`${BASE}/cron/run?key=wrong`);
    assert(bad.status() === 403, `bad key gave ${bad.status()}`);
    const run = await owner.request.get(`${BASE}/cron/run?key=${CRON_SECRET}`);
    assert(run.ok() && (await run.json()).ok, '/cron/run failed');
    const daily = await owner.request.get(`${BASE}/cron/daily?key=${CRON_SECRET}`);
    const dj = await daily.json();
    assert(daily.ok() && dj.ok && dj.digests, '/cron/daily failed');
  });

  await step('PWA: manifest, service worker, offline page, icons', async () => {
    const man = await owner.request.get(`${BASE}/manifest.webmanifest`);
    assert(man.ok(), `manifest -> ${man.status()}`);
    const m = await man.json();
    assert(m.name && m.icons.length >= 2, 'manifest missing name or icons');
    assert(m.icons.some(i => i.purpose === 'maskable'), 'no maskable icon for Android');
    for (const p of ['/sw.js', '/offline.html', '/icons/icon-192.png', '/icons/icon-512.png',
                     '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png',
                     '/icons/favicon-32.png', '/img/logo.svg', '/img/empty-team.svg']) {
      const r = await owner.request.get(BASE + p);
      assert(r.ok(), `${p} -> ${r.status()}`);
    }
  });

  await step('Branding renders: logo in header, lockup + tagline on login', async () => {
    // Signed-in page: the header carries the mark + wordmark.
    const pageHtml = await html(owner);
    assert(pageHtml.includes('class="brand-mark"'), 'header logo missing');
    assert(pageHtml.includes('rel="apple-touch-icon"'), 'apple-touch-icon link missing');
    // The login page only renders for a signed-out visitor, so use a cookie-free context.
    const anon = await browser.newContext();
    const loginHtml = await (await anon.request.get(`${BASE}/login`)).text();
    await anon.close();
    assert(loginHtml.includes('class="login-mark"'), 'login lockup missing');
    assert(loginHtml.includes('Every task, tracked.'), 'tagline missing');
    assert(loginHtml.includes('Work<span class="brand-accent">Pulse</span>'), 'two-tone wordmark missing');
  });

  await step('Activity trail recorded every action', async () => {
    await owner.goto(`${BASE}/activity`, { waitUntil: 'load' });
    const h = await html(owner);
    for (const needle of ['added a person', 'assigned a task', 'completed a task', 'moved a deadline', 'did routine work']) {
      assert(h.includes(needle), `activity missing: ${needle}`);
    }
    await shot(owner, '07-activity');
  });

  await step('Test-mode channel logs confirm real dispatch calls', async () => {
    if (!process.env.E2E_APP_LOG) return; // optional check
    const log = fs.readFileSync(process.env.E2E_APP_LOG, 'utf8');
    assert((log.match(/\[mail:test-mode\]/g) || []).length >= 3, 'too few mail dispatches logged');
    assert((log.match(/\[whatsapp:test-mode\]/g) || []).length >= 3, 'too few whatsapp dispatches logged');
  });

  await step('Logout returns to the login page', async () => {
    await owner.goto(BASE, { waitUntil: 'load' });
    await submitAndWait(owner, owner.locator('.topbar form[action="/logout"] button'));
    assert(owner.url().includes('/login'), 'not back on /login');
  });

  await browser.close();

  // ---------------- report ----------------
  const passed = results.filter(r => r.ok).length;
  const lines = [
    '# Browser end-to-end test report',
    '',
    `**Target:** ${BASE} (fresh database, first-boot setup included)`,
    `**Date:** ${new Date().toISOString()}`,
    `**Result: ${passed}/${results.length} checks passed**`,
    '',
    '| # | Check | Result |',
    '|---|-------|--------|',
    ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.ok ? '✅ PASS' : `❌ FAIL — ${r.note}`} |`),
    '',
    `Screenshots: ${SHOT_DIR}/`
  ];
  fs.writeFileSync('e2e-report.md', lines.join('\n'));
  console.log(`\n${passed}/${results.length} passed — report written to e2e-report.md`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
