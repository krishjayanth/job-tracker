import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { refresh, newId, normalizeCompany, getKv, setKv, deleteKv } from './store.js';
import { classify } from './classify.js';

const CREDENTIALS_FILE = path.resolve(process.env.GOOGLE_CREDENTIALS || 'credentials.json');
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const LOGIN_SCOPES = ['openid', 'email'];
export const INITIAL_DAYS = Number(process.env.INITIAL_SYNC_DAYS || 90);
const MAX_PER_SYNC = Number(process.env.MAX_EMAILS_PER_SYNC || 500);
export const PORT = Number(process.env.PORT || 5178);
// Where Google sends you back after signing in: PUBLIC_URL if it's a real web address,
// else the address Render gives the service (RENDER_EXTERNAL_URL), else localhost.
// Google rejects anything that isn't a proper URL ("doesn't comply with OAuth 2.0 policy").
const isWebUrl = s => /^https?:\/\/[^\s/]+\.[^\s/]+|^http:\/\/localhost(:\d+)?/.test(s || '');
export const PUBLIC_URL = [process.env.PUBLIC_URL, process.env.RENDER_EXTERNAL_URL, `http://localhost:${PORT}`]
  .find(isWebUrl).replace(/\/$/, '');
if (process.env.PUBLIC_URL && !isWebUrl(process.env.PUBLIC_URL)) {
  console.warn(`PUBLIC_URL "${process.env.PUBLIC_URL}" isn't a web address; using ${PUBLIC_URL} instead`);
}
const REDIRECT_URI = `${PUBLIC_URL}/oauth2callback`;

// Narrow the inbox down to likely application emails before classifying.
const ATS_SENDERS = [
  'greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'myworkday.com', 'ashbyhq.com',
  'smartrecruiters.com', 'icims.com', 'jobvite.com', 'workablemail.com', 'successfactors.com',
  'taleo.net', 'hackerrank.com', 'codesignal.com', 'hirevue.com', 'modernhire.com', 'jobs-noreply@linkedin.com', 'indeedapply@indeed.com',
];
const BASE_QUERY = [
  '-category:promotions -category:social -from:jobalerts-noreply@linkedin.com',
  `{subject:(application OR applying OR applied OR interview OR assessment OR offer OR candidacy OR "next steps" OR "your interest") from:(${ATS_SENDERS.join(' OR ')})}`,
].join(' ');

// Google OAuth client: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (hosted), or a
// downloaded credentials.json (local).
function oauthConfig() {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
  }
  if (!fs.existsSync(CREDENTIALS_FILE)) return null;
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  const { client_id, client_secret } = raw.web || raw.installed;
  return { clientId: client_id, clientSecret: client_secret };
}

export const gmailConfigured = () => Boolean(oauthConfig());

const newClient = () => {
  const { clientId, clientSecret } = oauthConfig();
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
};

// Sign in with Google. With withGmail, the same consent screen also asks for
// read-only Gmail access; `state` comes back to the callback so it knows which it was.
export function authUrl({ withGmail, loginHint }) {
  return newClient().generateAuthUrl({
    access_type: withGmail ? 'offline' : 'online',
    prompt: withGmail ? 'consent' : 'select_account',
    scope: withGmail ? [...LOGIN_SCOPES, GMAIL_SCOPE] : LOGIN_SCOPES,
    state: withGmail ? 'gmail' : 'login',
    ...(loginHint && { login_hint: loginHint }),
  });
}

// Who signed in (Google's stable account id and verified email), plus Gmail access
// if they granted it. Store the tokens only once the caller has let them in.
export async function handleCallback(code) {
  const client = newClient();
  const { tokens } = await client.getToken(code);
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: oauthConfig().clientId });
  const { sub, email, email_verified: verified } = ticket.getPayload();
  if (!verified) throw new Error('Google account email is not verified');
  return { sub, email, tokens, grantedGmail: (tokens.scope || '').includes(GMAIL_SCOPE) };
}

