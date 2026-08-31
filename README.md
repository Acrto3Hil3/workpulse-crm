# WorkPulse

*Delegation, follow-ups and weekly performance scoring for small industrial teams.*

A lightweight, self-hosted web app for staff task delegation, follow-ups (FMS), checklists and automatic weekly red/yellow/green performance scoring. It replaces the Google Sheets + Apps Script "MIS" system with one database, one app, and the same business logic.

**Stack:** Node.js + Express · PostgreSQL **or** MySQL/MariaDB (one connection string picks the engine) · server-rendered EJS (no build step) — chosen to deploy easily on Hostinger, work with free serverless databases like Neon, and stay fast under heavy daily use.

## How it works

- **Delegation** — one-off assigned tasks. Every task keeps its *first date* (original commitment). Moving the deadline records Revision 1 / Revision 2 and counts every slip, so tasks that keep sliding stay visible ("Week shifted").
- **FMS + Checklist** — standing responsibilities. Each active item automatically gets a fresh entry every day/week/month; marking it done records the date and any delay.
- **Scoring** — every week (Sunday to Saturday) each doer gets:

  `score = min(0, max(-100, (done / planned − 1) × 100))`

  0 = everything done, −50 = half done, −100 = nothing done. Scores are bucketed into GREEN / YELLOW / RED (bands configurable in *Scores → Rating settings*). Scores are **precomputed** by a scheduled job and stored in `weekly_scores`, so dashboards stay fast no matter how much history accumulates.
- **Roles** — *Owner* (everything), *Manager/EA* (assign tasks, see all scores), *Doer* (sees only their own tasks; one big "Done" button per task).
- **Reminders & reports, two channels** — every morning each doer with pending work gets a digest (overdue → due today → routine) on **email and/or WhatsApp**, whatever their account has; the boss gets a one-glance **overdue report**, and on Sundays the **weekly score summary** — all delivered to the addresses set in `REPORT_EMAIL` / `REPORT_WHATSAPP`. Automatic WhatsApp uses the official Meta Cloud API (see *WhatsApp setup* below); with no API configured, every doer page still has one-tap manual 💬 buttons (wa.me links, zero setup, zero cost).
- **Activity log** — every assignment, completion, deadline move, reopen and reset is recorded with who did it and when (Dashboard → Recent activity, or the full log at /activity).
- **Installable** — the app is a PWA: on a phone, "Add to Home screen" installs it like an app (with its own icon), and shows a friendly offline screen when the network drops.
- **Branded, and white-labelable** — logo, icons, colours and wordmark ship with the app; see [BRAND.md](BRAND.md). Setting `APP_NAME` in `.env` renames the whole product — screens, emails and WhatsApp messages — for a client.

## Quick start

```bash
cp .env.example .env        # paste your DATABASE_URL + set the secrets
npm install
npm start                   # first boot creates all tables + the owner account
```

Open http://localhost:3000 and log in.

### Default login

On the very first boot — and only while the `users` table is still empty — the app creates one **Owner** account from `.env`. If you haven't changed those lines, the credentials are:

| | |
|---|---|
| **Email** | `owner@example.com` |
| **Password** | `changeme123` |

The Owner role passes every permission check, so this account can do everything: add doers, assign delegations, run FMS/checklists, edit rating bands and settings.

Set `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env` *before* the first `npm start` to create the owner with your own credentials instead. **On a real deployment, never leave the default password in place** — the app prints a warning on boot if you do. The account is only ever seeded once; changing these values later has no effect, so change the password from inside the app.

Optional: `npm run demo` fills an empty system with sample data — 4 doers and a manager, who **log in with their phone number** (`9800000001`…`9800000005`) and password `1234`. Demo data only; don't seed it on a production instance.

With an online database (next section) this is all you need on any machine — no local MySQL/Postgres install.

## Choosing a database

The app runs unchanged on PostgreSQL or MySQL. Put one connection string in `DATABASE_URL` and the engine is detected from the prefix — the schema, sessions, everything else adapts automatically. Both engines pass the full browser test suite.

