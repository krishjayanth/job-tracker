# Job Tracker

A job-application tracker that updates itself from Gmail. It shows a Simplify-style flow chart of where your
applications ended up, what needs your action next (assessments, interviews and deadlines), and a searchable,
editable table that you can export to Excel.

- **Hosted:** runs on Render (free tier). Data lives in Postgres on Neon (free), and you sign in with Google.
  Only your account gets in.
- **Auto-updating:** checks Gmail every few minutes (read-only access). Each application email is classified by
  **Groq** (`openai/gpt-oss-20b`) and cross-checked by built-in rules.
- **Keeps your edits:** status changes, renames, notes and deadlines survive re-scans.

## Deploy (about 15 minutes, all free)

You'll create four free accounts or resources and paste their values into Render.

### 1. Database: Neon
1. Sign up at https://neon.tech and create a project (any name, nearest region).
2. Copy the **connection string**. It looks like `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`.

### 2. Email classifier: Groq
1. Sign up at https://console.groq.com and create an **API key**.

### 3. Web service: Render
1. Push this repo to GitHub (private is fine).
2. In Render: **New › Blueprint**, then pick the repo. It reads `render.yaml`.
3. Fill in the values it asks for:
   - `ALLOWED_EMAIL`: your Gmail address (the one you'll sign in with)
   - `DATABASE_URL`: the Neon connection string
   - `GROQ_API_KEY`: from step 2
   - `PUBLIC_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: put `x` for now; you'll fill them in after step 4

   `SESSION_SECRET` and `CRON_SECRET` are generated for you.
4. After it deploys, note the site address, e.g. `https://job-tracker-ab12.onrender.com`. Set `PUBLIC_URL` to it.

### 4. Google sign-in and Gmail access
Use the Google Cloud project you already have (the Gmail API is enabled there).
1. **Google Auth Platform › Clients › Create client**, choose **Web application**.
2. Under **Authorized redirect URIs**, add `https://<your-site>.onrender.com/oauth2callback`.
   Add `http://localhost:5178/oauth2callback` too if you want to run it locally.
3. Copy the **Client ID** and **Client secret** into Render's `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
   Render redeploys automatically.
4. **Audience:** click **Publish app** (or keep it in Testing with yourself as a test user). In Testing mode,
   Google signs you out of Gmail every 7 days. A published personal app shows an "unverified app" warning;
   click *Advanced › Go to …*.

### 5. Bring over your existing data (optional)
On your PC, copy your local tracker into the database once:

```bash
DATABASE_URL="postgresql://..." npm run migrate
```

### 6. Sign in
Open your Render URL and click **Sign in with Google**. The first time, Google also asks for read-only Gmail
access. After that, syncing starts on its own.

### 7. Keep it awake (free tier)
Free Render services sleep after 15 minutes without visitors, which pauses syncing. Create a free job at
https://cron-job.org that requests this URL every 10 minutes:

```
https://<your-site>.onrender.com/api/cron/sync?key=<CRON_SECRET>
```

Copy `CRON_SECRET` from Render's Environment tab. This keeps the service awake and syncing, and fits within
Render's free 750 hours a month as long as it's your only free service.

## Run locally

```bash
npm install
cp .env.example .env   # add GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET at minimum
npm start
```

Open http://localhost:5178. Without `DATABASE_URL`, data is stored in `data/`. Without `ALLOWED_EMAIL`, there's no
sign-in, so only do that on your own machine.

## Features

- **Flow chart:** click it for a large view. Click a stage there to filter the table.
- **Needs your action:** assessments, interviews, offers and open deadlines, with the soonest first.
- **Deadlines:** found in emails ("expires in 5 days", "before Oct 9 at 11:59 PM"). Mark them done, or set your own.
- **Table:** sort by any column, change status in the row, filter by stage or month, and search by company, role
  or job ID.
- **Export:** downloads what the table shows as an `.xlsx` file, with an Applications sheet and a full email Timeline.
- **Re-scan** (⋯ menu): re-reads all your email with the current classifier and keeps your edits. On Groq's free
  tier (about 200K tokens a day), a big re-scan may sort some emails with the rules instead.

## How classification works

1. A Gmail search narrows the inbox to likely application emails: hiring-software senders, and subjects about
   applications or interviews.
2. **Groq** reads each email and returns the stage, company, role and job ID as strict JSON.
3. **Rules** (`src/rules.js`) cross-check it:
   - a company or job ID is only accepted if it appears in the email
   - the rules' rejection and offer checks win
   - codes like `fmr@myworkday.com` map to real names ("Fidelity Investments")
4. With no `GROQ_API_KEY`, or when Groq is rate limited, the rules handle the email on their own.

| Piece | File |
|---|---|
| Server, sign-in routes, API, live updates | `server.js` |
| Google sign-in sessions | `src/auth.js` |
| Gmail access and sync, re-scan | `src/gmail.js` |
| Groq classifier | `src/groq.js` |
| Groq + rules merge | `src/classify.js` |
| Rules, job IDs, deadlines, company names | `src/rules.js` |
| Storage (Postgres or local files) | `src/store.js` |
| Stage logic for status and the chart | `src/stages.js` |
| Excel export | `src/export.js` |
| Dashboard | `public/` |

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:5178` | Site address (used for Google redirects and secure cookies) |
| `ALLOWED_EMAIL` | — | Google account(s) allowed to sign in, comma-separated. **Required when hosted.** |
| `SESSION_SECRET` | — | Random string, 32+ characters (required with `ALLOWED_EMAIL`) |
| `DATABASE_URL` | — | Postgres connection string. Unset means local files |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth Web client |
| `GROQ_API_KEY` | — | Enables the Groq classifier |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Groq model |
| `CRON_SECRET` | — | Key for `/api/cron/sync` (16+ characters) |
| `SYNC_INTERVAL_MINUTES` | 5 | How often Gmail is checked while awake |
| `INITIAL_SYNC_DAYS` | 90 | How far back the first sync looks |
| `GHOST_AFTER_DAYS` | 21 | Days of silence before "No response" |
| `MAX_EMAILS_PER_SYNC` | 500 | Batch size per sync pass |
