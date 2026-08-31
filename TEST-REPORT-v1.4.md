# Browser end-to-end test report

**Target:** http://localhost:3100 (fresh database, first-boot setup included)
**Date:** 2026-08-31T05:36:07.352Z
**Result: 29/29 checks passed**

| # | Check | Result |
|---|-------|--------|
| 1 | Health endpoint responds | ✅ PASS |
| 2 | Login rejects a wrong password | ✅ PASS |
| 3 | Email login is case-insensitive (Postgres/TiDB compare case-sensitively) | ✅ PASS |
| 4 | Owner logs in; fresh install shows empty dashboard | ✅ PASS |
| 5 | Owner adds a doer (phone login) | ✅ PASS |
| 6 | Owner adds a manager | ✅ PASS |
| 7 | Duplicate phone number is rejected | ✅ PASS |
| 8 | Owner assigns a task (T-0001) | ✅ PASS |
| 9 | Moving a deadline records a revision + Week shifted | ✅ PASS |
| 10 | Owner creates a weekly FMS item | ✅ PASS |
| 11 | Owner creates a daily checklist item | ✅ PASS |
| 12 | Doer logs in with phone number, sees only their work | ✅ PASS |
| 13 | Doer completes their task and routine work (one tap each) | ✅ PASS |
| 14 | Doer is blocked from admin pages | ✅ PASS |
| 15 | Doer can open their own score history | ✅ PASS |
| 16 | Score recompute turns the week green (3/3 done) | ✅ PASS |
| 17 | Dashboard tile shows GREEN · 0 for the doer | ✅ PASS |
| 18 | Rating bands: invalid rejected, valid saved | ✅ PASS |
| 19 | Settings shows both channels ON (test mode) + report recipients | ✅ PASS |
| 20 | Test email button works | ✅ PASS |
| 21 | Test WhatsApp button works | ✅ PASS |
| 22 | Overdue task appears in digests + owner report (both channels) | ✅ PASS |
| 23 | Weekly summary dispatches to managers + report recipients | ✅ PASS |
| 24 | CSV export returns valid data | ✅ PASS |
| 25 | Cron endpoints: wrong key blocked, right key runs | ✅ PASS |
| 26 | PWA: manifest, service worker, offline page, icons | ✅ PASS |
| 27 | Activity trail recorded every action | ✅ PASS |
| 28 | Test-mode channel logs confirm real dispatch calls | ✅ PASS |
| 29 | Logout returns to the login page | ✅ PASS |

Screenshots: e2e-screenshots/