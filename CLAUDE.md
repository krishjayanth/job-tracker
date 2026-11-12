# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

nuj is a job-application tracker that reads a person's Gmail (read-only), classifies application emails, and
groups them into applications. README.md covers features and the sync pipeline in depth; docs/DEPLOY.md lists
every environment variable.

## Commands

```bash
npm run demo        # sample data in memory, no Gmail/sign-in, http://localhost:5178 (best way to see UI changes)
npm run dev         # node --watch with .env
npm start           # real run with .env (needs GOOGLE_CLIENT_ID/SECRET)
npm test            # all suites: node --test "test/*.test.js"
node --test test/store.test.js                          # one file
node --test --test-name-pattern="findApplication" test/store.test.js   # one test by name
npm run eval        # score the rules classifier on test/fixtures/emails.json
npm run eval -- --groq   # also score Groq (needs GROQ_API_KEY)
```

`.claude/launch.json` defines `nuj` and `nuj-demo` preview servers (port 5178). There is no build step, linter
or bundler. CI (`.github/workflows/ci.yml`) runs `npm test` on Node 22 and 24, then boots `--demo` and checks
`/healthz` and that `/api/state` returns 30+ applications — keep demo data (`src/demo.js`) above that.

## Architecture

Node 22+ ES modules, Express 5, one process. Frontend is vanilla JS in `public/js/`: plain (non-module) scripts
loaded in order by `index.html`, sharing one global scope, so top-level code may only use what an earlier file
defines (functions called later can use anything). D3 is served from `node_modules` via `/vendor/*`. No framework.

- **`server.js`** holds every route. Order matters: public routes (`/healthz`, `public-site/` landing pages,
  `/login`, OAuth callback, `/api/cron/sync`, `/cal/:file` calendar feed) come first, then `requireLogin`, then
  the dashboard (`public/`) and `/api/*`. Owner-only routes use the `ownerOnly` middleware (which also lets anyone through in demo mode).
- **Per-user isolation.** A middleware sets `req.account` (a `User` from `src/users.js`) for every `/api` call;
  handlers must only touch `req.account.store` / `req.account.mailbox`. Users are keyed by Google's `sub`;
  without `ALLOWED_EMAIL` there's one user `local`, in demo mode `demo`. The owner is the first
  `ALLOWED_EMAIL` (or `local`) and is the only one who can use the server's `GROQ_API_KEY` and see Reports.
- **Storage (`src/store.js`).** A key-value table of JSON values: Postgres `app_state` when `DATABASE_URL` is set,
  else files in `data/`, else memory (demo/tests). Each tracker is one document `db_<userId>` held in memory by
  a `Store`; mutate `store.db` then call `store.save()` (debounced write; `flushAll()` on SIGTERM). Shared
  data (user registry, reports, access requests, calendar-feed tokens) goes through `getKv`/`setKv`, with
  read-modify-write serialized through a promise chain (see `src/access.js`, `src/users.js`). Hosted on
  Supabase: connect through `poolOptions()` (it applies `DATABASE_CA`, Supabase's own certificate) and keep
  row-level security on `app_state` and `app_files` (`prepareTable()`), since Supabase exposes public tables through its API.
  Binary files (resume PDFs) go through `getFile`/`setFile` into `app_files` (`bytea`; `.bin` files in `data/`), not as base64 JSON.
  `npm run copy-db` copies every row between two databases (`SOURCE_DATABASE_URL` → `DATABASE_URL`).
- **Status is derived, never stored directly.** After changing an application's events, call `refresh(app)`;
  it recomputes `status` (via `computeStatus` in `src/stages.js`), dates, deadline and `needsReview`. Manual
  edits are events with `manual: true` and always win. `stagePath` builds the Sankey path and must stay acyclic.
- **Sorting pipeline.** `src/gmail.js` `Mailbox` lists/fetches messages (resumable: each message recorded in
  `db.processed`), then `src/classify.js` runs the job check (`src/jobcheck.js`), Groq (`src/groq.js`) or the
  rules (`src/rules.js`), and `mergeWithRules` treats LLM output as untrusted (company/job ID must literally
  appear in the email; rules' offer/rejection override). `Store.matchApplication` files the email to an
  application. Without a Groq key everything falls back to rules.
- **Resume insights' AI (`src/ai.js`).** nuj doesn't judge resumes itself: OpenAI writes the review (score, rubric,
  XYZ bullet audit) and the tailoring (Check fit / Check a job), and `checkReview`/`checkFit` keep only what holds up
  (quoted lines really in the resume, keywords really in the posting, no rewrite adding numbers). Only the outcome
  grouping in `src/insights.js` is worked out on the server. Sending OpenAI anything new means raising
  `CONSENT_VERSION` (everyone is asked again) and updating the consent dialog and privacy policy.
- **Re-scan keeps hand edits.** `Store.snapshotEdits()` / `restoreEdits()` re-attach edits by Gmail message ID
  after rebuilding applications. Anything new a user can edit must be included there to survive a re-scan.
  While `db.rescanStartedAt` is set, the `db_before_rescan_<id>` backup is the only good copy: a failed re-scan
  reverts to the pre-scan state, and `Mailbox.recoverRescan()` restores the backup on load after a restart.
- **Live updates.** Any change should end with `broadcast(user.id)` (SSE `data: update`), which makes open tabs
  refetch `/api/state` (the page merges overlapping loads). Undo-able actions use `store.checkpoint(...)` and
  return an undo token; checkpoints are saved in the tracker (`db.undo`), so they survive a restart.
- **Input.** Check request fields with `textFields` (`src/input.js`) before changing anything, so a bad field
  never leaves an application half-updated. Links must be http(s).
- **Memory.** Idle trackers are released (`releaseIdleUsers`); work that waits its turn on a user bumps
  `user.holds` so it isn't released meanwhile. Don't keep `User` objects past a request or task.
- **Errors and the Developer page.** Call `recordError(source, err, { userId, level, detail })` from
  `src/errors.js` where something fails; it groups by a fingerprint of the message, strips email addresses and
  never throws. The owner-only `/api/dev/overview` combines it with `accountSummary()` (`src/accounts.js`). Keep
  that page to counts and dates: the privacy policy promises no one reads others' applications or emails.
- **Releases.** `src/releases.js`: bump `LATEST_RELEASE.id` to show a "What's new" once (copy written for users,
  not developers); change `RESCAN_ID` to re-read everyone's (non-owner) emails once after a sorting change.

## Conventions

- Tests use `node:test` + `node:assert/strict` only, no test dependencies; Groq is replaced by a stand-in
  client, storage by `initStorage({ inMemory: true })` or `new Store('db_test')`.
- Sorting fixes are test-first: add the misread email (anonymized, fictional company) to
  `test/fixtures/emails.json`, which the rules must sort with no misses.
- User-facing text (UI, error messages returned by the API, release notes) is plain, non-technical wording.
  Commit subjects follow the same style ("Let the owner re-scan one account from its problem report").
- Comments explain *why* in full sentences; match that density.
- `.impeccable/config.json` records accepted design-checker exceptions (Geist font, the landing-page shimmer).
  The dashboard and landing page (`public-site/`) share Geist and CSS custom-property themes for light/dark.
