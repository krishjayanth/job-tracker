import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { DATA_DIR, getDb, save, createApplication, findApplication, refresh, newId, normalizeCompany } from './store.js';
import { classify } from './classify.js';

const CREDENTIALS_FILE = path.resolve(process.env.GOOGLE_CREDENTIALS || 'credentials.json');
const TOKEN_FILE = path.join(DATA_DIR, 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const INITIAL_DAYS = Number(process.env.INITIAL_SYNC_DAYS || 90);
const MAX_PER_SYNC = Number(process.env.MAX_EMAILS_PER_SYNC || 500);
export const PORT = Number(process.env.PORT || 5178);
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

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

let oauthClient = null;

export function gmailConfigured() {
  return fs.existsSync(CREDENTIALS_FILE);
}

export function gmailConnected() {
  return fs.existsSync(TOKEN_FILE);
}

function getClient() {
  if (oauthClient) return oauthClient;
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  const { client_id, client_secret } = raw.installed || raw.web;
  oauthClient = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
  if (fs.existsSync(TOKEN_FILE)) oauthClient.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
  // Google only sends a refresh_token the first time, so merge rather than overwrite.
  oauthClient.on('tokens', tokens => {
    const prev = fs.existsSync(TOKEN_FILE) ? JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) : {};
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...prev, ...tokens }, null, 2));
  });
  return oauthClient;
}

export function authUrl() {
  return getClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
}

export async function handleCallback(code) {
  const client = getClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

export function disconnect() {
  fs.rmSync(TOKEN_FILE, { force: true });
  oauthClient = null;
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

// Pull new matching emails, classify them, and fold them into applications.
// Concurrent callers share the in-flight sync.
export function sync() {
  if (!syncing) syncing = drain().finally(() => { syncing = null; });
  return syncing;
}

// Keep going in batches until the backlog (e.g. the first 90-day scan) is cleared.
async function drain() {
  let added = 0, scanned = 0, result;
  do {
    result = await runSync();
    added += result.added ?? 0;
    scanned += result.scanned ?? 0;
  } while (result.remaining > 0);
  return { ...result, added, scanned };
}

async function runSync() {
  const db = getDb();
  if (!gmailConnected()) return { added: 0, skipped: true };
  const gmail = google.gmail({ version: 'v1', auth: getClient() });

  // Re-scan a day of overlap so nothing slips between syncs; processed ids dedupe.
  const since = db.lastSync
    ? `after:${Math.floor(Date.parse(db.lastSync) / 1000) - 86_400}`
    : `newer_than:${INITIAL_DAYS}d`;
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
    const unprocessed = ids.filter(id => !db.processed[id]).reverse();
    const batch = unprocessed.slice(0, MAX_PER_SYNC);

    let added = 0;
    for (const id of batch) {
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
