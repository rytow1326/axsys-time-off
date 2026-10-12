# Axsys Time Off

Time-off requests and absence tracking for Axsys Dental Solutions.

- **Employee app** (Windows, installable) — request vacation/PTO and personal days, see a running
  total of days taken this year and allowance remaining, edit or cancel pending requests, get a
  Windows notification when a request is approved or denied.
- **Manager portal** (secure website) — approve/deny requests, record sick days and other absences
  directly, edit or remove entries, per-employee totals by type, calendar, filters, Excel export,
  full activity history, email delivery log.
- **Email** — every new, changed or cancelled request emails ryant@axsysinc.com with a link to review
  it; employees are emailed the decision.

Setup: **[SETUP.md](SETUP.md)** — a one-button deploy, about 15 minutes, nothing to install.

## How it fits together

```
 Employee app (Windows, Electron) ─┐                         ┌─► notify function ─► Resend ─► email
                                   ├─► Supabase (Postgres) ──┤
 Manager portal (static website) ──┘   auth · security rules └─► realtime updates to both apps
                                       triggers · audit log
```

| Folder | What it is |
|---|---|
| `supabase/migrations/` | The whole database: tables, day-count math, business rules, row-level security, audit log, email triggers |
| `supabase/functions/notify/` | Sends the emails (called by the database) and records each attempt in `email_log` |
| `supabase/functions/admin-users/` | Lets managers create logins, reset passwords and deactivate accounts |
| `manager-portal/` | Static site (HTML/CSS/JS, no build step) |
| `employee-app/` | Electron desktop app + Windows installer config |
| `.github/workflows/deploy.yml` | One-button deploy: database, email functions, portal hosting (GitHub Pages), Windows installer |
| `deploy/` | The database/email setup script the Deploy button runs |
| `docs/MANUAL-SETUP.md` | Step-by-step manual alternative |
| `tests/` | Database behaviour tests (67 checks) |

## Rules the database enforces

These live in Postgres, so they hold no matter which app (or tool) makes the change.

- Anyone can create an account from the employee app, but **only with an @axsysinc.com email** (checked by the
  database, so it can't be bypassed), and they must give a first and last name. New accounts wait in the portal's
  **Employees → Waiting for approval** list; until a manager approves them (and sets their days per year) they can't
  submit requests. Accounts a manager creates directly are approved immediately.
- Employees can only see and submit their **own** time off; they can't see anyone else's records.
- Employee requests are always created as **Pending** — only a manager can approve or deny.
- Employees can edit or cancel a request only while it's pending. They can't delete anything.
- Sick days are manager-entered by default (configurable per absence type); manager entries are approved immediately and send no email.
- **Weekends are excluded** from every day count; half days are supported at the start/end of a range.
- **Pending days never count** as taken. Running totals cover approved days in the calendar year
  (a Dec 30 – Jan 2 trip is split correctly across both years).
- Vacation/PTO and Personal days count against the yearly allowance; Sick and Other are tracked
  but don't reduce it.
- Overlapping pending/approved entries for the same person are rejected.
- Every insert, edit and delete is recorded in `audit_log` with who did it and when; profile and
  account changes are logged too. Who created / last modified / reviewed each entry is also stored on the row.
- At least one active manager must always exist.

## Known limits

- Company holidays aren't excluded from day counts yet (only weekends). A `holidays` table can be
  added to `business_days()` later.
- One yearly allowance per person (applies to whichever year you're viewing); no carry-over or accrual.
- The installer isn't code-signed (Windows shows a SmartScreen prompt the first time).

## Running the database tests

Needs a local PostgreSQL 15+ (`psql` on your PATH):
```bash
PGHOST=localhost PGUSER=postgres ./tests/run-db-tests.sh
```