| Option | Engine | Free tier (checked Aug 2026) | Good to know |
|---|---|---|---|
| **TiDB Cloud Starter** (tidbcloud.com) — *recommended* | MySQL-compatible, serverless | 5 GiB row storage, 50 M request units/month, no credit card | Largest free allowance, and when the quota runs out it throttles new connections rather than stopping the database. Free instances allow 400 concurrent connections. |
| **Neon** (neon.com) | Postgres, serverless | 0.5 GB storage, 100 compute-hours/month per project, compute sleeps after 5 min idle | Cleanest Postgres option. Watch the compute-hour cap: at the smallest size that's ~13 active hours/day, and exceeding it pauses the database until the next month (the paid Launch plan removes the cap). |
| **Supabase** (supabase.com) | Postgres | 500 MB, 2 projects | Paused after 1 week of no use — fine for a daily-use app, just note it. |
| **Hostinger's bundled MySQL** | MySQL | Included with the hosting plan | Zero extra vendors, lowest latency if the app is on the same Hostinger server. Use the `DB_*` variables instead of a URL. |

### TiDB Cloud Starter in 6 steps (MySQL-compatible, free)

1. Sign up at **tidbcloud.com** (Google/GitHub login works, no credit card) and create a **Starter** instance — pick the region closest to your staff (e.g. *Singapore* for India).
2. Open the instance and click **Connect** (top-right).
3. Connection type **Public**, branch **main**, *Connect With* → **Node.js**.
4. Click **Generate Password** and copy it immediately — it is shown only once. (You can reset it later from the same dialog.)
5. The dialog now shows everything you need: **host** (`gateway01.<region>.prod.aws.tidbcloud.com`), **port** `4000`, **user** (`<prefix>.root`), **database** (`test`). Put them into `.env` as one line:
   ```
   DATABASE_URL=mysql://<prefix>.root:<password>@gateway01.<region>.prod.aws.tidbcloud.com:4000/test
   ```
6. `npm start` — the first boot creates every table in TiDB and the owner account.

Notes that save time:
- **If the password contains `#`, `/`, `?` or `%`**, the URL will not parse and the app dies on boot with `Invalid URL`. Either regenerate the password, percent-encode those characters (`#` → `%23`, `/` → `%2F`, `?` → `%3F`, `%` → `%25`), or skip `DATABASE_URL` and use the plain variables instead: `DB_HOST`, `DB_PORT=4000`, `DB_USER`, `DB_PASS`, `DB_NAME=test`, `DB_SSL=true`. Other punctuation — `@ : & + $` — is parsed correctly and needs no escaping.
- **IP allowlist:** the public endpoint only accepts listed IPs. In the Connect dialog set it to allow access from anywhere while testing, then narrow it to your Hostinger server's IP for production.
- TLS is on automatically (TiDB requires it). Set `DB_SSL_VERIFY=true` to also verify the certificate.
- The app detects TiDB on first boot and switches its tables to continuous ID allocation, so task numbers stay tidy (T-0001, T-0002 …) instead of jumping by 30000 after a restart.
- A free instance sleeps when idle and wakes on the next query (a second or two). The connection pool recycles connections every 60s, well inside TiDB's ~340s idle cut-off, so this is invisible to users.

### Neon in 5 steps

1. Sign up at **neon.com**, create a project (pick the region nearest your staff — e.g. *Singapore* for India).
2. On the project dashboard click **Connect**, choose *Node.js*, and copy the connection string. It looks like `postgresql://neondb_owner:xxxx@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.
3. Paste it into `.env` as `DATABASE_URL=...` (the *pooled* string works too).
4. `npm start` — the first boot creates every table in your Neon database and the owner account.
5. Done. Neon's dashboard shows the tables under *Tables*, and *Monitoring* shows compute hours used.

TiDB Cloud is the same idea: create a Starter cluster → **Connect** → copy the *Node.js* string (`mysql://...@gateway01....tidbcloud.com:4000/...`) → `DATABASE_URL`. Supabase: *Project settings → Database → Connection string (URI)*.

Cloud databases are connected over TLS automatically. Set `DB_SSL_VERIFY=true` to additionally verify the server certificate (works with Neon and TiDB Cloud).

## Deploying on Hostinger

### Option A — VPS (recommended for heavy use)

