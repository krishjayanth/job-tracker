import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { initStore, getDb, save, flush, createApplication, refresh, newId } from './src/store.js';
import { isStage, stagePath } from './src/stages.js';
import { classifierName } from './src/classify.js';
import { buildWorkbook } from './src/export.js';
import * as gmail from './src/gmail.js';
import { authEnabled, checkAuthConfig, isAllowed, requireLogin, startSession, endSession } from './src/auth.js';

const PORT = gmail.PORT;
// On Render (or any host) listen on all interfaces; locally, only on this machine.
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const SYNC_MINUTES = Number(process.env.SYNC_INTERVAL_MINUTES || 5);
const GHOST_DAYS = Number(process.env.GHOST_AFTER_DAYS || 21);
const CRON_SECRET = process.env.CRON_SECRET || '';

const app = express();
app.set('trust proxy', 1); // Render terminates HTTPS in front of the app
app.use(express.json());

// --- public routes (no sign-in needed) ---------------------------------------
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/login', (req, res) => {
  if (!authEnabled) return res.redirect('/');
  res.sendFile(path.resolve('public-login/login.html'));
});

app.get('/logout', (req, res) => {
  endSession(res);
  res.redirect(authEnabled ? '/login' : '/');
});

// Sign in with Google. If Gmail isn't connected yet, the same consent screen also
// asks for read-only Gmail access.
app.get('/auth/google', (req, res) => {
  if (!gmail.gmailConfigured()) {
    return res.status(500).send('Google sign-in is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see README).');
  }
  res.redirect(gmail.authUrl({ withGmail: !gmail.gmailConnected() }));
});

app.get('/oauth2callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error));
    const { email, saveGmail } = await gmail.handleCallback(String(req.query.code));
    if (authEnabled && !isAllowed(email)) {
      console.warn(`[auth] sign-in refused for ${email}`);
      return res.redirect('/login?error=denied');
    }
    const firstConnect = !gmail.gmailConnected();
    await saveGmail();
    if (authEnabled) startSession(res, email);
    res.redirect('/');
    if (firstConnect && gmail.gmailConnected()) runSync();
  } catch (err) {
    console.error(`[auth] sign-in failed: ${err.message}`);
    res.redirect(authEnabled ? '/login?error=failed' : '/');
  }
});

// For an external pinger (e.g. cron-job.org every 10 minutes): runs a Gmail sync and
// keeps a free Render service awake. Protected by CRON_SECRET instead of a login.
app.all('/api/cron/sync', (req, res) => {
  const key = String(req.query.key || req.get('x-cron-key') || '');
  const ok = CRON_SECRET.length >= 16 && key.length === CRON_SECRET.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(CRON_SECRET));
  if (!ok) return res.status(401).json({ error: 'Bad or missing key' });
  res.status(202).json({ started: true }); // reply right away; pingers time out quickly
  runSync();
});

// --- everything below requires sign-in -----------------------------------------
app.use(requireLogin);
app.use(express.static('public'));
app.use('/vendor/d3', express.static(path.resolve('node_modules/d3/dist')));
app.use('/vendor/d3-sankey', express.static(path.resolve('node_modules/d3-sankey/dist')));

// --- live updates (Server-Sent Events) ------------------------------------
const clients = new Set();
function broadcast() {
  for (const res of clients) res.write('data: update\n\n');
}
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  // Comment pings keep proxies (like Render's) from closing an idle stream.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

// --- state ----------------------------------------------------------------
app.get('/api/state', (req, res) => {
  const db = getDb();
  res.json({
    applications: db.applications.map(a => ({ ...a, path: stagePath(a, { ghostDays: GHOST_DAYS }) })),
    gmail: {
      configured: gmail.gmailConfigured(),
      connected: gmail.gmailConnected(),
      lastSync: db.lastSync,
      lastSyncError: db.lastSyncError,
      syncMinutes: SYNC_MINUTES,
      classifier: classifierName(),
      progress: gmail.getProgress(),
    },
    user: authEnabled ? req.user?.email : null,
    ghostDays: GHOST_DAYS,
  });
});

// --- applications CRUD ----------------------------------------------------
function addManualStatus(a, stage) {
  if (!isStage(stage) || stage === a.status) return;
  a.events.push({ id: newId(), date: new Date().toISOString(), stage, manual: true, subject: 'Status changed manually' });
}

app.post('/api/applications', (req, res) => {
  const { company, role, jobId, url, notes, status = 'applied' } = req.body;
  if (!company?.trim()) return res.status(400).json({ error: 'Company is required' });
  const a = createApplication({ company: company.trim(), role: role?.trim(), jobId: jobId?.trim(), url, notes });
  a.events.push({ id: newId(), date: new Date().toISOString(), stage: 'applied', manual: true, subject: 'Added manually' });
  if (status !== 'applied') addManualStatus(a, status);
  refresh(a);
  save();
  broadcast();
  res.json(a);
});