function header(msg, name) {
  return msg.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decode(data) {
  return Buffer.from(data, 'base64url').toString('utf8');
}

function htmlToText(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function bodyText(payload) {
  let plain = '', html = '';
  (function walk(part) {
    if (part.mimeType === 'text/plain' && part.body?.data && !plain) plain = decode(part.body.data);
    else if (part.mimeType === 'text/html' && part.body?.data && !html) html = decode(part.body.data);
    (part.parts || []).forEach(walk);
  })(payload);
  return plain || htmlToText(html);
}

// Gmail allows a limited number of quota units per user per minute (messages.get
// costs 5). Pace requests, and back off and retry when Google says to slow down.
const REQUEST_GAP_MS = 150;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isRateLimit(err) {
  const status = err.code ?? err.status ?? err.response?.status;
  const reasons = (err.errors || []).map(e => e.reason);
  return status === 429 ||
    (status === 403 && (reasons.some(r => /rateLimitExceeded|quotaExceeded/.test(r)) || /quota exceeded/i.test(err.message)));
}

const isInvalidGrant = err => err.message === 'invalid_grant' || err.response?.data?.error === 'invalid_grant';

async function withRetry(fn, attempts = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimit(err) || i >= attempts - 1) throw err;
      const wait = Math.min(60_000, 2_000 * 2 ** i) + Math.random() * 1000;
      console.warn(`[sync] Gmail rate limit hit, retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

class Stopped extends Error {}

// One person's Gmail connection and syncing. `user` supplies their tracker (store)
// and their Groq client (groq(), keyRejected()).
export class Mailbox {
  constructor(user) {
    this.user = user;
    this.tokenKey = `gmail_token_${user.id}`;
    this.token = null;    // stored Gmail sign-in (refresh token etc.)
    this.client = null;
    this.syncing = null;
    this.progress = null; // { mode: 'sync' | 'rescan', done, total } while working
    this.stopped = false;
    this.onProgress = () => {};
  }

  async load() {
    this.token = await getKv(this.tokenKey);
    return this;
  }

  connected() {
    return Boolean(this.token?.refresh_token || this.token?.access_token);
  }

  async saveTokens(tokens) {
    // Google only sends a refresh_token the first time, so merge rather than overwrite.
    this.token = { ...this.token, ...tokens };
    this.client = null;
    await setKv(this.tokenKey, this.token);
  }

  getClient() {
    if (this.client) return this.client;
    this.client = newClient();
    this.client.setCredentials(this.token);
    this.client.on('tokens', tokens => {
      this.token = { ...this.token, ...tokens };
      setKv(this.tokenKey, this.token).catch(err => console.error(`[gmail] saving token failed: ${err.message}`));
    });
    return this.client;
  }

  // Forget the Gmail access; with revoke, also tell Google to cancel it.
  async disconnect({ revoke = true } = {}) {
    const token = this.token?.refresh_token || this.token?.access_token;
    if (revoke && token) {
      await newClient().revokeToken(token).catch(err => console.warn(`[gmail] revoking access failed: ${err.message}`));
    }
    this.token = null;
    this.client = null;
    await deleteKv(this.tokenKey);
  }

  // Stop any sync in progress and wait for it (before deleting the account).
  async stop() {
    this.stopped = true;
    await this.syncing?.catch(() => {});
  }

  isRescanning() {
    return this.progress?.mode === 'rescan';
  }

  // Pull new matching emails, classify them, and fold them into applications.
  // Concurrent callers share the in-flight sync.
  sync() {
    if (!this.syncing) {
      this.syncing = this.drain({ mode: 'sync' }).finally(() => { this.syncing = null; this.progress = null; });
    }
    return this.syncing;
  }

  // Rebuild every Gmail-based application from scratch with the current classifier,
  // then put back everything you changed by hand. Covers your whole history (at least
  // as far back as your oldest application), not just the last INITIAL_DAYS.
  rescan() {
    const store = this.user.store;
    const job = (async () => {
      if (this.syncing) await this.syncing.catch(() => {});
      const db = store.db;
      this.progress = { mode: 'rescan', done: 0, total: 0 };
      this.onProgress();
      await store.backup('db_before_rescan');

      db.setupDone = true; // about to clear lastSync and processed; this isn't a new account
      const snapshots = store.snapshotEdits();
      const oldest = db.applications.flatMap(a => a.events).map(e => Date.parse(e.date)).reduce((m, t) => Math.min(m, t), Date.now());
      const sinceEpoch = Math.floor(Math.min(oldest, Date.now() - INITIAL_DAYS * 86_400_000) / 1000) - 86_400;

      // Manually added applications stay, minus emails that the re-scan will re-attach.
      db.applications = db.applications
        .filter(a => a.source !== 'gmail')
        .map(a => refresh({ ...a, events: a.events.filter(e => e.manual || !e.messageId) }));
      db.processed = {};
      db.lastSync = null;
      store.save();

      const result = await this.drain({ mode: 'rescan', sinceEpoch });
      const restore = store.restoreEdits(snapshots);
      store.save();
      await store.flush();
      return { ...result, ...restore, applications: db.applications.length };
    })();
    this.syncing = job.finally(() => { this.syncing = null; this.progress = null; });
    return this.syncing;
  }

  // Re-read one application's emails with the current classifier and update how each
  // was read (stage, deadline, summary). Emails stay on this application; your status
  // changes, notes and "yes, it's this one" answers are kept.
  async rescanApplication(app) {
    if (this.syncing) await this.syncing.catch(() => {});
    const gmail = google.gmail({ version: 'v1', auth: this.getClient() });
    const emails = app.events.filter(e => !e.manual && e.messageId);
    let changed = 0, notJob = 0;
    for (const e of emails) {
      const { data: msg } = await withRetry(() => gmail.users.messages.get({ userId: 'me', id: e.messageId, format: 'full' }));
      await sleep(REQUEST_GAP_MS);
      const result = await classify({
        from: header(msg, 'From'),
        subject: header(msg, 'Subject'),
        date: new Date(Number(msg.internalDate)).toISOString(),
        body: bodyText(msg.payload),
      }, { groq: this.user.groq(), onKeyRejected: () => this.user.keyRejected() });
      if (!result) { notJob++; continue; }
      const before = JSON.stringify([e.stage, e.deadline, e.summary]);
      e.stage = result.stage;
      for (const key of ['deadline', 'summary', 'reasoning']) {
        if (result[key]) e[key] = result[key]; else delete e[key];
      }
      // Which application it belongs to was settled when you confirmed it.
      const review = e.reviewed ? result.review.filter(r => r.about !== 'application') : result.review;
      if (review.length) e.review = review; else delete e.review;
      if (!app.edited?.role && !app.role && result.role) app.role = result.role;
      if (!app.edited?.jobId && !app.jobId && result.jobId) app.jobId = result.jobId;
      if (JSON.stringify([e.stage, e.deadline, e.summary]) !== before) changed++;
    }
    refresh(app);
    this.user.store.save();
    return { emails: emails.length, changed, notJob };
  }

  // Keep going in batches until the backlog (e.g. the first 90-day scan) is cleared.
  async drain(opts) {
    let added = 0, scanned = 0, result;
    do {
      result = await this.runSync(opts);
      added += result.added ?? 0;
      scanned += result.scanned ?? 0;
    } while (result.remaining > 0);
    return { ...result, added, scanned };
  }

  async runSync({ mode, sinceEpoch } = {}) {
    const store = this.user.store;
    const db = store.db;
    if (!this.connected() || this.stopped) return { added: 0, skipped: true };
    if (this.user.needsSetup()) return { added: 0, skipped: true, needsSetup: true };
    db.setupDone = true; // a sync that runs means the choice was made (a re-scan clears lastSync)
    const gmail = google.gmail({ version: 'v1', auth: this.getClient() });

    // Re-scan a day of overlap so nothing slips between syncs; processed ids dedupe.
    const since = db.lastSync
      ? `after:${Math.floor(Date.parse(db.lastSync) / 1000) - 86_400}`
      : sinceEpoch ? `after:${sinceEpoch}` : `newer_than:${INITIAL_DAYS}d`;
    const q = `${since} ${BASE_QUERY}`;

    try {
      const ids = [];
      let pageToken;
      do {
        const res = await withRetry(() => gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken }));
        ids.push(...(res.data.messages || []).map(m => m.id));
        pageToken = res.data.nextPageToken;
      } while (pageToken);

      // Gmail lists newest first; process oldest first so timelines build in order.
      // Emails from applications you deleted stay deleted.
      const unprocessed = ids.filter(id => !db.processed[id] && !db.ignored[id]).reverse();
      const batch = unprocessed.slice(0, MAX_PER_SYNC);
      if (batch.length) {
        const done = this.progress?.mode === mode ? this.progress.done : 0;
        this.progress = { mode, done, total: done + unprocessed.length };
        this.onProgress();
      }

      let added = 0;
      for (const id of batch) {
        if (this.stopped) throw new Stopped();
        if (this.progress) {
          this.progress.done++;
          if (this.progress.done % 5 === 0) this.onProgress();
        }
        const { data: msg } = await withRetry(() => gmail.users.messages.get({ userId: 'me', id, format: 'full' }));
        await sleep(REQUEST_GAP_MS);
        const email = {
          from: header(msg, 'From'),
          subject: header(msg, 'Subject'),
          date: new Date(Number(msg.internalDate)).toISOString(),
          body: bodyText(msg.payload),
        };
        const result = await classify(email, { groq: this.user.groq(), onKeyRejected: () => this.user.keyRejected() });
        // Saved per message so an interrupted sync resumes where it left off.
        db.processed[msg.id] = true;
        if (!result) {
          store.save();
          continue;
        }

        const { company, role, jobId = '' } = result;
        let review = result.review;
        // An email you've already filed yourself goes where you said.
        let app = store.assignedApplication(msg.id);
        const assigned = Boolean(app);
        if (!app) {
          const match = store.matchApplication({ threadId: msg.threadId, company, role, jobId });
          // A reply in a thread you already have settles which application it is.
          if (match.thread) review = review.filter(r => r.about !== 'application');
          if (match.guess) review.push({ about: 'application', text: `You have several applications at ${match.app.company}, and this email doesn't say which job it's about.` });
          app = match.app || store.createApplication({ company, role, jobId, source: 'gmail' });
          if (!app.role && role) app.role = role;
          if (!app.jobId && jobId) app.jobId = jobId;
          // "CapitalOne" (from a sender address) -> "Capital One" (from a subject), unless you renamed it.
          if (!app.renamed && !/\s/.test(app.company) && /\s/.test(result.company) &&
              normalizeCompany(app.company) === normalizeCompany(result.company)) {
            app.company = result.company;
          }
        }
        app.events.push({
          id: newId(), date: email.date, stage: result.stage, subject: email.subject,
          from: email.from, snippet: msg.snippet, messageId: msg.id, threadId: msg.threadId, jobId,
          ...(result.deadline && { deadline: result.deadline }),
          ...(result.summary && { summary: result.summary }),
          ...(result.reasoning && { reasoning: result.reasoning }),
          ...(review.length && { review }),
          ...(assigned && { reviewed: true }),
        });
        refresh(app);
        added++;
        store.save();
      }

      // Only advance the sync window once the backlog is cleared; otherwise the next
      // run's narrower query would skip older emails still waiting to be processed.
      const remaining = unprocessed.length - batch.length;
      if (remaining === 0) db.lastSync = new Date().toISOString();
      db.lastSyncError = null;
      store.save();
      return { added, scanned: batch.length, remaining };
    } catch (err) {
      if (err instanceof Stopped) return { added: 0, stopped: true };
      // Google revoked or expired the refresh token. Forget it so the next sign-in
      // asks for Gmail access again instead of reusing the dead token.
      if (isInvalidGrant(err)) {
        await this.disconnect({ revoke: false });
        db.lastSyncError = 'Google sign-in for Gmail expired or was revoked';
      } else {
        db.lastSyncError = err.message;
      }
      store.save();
      throw err;
    }
  }
}