1. Create a Hostinger VPS (Ubuntu). Install Node 18+: `apt install nodejs npm` (or use nvm for Node 20).
2. Database: either paste your Neon/TiDB `DATABASE_URL` into `.env` (nothing to install), or run MariaDB on the VPS:
   ```sql
   -- apt install mariadb-server, then:
   CREATE DATABASE workpulse CHARACTER SET utf8mb4;
   CREATE USER 'crm'@'localhost' IDENTIFIED BY 'strong-password';
   GRANT ALL PRIVILEGES ON workpulse.* TO 'crm'@'localhost';
   ```
3. Upload this folder (or `git clone`), then `npm install --omit=dev`.
4. `cp .env.example .env` and fill it in. Keep `CRON_ENABLED=true`.
5. Run under PM2 so it survives reboots and uses all CPU cores:
   ```bash
   npm install -g pm2
   pm2 start ecosystem.config.js
   pm2 save && pm2 startup
   ```
6. Point Nginx (or Hostinger's panel proxy) at port 3000 and add the free SSL. Then set `SECURE_COOKIES=true` in `.env` and `pm2 restart workpulse`.

### Option B — Hostinger shared/cloud hosting with Node.js support

1. In hPanel create a **Node.js application** (entry file `server.js`, Node 18+). For the database either use your Neon/TiDB `DATABASE_URL`, or create a **MySQL database** in hPanel → Databases (note the name/user/password — they get a prefix like `u123456_crm`).
2. Upload the project files (File Manager or Git), run `npm install` from the panel/SSH.
3. Create `.env` with the database setting. Set `CRON_ENABLED=false`.
4. Add two hPanel **Cron Jobs** that call the app's job endpoints:
   ```
   hourly:      curl -s "https://your-domain.com/cron/run?key=YOUR_CRON_SECRET" > /dev/null
   daily 08:00: curl -s "https://your-domain.com/cron/daily?key=YOUR_CRON_SECRET" > /dev/null
   ```
   The hourly one generates recurring entries and refreshes weekly scores even if the Node process was asleep; the daily one additionally sends reminder emails (and the Sunday summary).

> If your current Hostinger plan has no Node.js option, a small VPS is the clean answer — this app is light (one process, ~100 MB RAM).

## Notification setup

Everything lives in `.env` (full comments inside `.env.example`):

1. **Where reports go** — `REPORT_EMAIL` and `REPORT_WHATSAPP` (comma-separated for several people). These receive the daily overdue report and the Sunday score summary. Left empty, they default to every owner account's email/phone.
2. **Email channel** — fill the `SMTP_*` block. A Hostinger mailbox (hPanel → Emails) works directly: `SMTP_HOST=smtp.hostinger.com`, `SMTP_PORT=465`, `SMTP_USER`/`SMTP_PASS` = the mailbox login.
3. **WhatsApp channel** — see below.

Then open **Settings** in the app: each channel shows ON/OFF, with *Send test email*, *Send test WhatsApp*, *Send digests now* and *Send overdue report now* buttons to verify everything before relying on the schedule.

### WhatsApp setup (Meta WhatsApp Cloud API, ~10 minutes)

1. Go to **developers.facebook.com** → *My Apps* → *Create App* → type **Business**.
2. In the app dashboard add the **WhatsApp** product. The *API Setup* page gives you a **test number**, a **Phone number ID**, and a temporary access token — enough to try everything immediately (add your own phone as a test recipient).
3. Put them in `.env`: `WHATSAPP_PHONE_ID` = the Phone number ID, `WHATSAPP_TOKEN` = the token. Restart, then use *Send test WhatsApp* in Settings.
4. For production: connect your real business number in the same page, and create a **permanent token** (Business settings → System users → generate token with `whatsapp_business_messaging` permission).
5. **Delivery rule to know:** Meta only delivers *free-form* texts to people who messaged your business number within the last 24 hours. Two ways to handle it:
   - Easiest: tell staff to send one "Hi" to the business number and reply occasionally (their daily "done" replies keep the window open), or
   - Bulletproof: create a **message template** (Meta business manager → WhatsApp templates) whose body is just `{{1}}`, get it approved (usually minutes), and set `WHATSAPP_TEMPLATE=your_template_name`. Template messages always deliver.

`WHATSAPP_TOKEN=json` is a test mode: messages print to the server log instead of sending — useful before credentials exist.

## Importing your existing Google Sheets data

Export each sheet tab as CSV (File → Download → CSV), then on the server:

```bash
node scripts/import-sheets.js doers ./doer-list.csv --default-password 1234
node scripts/import-sheets.js delegations ./delegation.csv
node scripts/import-sheets.js archive ./archive.csv     # old weekly scores
```

Column names are matched loosely (`Doer`, `Task`, `First Date`, `Revision 1`, `Status`, …). Import doers first — task rows are matched to users by name. After importing, open **Scores → Rebuild older weeks** to score the imported history.

## Deploying to Render

The repo ships a [`render.yaml`](render.yaml) blueprint, so the service is created for you.

1. **Create the database first** — TiDB Cloud (MySQL) or Neon (Postgres), per *Choosing a database* above. Copy its connection string. Keeping the database off Render means the data survives the web service being deleted or recreated.

   On **TiDB Cloud**, build the URL by hand from the *Connect* dialog:

   ```
   mysql://<user>.root:<password>@gateway01.<region>.prod.aws.tidbcloud.com:4000/<database>
   ```

   Two things bite here:

   - **The `:4000` is mandatory.** TiDB does not use 3306, and omitting the port makes the app fall back to 3306 and fail to connect.
   - **Percent-encode `#`, `/`, `?` and `%` if they appear in the generated password** — `#` → `%23`, `/` → `%2F`, `?` → `%3F`, `%` → `%25`. Any of those four makes the URL unparseable and the app dies on boot with `Invalid URL`. Other punctuation (`@ : & + $`) is parsed correctly and needs no encoding.

   TLS needs no configuration: the app enables it automatically for any non-local host.
2. In Render: **New → Blueprint**, pick this repo. It reads `render.yaml` and configures the service — Node 20, `npm install`, `npm start`, health check on `/health`. There is no build step.
3. Render prompts for the values marked `sync: false`: paste `DATABASE_URL`, and set `ADMIN_EMAIL` / `ADMIN_PASSWORD` to what you actually want the owner login to be. `SESSION_SECRET` and `CRON_SECRET` are generated for you.
4. Deploy. First boot applies the schema and creates the owner account.
5. Set `APP_URL` to the live URL (`https://workpulse-crm.onrender.com`) so reminder messages carry a link.

The blueprint names the service `workpulse-crm`, which is what makes the URL `https://workpulse-crm.onrender.com`. Render subdomains are globally unique and a taken name silently gets a random suffix, so if you rename the service, check the name is free first — an unclaimed subdomain answers with the header `x-render-routing: no-server`.

`SECURE_COOKIES` is already `true` in the blueprint — Render terminates TLS and `server.js` sets `trust proxy`, so the session cookie is correctly marked Secure.

> `DATABASE_URL` must be set **before** the first deploy. The app applies its schema on boot, so without a reachable database the deploy fails rather than starting up half-configured.

### Keeping the schedules running

Free Render instances sleep after ~15 minutes idle. An in-process `node-cron` would sleep with them and silently miss the morning digest, so the blueprint sets `CRON_ENABLED=false` and you drive the jobs over HTTP instead. Point any free scheduler (cron-job.org, UptimeRobot) at:

| When | URL |
|---|---|
| Hourly | `https://workpulse-crm.onrender.com/cron/run?key=<CRON_SECRET>` |
| Once daily, ~08:00 | `https://workpulse-crm.onrender.com/cron/daily?key=<CRON_SECRET>` |

The request wakes the instance and runs the job in the same call. Sessions live in the database, so sleeping never logs anyone out. On a paid always-on instance, set `CRON_ENABLED=true` and drop the pinger.

Two limits worth knowing on the free plan: the first request after a sleep takes roughly a minute, and pinging often enough to stay permanently awake runs close to the monthly instance-hour allowance. Check Render's current free-tier terms — they change.

## Environment variables

| Variable | Meaning |
|---|---|
| `PORT` | Port the app listens on (default 3000; Render sets this automatically) |
| `APP_NAME` | Name shown in the header (e.g. "BMP CRM") |
| `APP_TZ` | Business timezone — week boundaries follow it (e.g. `Asia/Kolkata`) |
| `SESSION_SECRET` | Long random string; cookie signing |
| `SECURE_COOKIES` | `true` once the site runs on HTTPS |
| `DATABASE_URL` | `postgres://…` (Neon, Supabase) or `mysql://…` (TiDB Cloud, Aiven) — picks the engine |
| `DB_SSL_VERIFY` | `true` to verify the cloud database's certificate (default: encrypted, not verified) |
| `DB_HOST/PORT/NAME/USER/PASS` | MySQL credentials, used only when `DATABASE_URL` is empty (Hostinger bundled MySQL) |
| `ADMIN_NAME/EMAIL/PASSWORD` | First owner account, created on first boot only |
| `CRON_ENABLED` | `true` = run schedules in-process (VPS); `false` = use `/cron/run` + `/cron/daily` |
| `CRON_SECRET` | Key for the `/cron/*` endpoints |
| `APP_URL` | Public URL, linked in reminders/reports (optional) |
| `REPORT_EMAIL` / `REPORT_WHATSAPP` | Who receives the overdue report + weekly summary (comma-separated; empty = owner accounts) |
| `SMTP_HOST/PORT/USER/PASS/FROM` | Email channel; empty = off, `SMTP_HOST=json` = test mode (log only) |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` | WhatsApp channel (Meta Cloud API); both empty = off, `WHATSAPP_TOKEN=json` = test mode |
| `WHATSAPP_TEMPLATE` / `WHATSAPP_TEMPLATE_LANG` | Approved template name for always-deliver reminders (optional) |
| `WHATSAPP_CC` | Country code prepended to 10-digit phone numbers (default 91) |

## Security checklist before giving out logins

1. Set real values for `SESSION_SECRET`, `CRON_SECRET`, `ADMIN_PASSWORD`.
2. Serve over HTTPS and set `SECURE_COOKIES=true`.
3. Change the owner password after first login (Team → your account → Edit).
4. Give doers simple PINs — they only see their own tasks anyway. Passwords are bcrypt-hashed; login is rate-limited.

## Operations notes

- **Backups:** on Neon, point-in-time restore is built in (the retention window depends on the plan — take a weekly `pg_dump "$DATABASE_URL" > backup.sql` for longer keeping). On Hostinger MySQL, enable the panel's scheduled backups; a manual dump is `mysqldump workpulse > backup.sql`, restore with `mysql workpulse < backup.sql`. Test the restore once.
- **Performance:** every list is paginated, every foreign key and date column is indexed, and weekly scores are precomputed — dashboards do no heavy math at request time. The app is stateless (sessions in MySQL), so PM2 cluster mode scales it across cores with zero code changes.
- **Data growth:** `weekly_scores` grows by (doers × 52) rows/year — tiny. If `delegations` ever reaches millions of rows, archive completed tasks older than ~2 years into a copy table; the schema needs no change.
- **Health check:** `GET /health` returns `{ok:true}` — point an uptime monitor at it.

## Project structure

```
server.js               app entry: sessions, routes, boot jobs
schema.sql              full schema, MySQL edition (auto-applied on first boot)
schema.pg.sql           full schema, PostgreSQL edition (auto-applied on first boot)
src/db.js               database layer: Postgres or MySQL from DATABASE_URL, first-run setup
src/dates.js            Sunday-week math, date helpers
src/auth.js             login/session middleware, roles, rate limit
src/scoring.js          the scoring engine (the MIS formula)
src/cron.js             recurring-entry generation + scoring + reminder schedules
src/mailer.js           SMTP email (optional, on when SMTP_HOST is set)
src/reminders.js        daily doer digest + Sunday manager summary
src/activity.js         audit-trail writer
src/routes/*.js         auth, dashboard, doers, delegations, recurring, scores, activity, settings
src/views/*.ejs         server-rendered pages (mobile-first)
public/css/app.css      the whole UI theme
public/img/*.svg        logo, lockup and empty-state art (see BRAND.md)
public/icons/*.png      app icons, generated by scripts/render-icons.js
scripts/import-sheets.js  one-time CSV import from the old sheets
scripts/seed-demo.js      demo data for trying the app
```
