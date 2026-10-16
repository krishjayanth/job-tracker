# Deploying Job Tracker

Job Tracker runs on free tiers: **Render** for the web service, **Neon** for Postgres, **Groq** for the email
classifier and a **Google Cloud** OAuth client for sign-in and read-only Gmail access. Setup takes about 15 minutes.

To just look around, you don't need any of this: `npm install && npm run demo` runs it locally with sample data.

## 1. Database: Neon
1. Sign up at https://neon.tech and create a project (any name, nearest region).
2. Copy the **connection string**. It looks like `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`.

The app creates its one table (`app_state`) on first start.

## 2. Email classifier: Groq
Sign up at https://console.groq.com and create an **API key**. This is optional: without it, every email is
classified by the built-in rules.

## 3. Web service: Render
1. Fork this repository (or push your clone to your own GitHub account).
2. In Render: **New › Blueprint**, then pick the repository. It reads [`render.yaml`](../render.yaml).
3. Fill in the values it asks for:
   - `ALLOWED_EMAIL`: the Gmail address you'll sign in with
   - `DATABASE_URL`: the Neon connection string
   - `GROQ_API_KEY`: from step 2
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: put `x` for now and fill them in after step 4

   `SESSION_SECRET` and `CRON_SECRET` are generated for you, and the site's address comes from Render automatically.
4. Once it deploys, note the site address at the top of the service, e.g. `https://job-tracker-ab12.onrender.com`.

## 4. Google sign-in and Gmail access
1. In the [Google Cloud console](https://console.cloud.google.com), create a project and enable the **Gmail API**
   (APIs & Services › Library › Gmail API › Enable).
2. **Google Auth Platform › Clients › Create client**, and choose **Web application**.
3. Under **Authorized redirect URIs**, add `https://<your-site>.onrender.com/oauth2callback`.
   To run it locally too, also add `http://localhost:5178/oauth2callback`.
4. Copy the **Client ID** and **Client secret** into Render's `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
   Render redeploys automatically.
5. **Audience:** either click **Publish app**, or keep it in Testing and add yourself as a test user. In Testing
   mode, Google expires the Gmail sign-in every 7 days. A published personal app shows an "unverified app" warning,
   which you can get past with *Advanced › Go to …*.

## 5. Sign in
Open your Render URL and click **Sign in with Google**. The first time, Google also asks for read-only Gmail access.
Syncing starts on its own after that, beginning with the last 90 days of email.

## 6. Keep it awake (free tier)
Free Render services sleep after 15 minutes without visitors, which pauses syncing. Create a free job at
https://cron-job.org that requests this URL every 10 minutes:

```
https://<your-site>.onrender.com/api/cron/sync?key=<CRON_SECRET>
```

Copy `CRON_SECRET` from Render's Environment tab. This keeps the service awake and syncing. It fits within Render's
free 750 hours a month as long as it's your only free service.

## Moving local data to the database (optional)
If you've been running it locally, copy your tracker into Neon once:

```bash
DATABASE_URL="postgresql://..." npm run migrate
```

## Running locally against your own Gmail

```bash
npm install
cp .env.example .env   # add GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET at minimum
npm start
```

Open http://localhost:5178. Without `DATABASE_URL`, data is stored in `data/`. Without `ALLOWED_EMAIL` there's no
sign-in, so only run it that way on your own machine. (The server only listens on `127.0.0.1` locally.)

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | Render's address, or `http://localhost:5178` | Site address for Google redirects. Only needed for a custom domain |
| `ALLOWED_EMAIL` | — | Google account(s) allowed to sign in, comma-separated. **Required when hosted** |
| `SESSION_SECRET` | — | Random string, 32+ characters (required with `ALLOWED_EMAIL`) |
| `DATABASE_URL` | — | Postgres connection string. Unset means local files |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth web client |
| `GROQ_API_KEY` | — | Enables the Groq classifier |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Groq model |
| `CRON_SECRET` | — | Key for `/api/cron/sync` (16+ characters) |
| `SYNC_INTERVAL_MINUTES` | 5 | How often Gmail is checked while awake |
| `INITIAL_SYNC_DAYS` | 90 | How far back the first sync looks |
| `GHOST_AFTER_DAYS` | 21 | Days of silence before "No response" |
| `MAX_EMAILS_PER_SYNC` | 500 | Batch size per sync pass |
