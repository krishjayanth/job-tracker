# Job Tracker

A local job-application tracker that updates itself from Gmail. It shows a Simplify-style
flow chart (Sankey) of where your applications ended up, plus a searchable table you can edit.

- **Auto-updates from Gmail.** Every 5 minutes it checks for new application emails (confirmations, assessments,
  interview invites, offers, rejections) and moves each application to the right stage.
- **Live dashboard.** The page refreshes by itself when new emails arrive.
- **Private.** Runs only on your machine (`localhost`), with read-only Gmail access. Data lives in `data/db.json`.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:5178. It works without Gmail too: you can add applications by hand.

## Connect Gmail (one-time, ~3 minutes)

Google requires every app that reads Gmail to have its own OAuth client, so you'll create one for yourself:

1. Go to https://console.cloud.google.com/ and create a project (any name).
2. **APIs & Services → Library**, search for **Gmail API**, and click **Enable**.
3. **Google Auth Platform → Branding / OAuth consent screen**: choose **External**, enter an app name and your email.
4. **Audience → Test users**: add your Gmail address.
5. **Clients → Create client → Application type: Desktop app**, then **Download JSON**.
6. Save that file as `credentials.json` in this folder and restart `npm start`.
7. Click **Connect Gmail** in the top bar and approve read-only access.

The first sync scans the last 90 days. After that, it only fetches new mail.

> **Sign-in expires after 7 days?** Google expires sign-ins for apps in "Testing" mode after a week.
> To stop that, go to **Audience** and click **Publish app**. Google will show an "unverified app" warning
> when you sign in. That's expected for a personal app: click *Advanced → Go to (app name)*.

## Better accuracy with an LLM (optional)

Each email is read for its **stage, company, role, and job ID**. Three classifiers are available, and the tracker picks
the first one that's set up. The top bar shows which one is active.

1. **Claude**, if `ANTHROPIC_API_KEY` is set in `.env`. Most accurate, but email text is sent to Anthropic.
   Uses `claude-opus-5-5` at low effort by default; change it with `CLAUDE_MODEL`.
2. **Ollama** (local, free, private), used automatically when [Ollama](https://ollama.com) is running.
   It uses `OLLAMA_MODEL`, or the first chat model you have installed. About 1 second per email on a laptop GPU.
   Small models occasionally invent things, so a company name or job ID is only accepted if it actually appears in the
   email, and the rules' rejection and offer checks win over the model's. A bigger model (7–8B) is more accurate
   than a 2B one, if you have the VRAM.
3. **Built-in rules**, always available and used as the fallback.

Cryptic sender codes, like Workday's `fmr@myworkday.com`, are mapped to real names ("Fidelity Investments") from a
lookup table in `src/rules.js`. The LLMs also read the real name from the email body.

## How it works

| Piece | File |
|---|---|
| Web server, REST API, live updates (SSE), sync timer | `server.js` |
| Gmail OAuth + fetching matching emails | `src/gmail.js` |
| Picks a classifier (Claude → Ollama → rules) and merges results | `src/classify.js` |
| Rule-based classifier, job-ID extraction, company-code lookup | `src/rules.js` |
| Local LLM classifier | `src/ollama.js` |
| Stage ordering, status + flow-path logic | `src/stages.js` |
| JSON storage | `src/store.js` |
| Dashboard (Sankey via d3-sankey, table, editor) | `public/` |

Emails are matched to an existing application by Gmail thread, then by company (and role when known).
Stages only move forward (applied → assessment → interview → offer), except rejections and withdrawals, which always
apply. **Your manual status changes always win.** If a company name comes out odd (Workday senders sometimes give
codes like "Swa"), rename it: future emails under the old name still go to that application. Applications with no reply after 21 days show as *No response*
in the chart.

### Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 5178 | Server port (if changed, Desktop-app OAuth still works) |
| `SYNC_INTERVAL_MINUTES` | 5 | How often Gmail is checked |
| `INITIAL_SYNC_DAYS` | 90 | How far back the first sync looks |
| `GHOST_AFTER_DAYS` | 21 | Days of silence before an application counts as "No response" |
| `MAX_EMAILS_PER_SYNC` | 500 | Cap on emails processed per sync |
| `ANTHROPIC_API_KEY` | — | Enables Claude classification |
| `OLLAMA_MODEL` | first installed chat model | Ollama model to use, e.g. `qwen3.5:2b` |
| `OLLAMA_URL` | `http://localhost:11434` | Where Ollama is running |
| `USE_OLLAMA` | — | Set to `0` to ignore Ollama even when it's running |

To start over, stop the server and delete the `data/` folder.