app.patch('/api/applications/:id', (req, res) => {
  const a = getDb().applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const newCompany = req.body.company?.trim();
  if (newCompany && newCompany !== a.company) {
    a.aliases = [...new Set([...(a.aliases || []), a.company])];
    a.renamed = true;
  }
  for (const key of ['company', 'role', 'jobId', 'url', 'notes']) {
    if (typeof req.body[key] !== 'string') continue;
    const value = req.body[key].trim();
    // Remember hand-corrected role/ID so a re-scan doesn't overwrite them.
    if ((key === 'role' || key === 'jobId') && value !== (a[key] || '')) a.edited = { ...a.edited, [key]: true };
    a[key] = value;
  }
  if (req.body.status) addManualStatus(a, req.body.status);
  // Deadline: "YYYY-MM-DD" sets your own (end of that day); "" or done=true clears the current one.
  if (typeof req.body.deadline === 'string') {
    const m = req.body.deadline.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      a.manualDeadline = new Date(+m[1], +m[2] - 1, +m[3], 23, 59).toISOString();
      a.deadlineDone = null;
    } else {
      a.deadlineDone = a.deadline;
      a.manualDeadline = null;
    }
  }
  if (req.body.deadlineDone === true) {
    a.deadlineDone = a.deadline;
    a.manualDeadline = null;
  }
  refresh(a);
  save();
  broadcast();
  res.json(a);
});

// Excel export of the given applications (in the order shown), or all of them.
app.post('/api/export', async (req, res) => {
  const all = getDb().applications;
  const ids = Array.isArray(req.body.ids) ? req.body.ids : null;
  const byId = new Map(all.map(a => [a.id, a]));
  const apps = ids ? ids.map(id => byId.get(id)).filter(Boolean) : all;
  const buffer = await buildWorkbook(apps);
  const name = String(req.body.filename || 'job-applications').replace(/[^\w .-]/g, '') || 'job-applications';
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${name}.xlsx"`,
  });
  res.send(Buffer.from(buffer));
});

app.delete('/api/applications/:id', (req, res) => {
  const db = getDb();
  const gone = db.applications.find(x => x.id === req.params.id);
  // Remember its emails so a re-scan doesn't bring the application back.
  db.ignored ??= {};
  for (const e of gone?.events || []) if (e.messageId) db.ignored[e.messageId] = true;
  db.applications = db.applications.filter(x => x.id !== req.params.id);
  save();
  broadcast();
  res.json({ ok: true });
});

// --- Gmail ----------------------------------------------------------------
app.post('/api/sync', async (req, res) => {
  if (gmail.isRescanning()) return res.status(202).json({ rescanning: true });
  try {
    const result = await gmail.sync();
    broadcast();
    res.json(result);
  } catch (err) {
    broadcast();
    res.status(500).json({ error: err.message });
  }
});

// Re-read every email with the current classifier, keeping your edits. Runs in the
// background; progress comes through /api/state and live updates.
app.post('/api/rescan', (req, res) => {
  if (!gmail.gmailConnected()) return res.status(400).json({ error: 'Connect Gmail first' });
  if (gmail.isRescanning()) return res.status(409).json({ error: 'A re-scan is already running' });
  gmail.rescan()
    .then(r => console.log(`[rescan] done: ${r.applications} applications, ${r.restored} with your edits restored, ${r.kept} kept as-is`))
    .catch(err => console.error(`[rescan] failed: ${err.message}`))
    .finally(broadcast);
  res.status(202).json({ started: true });
});

app.post('/api/disconnect', async (req, res) => {
  await gmail.disconnect();
  broadcast();
  res.json({ ok: true });
});

async function runSync() {
  if (gmail.isRescanning() || !gmail.gmailConnected()) return;
  try {
    const { added = 0 } = await gmail.sync();
    if (added) console.log(`[sync] ${added} new email update(s)`);
  } catch (err) {
    console.error(`[sync] failed: ${err.message}`);
  }
  broadcast();
}

// Live progress while a sync or re-scan works through emails.
gmail.onProgress(broadcast);

// --- start up / shut down ---------------------------------------------------
checkAuthConfig();
await initStore();
await gmail.initGmail();

app.listen(PORT, HOST, () => {
  console.log(`Job tracker running at ${gmail.PUBLIC_URL} (listening on ${HOST}:${PORT})`);
  console.log(`Storage: ${process.env.DATABASE_URL ? 'Postgres' : 'local files in data/'} · classifier: ${classifierName()} · sign-in: ${authEnabled ? 'Google' : 'off (local)'}`);
  runSync();
  setInterval(runSync, SYNC_MINUTES * 60_000);
});

// Render stops the old instance on every deploy; write pending changes first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await flush();
    process.exit(0);
  });
}
