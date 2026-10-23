# Deploying nuj

nuj runs on free tiers: **Render** for the web service, **Neon** for Postgres, **Groq** for the email
classifier and a **Google Cloud** OAuth client for sign-in and read-only Gmail access. Setup takes about 15 minutes.

To just look around, you don't need any of this: `npm install && npm run demo` runs it locally with sample data.

## 1. Database: Neon
1. Sign up at https://neon.tech and create a project (any name, nearest region).
2. Copy the **connection string**. It looks like `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`.

The app creates its one table (`app_state`) on first start.

## 2. Email classifier: Groq
Each person adds their own free Groq API key in the app (⋯ menu › Groq API key), so everyone gets their own
free-tier allowance. Without one, their emails are sorted by the built-in rules. The key is checked with Groq
when it's saved, stored encrypted with `SESSION_SECRET`, and never sent back to the browser. (If you change
`SESSION_SECRET`, saved keys can't be read and people are asked to add them again.)

Optionally, sign up at https://console.groq.com and create a key for the server's `GROQ_API_KEY`. It's used only
for the owner (the first `ALLOWED_EMAIL`), and only until they add a key of their own.

## 3. Web service: Render
1. Fork this repository (or push your clone to your own GitHub account).
2. In Render: **New › Blueprint**, then pick the repository. It reads [`render.yaml`](../render.yaml).
3. Fill in the values it asks for:
   - `ALLOWED_EMAIL`: the Gmail addresses allowed to sign in, comma-separated, yours first (see step 6)
   - `DATABASE_URL`: the Neon connection string
   - `GROQ_API_KEY`: optional, from step 2
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: put `x` for now and fill them in after step 4

   `SESSION_SECRET` and `CRON_SECRET` are generated for you, and the site's address comes from Render automatically.
4. Once it deploys, note the site address at the top of the service. The Blueprint names the service `nuj`, so
   the address is `https://nuj.onrender.com`. Addresses are first come, first served: if `nuj` is taken, Render
   adds a suffix (e.g. `https://nuj-ab12.onrender.com`), so use whatever Render shows in the steps below.
   Render sets the address when the service is created; renaming the service later doesn't change it.

## 4. Google sign-in and Gmail access
1. In the [Google Cloud console](https://console.cloud.google.com), create a project and enable the **Gmail API**
   (APIs & Services › Library › Gmail API › Enable).
2. **Google Auth Platform › Clients › Create client**, and choose **Web application**.
3. Under **Authorized redirect URIs**, add `https://nuj.onrender.com/oauth2callback`.
   To run it locally too, also add `http://localhost:5178/oauth2callback`.
4. Copy the **Client ID** and **Client secret** into Render's `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
   Render redeploys automatically.
5. **Audience:** either click **Publish app**, or keep it in Testing and add yourself as a test user. In Testing
   mode, Google expires the Gmail sign-in every 7 days. A published personal app shows an "unverified app" warning,
   which you can get past with *Advanced › Go to …*.
6. **Branding:** set the app's links to the public pages:
   - Home page: `https://nuj.onrender.com/welcome`
   - Privacy policy: `https://nuj.onrender.com/privacy`
   - Terms of service: `https://nuj.onrender.com/terms`

## 5. Sign in
Open https://nuj.onrender.com and click **Sign in with Google**. The first time, Google also asks for read-only Gmail access.

## 6. Inviting friends
Everyone in `ALLOWED_EMAIL` gets their own tracker, Gmail connection and Groq key; nobody can see anyone else's.
To invite someone, add their Gmail address to `ALLOWED_EMAIL` on Render (comma-separated; keep yours first) and
send them the link. Removing someone stops them signing in and stops their syncing; their data stays until they
delete their account from the ⋯ menu.

Google limits apps that read Gmail and haven't been through its verification:
- In **Testing**, only the test users you list (up to 100) can sign in, and Gmail access expires every 7 days.
- **Published but unverified**, up to 100 people can sign in after clicking through the "unverified app" warning.
- Beyond that, Google requires verification, including a yearly third-party security assessment.

**Upgrading from single-user nuj:** your existing tracker and Gmail connection move to the first address in
`ALLOWED_EMAIL` the first time you sign in, and a copy is kept as `db_before_accounts`. Everyone is signed out
once by the upgrade. Background syncing for each person starts after they've signed in once.
Syncing starts on its own after that, beginning with the last 90 days of email.

## 6. Keep it awake (free tier)
Free Render services sleep after 15 minutes without visitors, which pauses syncing. Create a free job at
https://cron-job.org that requests this URL every 10 minutes:

```
https://nuj.onrender.com/api/cron/sync?key=<CRON_SECRET>
```

Copy `CRON_SECRET` from Render's Environment tab. This keeps the service awake and syncing. It fits within Render's
free 750 hours a month as long as it's your only free service.

## Moving an existing deployment to the nuj address
A service created under another name (e.g. `job-tracker-ab12.onrender.com`) keeps that address. To move to
`nuj.onrender.com`:

1. Create a new service from this repository named `nuj` (Blueprint or **New › Web Service**).
2. Copy every environment variable from the old service, including the **same `DATABASE_URL`**, so your
   applications and Gmail connection carry over. Don't set `PUBLIC_URL`.
3. In Google Cloud, add `https://nuj.onrender.com/oauth2callback` as a redirect URI and update the branding links
   (section 4, steps 3 and 6).
4. Point the cron job (section 6) at the new address.
5. Sign in again at the new address; sign-ins don't carry across addresses.
6. Delete the old service, so two copies aren't syncing the same database.

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
| `ALLOWED_EMAIL` | — | Google accounts allowed to sign in, comma-separated; the first is the owner. **Required when hosted** |
| `SESSION_SECRET` | — | Random string, 32+ characters (required with `ALLOWED_EMAIL`). Also encrypts saved Groq keys |
| `DATABASE_URL` | — | Postgres connection string. Unset means local files |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth web client |
| `GROQ_API_KEY` | — | Groq key for the owner only; everyone else adds their own in the app |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Groq model |
| `GROQ_REASONING_EFFORT` | `medium` | `low` uses fewer tokens per email, but reads tricky emails less carefully |
| `GROQ_GATE_MODEL` | `llama-3.1-8b-instant` | Small model that checks whether an unclear email is about a job before the full read |
| `CRON_SECRET` | — | Key for `/api/cron/sync` (16+ characters) |
| `SYNC_INTERVAL_MINUTES` | 5 | How often Gmail is checked while awake |
| `INITIAL_SYNC_DAYS` | 90 | How far back the first sync looks |
| `GHOST_AFTER_DAYS` | 21 | Days of silence before "No response" |
| `MAX_EMAILS_PER_SYNC` | 500 | Batch size per sync pass |
