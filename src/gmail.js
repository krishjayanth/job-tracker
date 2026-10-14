import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import {
  getDb, save, flush, createApplication, findApplication, refresh, newId, normalizeCompany,
  snapshotEdits, restoreEdits, backup, getKv, setKv, deleteKv,
} from './store.js';
import { classify } from './classify.js';

const CREDENTIALS_FILE = path.resolve(process.env.GOOGLE_CREDENTIALS || 'credentials.json');
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const LOGIN_SCOPES = ['openid', 'email'];
const INITIAL_DAYS = Number(process.env.INITIAL_SYNC_DAYS || 90);
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
  'taleo.net', 'hackerrank.com', 'codesignal.com', 'jobs-noreply@linkedin.com', 'indeedapply@indeed.com',
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

let gmailToken = null;   // stored Gmail sign-in (refresh token etc.)
let gmailClient = null;

export async function initGmail() {
  gmailToken = await getKv('gmail_token');
}

export const gmailConnected = () => Boolean(gmailToken?.refresh_token || gmailToken?.access_token);

function getClient() {
  if (gmailClient) return gmailClient;
  gmailClient = newClient();
  gmailClient.setCredentials(gmailToken);
  // Google only sends a refresh_token the first time, so merge rather than overwrite.
  gmailClient.on('tokens', tokens => {
    gmailToken = { ...gmailToken, ...tokens };
    setKv('gmail_token', gmailToken).catch(err => console.error(`[gmail] saving token failed: ${err.message}`));
  });
  return gmailClient;
}

// One Google sign-in does both jobs: proves who you are (openid/email) and, when
// Gmail isn't connected yet, grants read-only Gmail access.
export function authUrl({ withGmail }) {
  return newClient().generateAuthUrl({
    access_type: withGmail ? 'offline' : 'online',
    prompt: withGmail ? 'consent' : 'select_account',
    scope: withGmail ? [...LOGIN_SCOPES, GMAIL_SCOPE] : LOGIN_SCOPES,
  });
}

// Returns the verified email of whoever signed in; stores Gmail access if granted.
export async function handleCallback(code) {
  const client = newClient();
  const { tokens } = await client.getToken(code);
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: oauthConfig().clientId });
  const { email, email_verified: verified } = ticket.getPayload();
  if (!verified) throw new Error('Google account email is not verified');
  return {
    email,
    // Only call this once the caller has checked the email is allowed in.
    saveGmail: async () => {
      if (!(tokens.scope || '').includes(GMAIL_SCOPE)) return;
      gmailToken = { ...gmailToken, ...tokens };
      gmailClient = null;
      await setKv('gmail_token', gmailToken);
    },
  };
}

export async function disconnect() {
  gmailToken = null;
  gmailClient = null;
  await deleteKv('gmail_token');
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

let syncing = null;
let progress = null; // { mode: 'sync' | 'rescan', done, total } while working
let progressListener = () => {};

export const getProgress = () => progress;
export const onProgress = fn => { progressListener = fn; };

// Pull new matching emails, classify them, and fold them into applications.
// Concurrent callers share the in-flight sync.
export function sync() {
  if (!syncing) syncing = drain({ mode: 'sync' }).finally(() => { syncing = null; progress = null; });
  return syncing;
}

export const isRescanning = () => progress?.mode === 'rescan';

// Rebuild every Gmail-based application from scratch with the current classifier,
// then put back everything you changed by hand. Covers your whole history (at least
// as far back as your oldest application), not just the last INITIAL_DAYS.
export function rescan() {
  const job = (async () => {
    if (syncing) await syncing.catch(() => {});
    const db = getDb();
    progress = { mode: 'rescan', done: 0, total: 0 };
    progressListener();
    await backup('db_before_rescan');

    const snapshots = snapshotEdits();
    const oldest = db.applications.flatMap(a => a.events).map(e => Date.parse(e.date)).reduce((m, t) => Math.min(m, t), Date.now());
    const sinceEpoch = Math.floor(Math.min(oldest, Date.now() - INITIAL_DAYS * 86_400_000) / 1000) - 86_400;

    // Manually added applications stay, minus emails that the re-scan will re-attach.
    db.applications = db.applications
      .filter(a => a.source !== 'gmail')
      .map(a => refresh({ ...a, events: a.events.filter(e => e.manual || !e.messageId) }));
    db.processed = {};
    db.lastSync = null;
    save();

    const result = await drain({ mode: 'rescan', sinceEpoch });
    const restore = restoreEdits(snapshots);
    save();
    await flush();
    return { ...result, ...restore, applications: db.applications.length };
  })();
  syncing = job.finally(() => { syncing = null; progress = null; });
  return syncing;
}

// Keep going in batches until the backlog (e.g. the first 90-day scan) is cleared.
async function drain(opts) {
  let added = 0, scanned = 0, result;
  do {
    result = await runSync(opts);
    added += result.added ?? 0;
    scanned += result.scanned ?? 0;
  } while (result.remaining > 0);
  return { ...result, added, scanned };
}

async function runSync({ mode, sinceEpoch } = {}) {
  const db = getDb();
  db.ignored ??= {};
  if (!gmailConnected()) return { added: 0, skipped: true };
  const gmail = google.gmail({ version: 'v1', auth: getClient() });

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
      progress = { mode, done: progress?.mode === mode ? progress.done : 0, total: (progress?.mode === mode ? progress.done : 0) + unprocessed.length };
      progressListener();
    }

    let added = 0;
    for (const id of batch) {
      if (progress) {
        progress.done++;
        if (progress.done % 5 === 0) progressListener();
      }
      const { data: msg } = await withRetry(() => gmail.users.messages.get({ userId: 'me', id, format: 'full' }));
      await sleep(REQUEST_GAP_MS);
      const email = {
        from: header(msg, 'From'),
        subject: header(msg, 'Subject'),
        date: new Date(Number(msg.internalDate)).toISOString(),
        body: bodyText(msg.payload),
      };
      const result = await classify(email);
      // Saved per message so an interrupted sync resumes where it left off.
      db.processed[msg.id] = true;
      if (!result) {
        save();
        continue;
      }

      const { company, role, jobId = '' } = result;
      let app = findApplication({ threadId: msg.threadId, company, role, jobId });
      if (!app) app = createApplication({ company, role, jobId, source: 'gmail' });
      if (!app.role && role) app.role = role;
      if (!app.jobId && jobId) app.jobId = jobId;
      // "CapitalOne" (from a sender address) -> "Capital One" (from a subject), unless you renamed it.
      if (!app.renamed && !/\s/.test(app.company) && /\s/.test(result.company) &&
          normalizeCompany(app.company) === normalizeCompany(result.company)) {
        app.company = result.company;
      }
      app.events.push({
        id: newId(), date: email.date, stage: result.stage, subject: email.subject,
        from: email.from, snippet: msg.snippet, messageId: msg.id, threadId: msg.threadId, jobId,
        ...(result.deadline && { deadline: result.deadline }),
      });
      refresh(app);
      added++;
      save();
    }

    // Only advance the sync window once the backlog is cleared; otherwise the next
    // run's narrower query would skip older emails still waiting to be processed.
    const remaining = unprocessed.length - batch.length;
    if (remaining === 0) db.lastSync = new Date().toISOString();
    db.lastSyncError = null;
    save();
    return { added, scanned: batch.length, remaining };
  } catch (err) {
    db.lastSyncError = err.message;
    save();
    throw err;
  }
}
