# Deploying nuj

nuj runs on free tiers: **Render** for the web service, **Supabase** for Postgres, **Groq** for the email
classifier and a **Google Cloud** OAuth client for sign-in and read-only Gmail access. Setup takes about 15 minutes.

To just look around, you don't need any of this: `npm install && npm run demo` runs it locally with sample data.

## 1. Database: Supabase
1. Sign up at https://supabase.com and create a project. Pick the region nearest your Render service (Render's
   default is Oregon, so **West US**). Save the database password it asks you to set.
2. Click **Connect** at the top of the project and copy the **Session pooler** connection string. It looks like
   `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-us-west-1.pooler.supabase.com:5432/postgres`. Put your
   password in place of `[YOUR-PASSWORD]`. Use the session pooler, not the direct connection: the direct one is
   IPv6 only, which Render can't reach.
3. In **Project Settings › Database › SSL Configuration**, download the certificate (`prod-ca-2021.crt`) and turn
   on **Enforce SSL on incoming connections**. Supabase signs its own certificate, so nuj needs this file to check
   it is really talking to your database (step 3 says where it goes).

The app creates its one table (`app_state`) on first start, with row-level security turned on. That matters on
Supabase: it offers every table through its public API, and with RLS on and no policies, that API can't read the
table, which holds everyone's Gmail sign-ins. nuj connects as the table's owner, which RLS doesn't restrict.

Neon works too: use its connection string (it ends in `?sslmode=require`) and leave `DATABASE_CA` unset.

## 2. Email classifier: Groq
Each person adds their own free Groq API key in the app (Settings › AI email sorting, or when they first connect Gmail), so everyone gets their own
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
   - `DATABASE_URL`: the Supabase session pooler connection string
   - `DATABASE_CA`: `/etc/secrets/supabase-ca.crt`, then under **Environment › Secret Files** add a file named
     `supabase-ca.crt` with the contents of the certificate from step 1
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
delete their account in Settings.

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

## Moving from Neon to Supabase
nuj keeps everything in one table, so moving is a copy of that table while the site is paused. It takes about
ten minutes, and nothing is lost: applications, edits, Gmail sign-ins, Groq keys, feedback and errors all move.

1. **Set up Supabase** as in step 1 above: the project, the session pooler connection string and the certificate.
2. **Pause the site.** In Render, open the service, then **Settings › Suspend Web Service**. It saves anything
   waiting to be written before it stops, so the copy gets everything. The cron pinger fails while it's suspended;
   that's fine.
3. **Copy the data** from your computer, with the Neon string from Render's Environment tab, the Supabase string
   and the path to the downloaded certificate. In PowerShell:

   ```powershell
   $env:SOURCE_DATABASE_URL = "postgresql://...neon.tech/neondb?sslmode=require"
   $env:DATABASE_URL = "postgresql://postgres.abcdefgh:PASSWORD@aws-0-us-west-1.pooler.supabase.com:5432/postgres"
   $env:DATABASE_CA = "C:\Users\you\Downloads\prod-ca-2021.crt"
   npm run copy-db
   ```

   Or in bash: `SOURCE_DATABASE_URL=... DATABASE_URL=... DATABASE_CA=~/Downloads/prod-ca-2021.crt npm run copy-db`.

   It copies every row in one go, checks each one against Neon, and prints what it moved (for example
   `Copied and checked 14 rows: 3 trackers, 3 Gmail sign-ins, 2 Groq keys, 1 backups, 5 other`). Neon is only
   read, never changed. If Supabase already has data, it stops; add `-- --force` to replace it.
4. **Point Render at Supabase.** In **Environment**, set `DATABASE_URL` to the Supabase string and `DATABASE_CA`
   to `/etc/secrets/supabase-ca.crt`, and add the Secret File `supabase-ca.crt` with the certificate's contents.
   Save, then **Resume Web Service**.
5. **Check it.** The log should say `Storage: Postgres` with no `[storage]` warning. Sign in: your applications
   should all be there, and the Developer page should list everyone.
6. **Keep Neon for a week**, then delete the Neon project. To go back before then, set `DATABASE_URL` back to Neon
   and remove `DATABASE_CA`; anything written to Supabase in the meantime stays behind.

Supabase pauses free projects after a week without activity. nuj's syncs write every few minutes while the pinger
keeps the site awake, so that shouldn't happen. If it does, restore the project from the Supabase dashboard.

## Moving local data to the database (optional)
If you've been running it locally, copy your tracker into the database once:

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
| `DATABASE_CA` | — | The database's certificate (the PEM text, or a path to the file) when a public authority doesn't sign it, as on Supabase |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth web client |
| `GROQ_API_KEY` | — | Groq key for the owner only; everyone else adds their own in the app |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Groq model |
| `GROQ_REASONING_EFFORT` | `medium` | `low` uses fewer tokens per email, but reads tricky emails less carefully |
| `GROQ_GATE_MODEL` | `llama-3.1-8b-instant` | Small model that checks whether an unclear email is about a job before the full read. If Groq retires it, nuj uses `GROQ_MODEL` for the check instead and notes it on the Developer page; set this to another small model from Groq's model list to go back to a cheap one |
| `CRON_SECRET` | — | Key for `/api/cron/sync` (16+ characters) |
| `SYNC_INTERVAL_MINUTES` | 5 | How often Gmail is checked while awake |
| `INITIAL_SYNC_DAYS` | 90 | How far back the first sync looks |
| `GHOST_AFTER_DAYS` | 21 | Days of silence before "No response" |
| `MAX_EMAILS_PER_SYNC` | 500 | Batch size per sync pass |
