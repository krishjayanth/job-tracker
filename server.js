import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { initStorage, flushAll, refresh, newId } from './src/store.js';
import { isStage, stagePath } from './src/stages.js';
import { classifierName } from './src/classify.js';
import { buildWorkbook } from './src/export.js';
import * as gmail from './src/gmail.js';
import { looksLikeGroqKey, checkGroqKey, SERVER_KEY } from './src/groq.js';
import { initSecrets } from './src/secrets.js';
import { addReport, listReports, openCount, setReportStatus, deleteReport, deleteReportsBy } from './src/reports.js';
import { getUser, allUsers, deleteUser, LOCAL_ID, DEMO_ID } from './src/users.js';
import { authEnabled, checkAuthConfig, isAllowed, requireLogin, startSession, endSession } from './src/auth.js';

const PORT = gmail.PORT;
// On Render (or any host) listen on all interfaces; locally, only on this machine.
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const SYNC_MINUTES = Number(process.env.SYNC_INTERVAL_MINUTES || 5);
const GHOST_DAYS = Number(process.env.GHOST_AFTER_DAYS || 21);
const CRON_SECRET = process.env.CRON_SECRET || '';
// `npm run demo`: sample data in memory, no Gmail, no sign-in.
const DEMO = process.argv.includes('--demo');

const app = express();
app.set('trust proxy', 1); // Render terminates HTTPS in front of the app
app.use(express.json());

// --- public routes (no sign-in needed) ---------------------------------------
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Landing page (/welcome), privacy policy (/privacy) and terms (/terms). Public so
// visitors and Google's OAuth review can read them without signing in.
app.use(express.static('public-site', { extensions: ['html'], index: false }));

app.get('/login', (req, res) => {
  if (!authEnabled) return res.redirect('/');
  res.sendFile(path.resolve('public-login/login.html'));
});

app.get('/logout', (req, res) => {
  endSession(res);
  res.redirect(authEnabled ? '/login' : '/');
});

// Sign in with Google; ?gmail=1 also asks for read-only Gmail access (connecting or
// reconnecting Gmail). Someone new is sent on to the Gmail screen after signing in.
app.get('/auth/google', (req, res) => {
  if (!gmail.gmailConfigured()) {
    return res.status(500).send('Google sign-in is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see docs/DEPLOY.md).');
  }
  res.redirect(gmail.authUrl({ withGmail: req.query.gmail === '1' || !authEnabled }));
});

app.get('/oauth2callback', async (req, res) => {
  try {
    if (req.query.error) {
      // Said no to Gmail access after signing in: carry on without Gmail.
      if (req.query.state === 'gmail') return res.redirect('/');
      throw new Error(String(req.query.error));
    }
    const { sub, email, tokens, grantedGmail } = await gmail.handleCallback(String(req.query.code));
    if (authEnabled && !isAllowed(email)) {
      console.warn(`[auth] sign-in refused for ${email}`);
      return res.redirect('/login?error=denied');
    }
    const user = live(await getUser(authEnabled ? sub : LOCAL_ID, email));
    const firstConnect = !user.mailbox.connected();
    if (grantedGmail) await user.mailbox.saveTokens(tokens);
    if (authEnabled) startSession(res, { sub, email });
    if (user.isNew && !user.mailbox.connected() && req.query.state !== 'gmail') {
      user.isNew = false;
      return res.redirect('/auth/google?gmail=1');
    }
    res.redirect('/');
    if (firstConnect && user.mailbox.connected()) runSync(user);
  } catch (err) {
    console.error(`[auth] sign-in failed: ${err.message}`);
    res.redirect(authEnabled ? '/login?error=failed' : '/');
  }
});

// For an external pinger (e.g. cron-job.org every 10 minutes): syncs everyone's Gmail
// and keeps a free Render service awake. Protected by CRON_SECRET instead of a login.
app.all('/api/cron/sync', (req, res) => {
  const key = String(req.query.key || req.get('x-cron-key') || '');
  const ok = CRON_SECRET.length >= 16 && key.length === CRON_SECRET.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(CRON_SECRET));
  if (!ok) return res.status(401).json({ error: 'Bad or missing key' });
  res.status(202).json({ started: true }); // reply right away; pingers time out quickly
  runSyncAll();
});

// --- everything below requires sign-in -----------------------------------------
app.use(requireLogin);
app.use(express.static('public'));
app.use('/vendor/d3', express.static(path.resolve('node_modules/d3/dist')));
app.use('/vendor/d3-sankey', express.static(path.resolve('node_modules/d3-sankey/dist')));

// Every API call works on the signed-in person's own data (req.account) and nobody else's.
app.use('/api', async (req, res, next) => {
  try {
    const id = req.user?.id ?? (DEMO ? DEMO_ID : LOCAL_ID);
    req.account = live(await getUser(id, req.user?.email ?? null));
    next();
  } catch (err) {
    next(err);
  }
});

// --- live updates (Server-Sent Events), per person ------------------------------
const clients = new Map(); // user id -> Set of open responses
function broadcast(userId) {
  for (const res of clients.get(userId) || []) res.write('data: update\n\n');
}
// Sync progress reaches that person's open tabs.
function live(user) {
  user.mailbox.onProgress = () => broadcast(user.id);
  return user;
}
app.get('/api/events', (req, res) => {
  const id = req.account.id;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  if (!clients.has(id)) clients.set(id, new Set());
  clients.get(id).add(res);
  if (canSeeReports(req.account)) ownerClients.add(res);
  // Comment pings keep proxies (like Render's) from closing an idle stream.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); clients.get(id)?.delete(res); ownerClients.delete(res); });
});

// The owner reads everyone's problem reports (in demo mode, whoever is looking).
const canSeeReports = user => user.owner || DEMO;
const ownerClients = new Set();
const tellOwner = () => { for (const res of ownerClients) res.write('data: reports\n\n'); };

// --- state ----------------------------------------------------------------
app.get('/api/state', async (req, res) => {
  const user = req.account;
  const reports = canSeeReports(user) ? { open: await openCount() } : null;
  const db = user.store.db;
  res.json({
    applications: db.applications.map(a => ({ ...a, path: stagePath(a, { ghostDays: GHOST_DAYS }) })),
    gmail: DEMO ? demoGmailState(db) : {
      configured: gmail.gmailConfigured(),
      connected: user.mailbox.connected(),
      lastSync: db.lastSync,
      lastSyncError: db.lastSyncError,
      syncMinutes: SYNC_MINUTES,
      classifier: classifierName(user.groq()),
      progress: user.mailbox.progress,
    },
    groq: DEMO ? null : user.groqInfo(),
    user: authEnabled ? user.email : null,
    reports,
    demo: DEMO,
    ghostDays: GHOST_DAYS,
  });
});

function demoGmailState(db) {
  return { configured: true, connected: true, lastSync: db.lastSync, lastSyncError: null, syncMinutes: SYNC_MINUTES, classifier: 'demo data', progress: null };
}

// Save this person's tracker and tell their open tabs.
function changed(user) {
  user.store.save();
  broadcast(user.id);
}

// --- applications CRUD ----------------------------------------------------
function addManualStatus(a, stage) {
  if (!isStage(stage) || stage === a.status) return;
  a.events.push({ id: newId(), date: new Date().toISOString(), stage, manual: true, subject: 'Status changed manually' });
}

app.post('/api/applications', (req, res) => {
  const { company, role, jobId, url, notes, status = 'applied' } = req.body;
  if (!company?.trim()) return res.status(400).json({ error: 'Company is required' });
  const a = req.account.store.createApplication({ company: company.trim(), role: role?.trim(), jobId: jobId?.trim(), url, notes });
  a.events.push({ id: newId(), date: new Date().toISOString(), stage: 'applied', manual: true, subject: 'Added manually' });
  if (status !== 'applied') addManualStatus(a, status);
  refresh(a);
  changed(req.account);
  res.json(a);
});

app.patch('/api/applications/:id', (req, res) => {
  const a = req.account.store.applications.find(x => x.id === req.params.id);
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
  if (req.body.deadlineDone === false) a.deadlineDone = null; // undo "done" on an email's deadline
  refresh(a);
  changed(req.account);
  res.json(a);
});

// Remove a status change you made by hand, so the emails decide the status again.
// Emails can't be removed this way ("Wrong application?" moves them instead).
app.delete('/api/applications/:id/events/:eventId', (req, res) => {
  const a = req.account.store.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const e = a.events.find(x => x.id === req.params.eventId);
  if (!e) return res.status(404).json({ error: 'That timeline entry is already gone' });
  if (!e.manual) return res.status(400).json({ error: 'Only changes you made can be removed' });
  if (a.events.length === 1) return res.status(400).json({ error: "An application needs at least one entry. Delete the application instead" });
  a.events = a.events.filter(x => x !== e);
  refresh(a);
  changed(req.account);
  res.json({ app: a, removed: e });
});

// Put back a change removed above (Undo).
app.post('/api/applications/:id/events', (req, res) => {
  const a = req.account.store.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const { id, date, stage, subject } = req.body || {};
  if (!isStage(stage) || Number.isNaN(Date.parse(date))) return res.status(400).json({ error: 'Not a valid timeline entry' });
  if (!a.events.some(x => x.id === id)) {
    a.events.push({ id: typeof id === 'string' && id ? id : newId(), date: new Date(date).toISOString(), stage, manual: true, subject: String(subject || 'Status changed manually') });
  }
  refresh(a);
  changed(req.account);
  res.json({ app: a });
});

// Confirm or correct which application an email belongs to (see Store#reassignEmail).
app.post('/api/emails/:eventId/assign', (req, res) => {
  const { app: a, error, status } = req.account.store.reassignEmail(req.params.eventId, req.body || {});
  if (error) return res.status(status).json({ error });
  changed(req.account);
  res.json({ app: a });
});

// Excel export of the given applications (in the order shown), or all of them.
app.post('/api/export', async (req, res) => {
  const all = req.account.store.applications;
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
  req.account.store.deleteApplication(req.params.id);
  changed(req.account);
  res.json({ ok: true });
});

// --- Gmail ----------------------------------------------------------------
app.post('/api/sync', async (req, res) => {
  const user = req.account;
  if (DEMO) {
    user.store.db.lastSync = new Date().toISOString();
    broadcast(user.id);
    return res.json({ added: 0, demo: true });
  }
  if (user.mailbox.isRescanning()) return res.status(202).json({ rescanning: true });
  try {
    const result = await user.mailbox.sync();
    broadcast(user.id);
    res.json(result);
  } catch (err) {
    broadcast(user.id);
    res.status(500).json({ error: err.message });
  }
});

// Re-read every email with the current classifier, keeping your edits. Runs in the
// background; progress comes through /api/state and live updates.
app.post('/api/rescan', (req, res) => {
  const user = req.account;
  if (DEMO) return res.status(400).json({ error: 'Re-scan reads Gmail, so it is off in demo mode' });
  if (!user.mailbox.connected()) return res.status(400).json({ error: 'Connect Gmail first' });
  if (user.mailbox.isRescanning()) return res.status(409).json({ error: 'A re-scan is already running' });
  user.mailbox.rescan()
    .then(r => console.log(`[rescan] ${user.id}: ${r.applications} applications, ${r.restored} with edits restored, ${r.kept} kept as-is`))
    .catch(err => console.error(`[rescan] ${user.id} failed: ${err.message}`))
    .finally(() => broadcast(user.id));
  res.status(202).json({ started: true });
});

// Re-read just this application's emails, for when one was sorted wrong.
app.post('/api/applications/:id/rescan', async (req, res) => {
  const user = req.account;
  const a = user.store.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (DEMO) return res.status(400).json({ error: 'Re-scan reads Gmail, so it is off in demo mode' });
  if (!user.mailbox.connected()) return res.status(400).json({ error: 'Connect Gmail first' });
  if (user.mailbox.isRescanning()) return res.status(409).json({ error: 'A full re-scan is running. This application is included' });
  if (!a.events.some(e => !e.manual && e.messageId)) return res.status(400).json({ error: 'This application has no Gmail emails to re-read' });
  try {
    const result = await user.mailbox.rescanApplication(a);
    broadcast(user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/disconnect', async (req, res) => {
  await req.account.mailbox.disconnect();
  broadcast(req.account.id);
  res.json({ ok: true });
});

// --- problem reports ------------------------------------------------------------
// Anyone signed in can send one; only the owner can read and manage them.
app.post('/api/reports', async (req, res) => {
  const { kind, message, context } = req.body || {};
  const { report, error } = await addReport({ userId: req.account.id, email: req.account.email, kind, message, context });
  if (error) return res.status(400).json({ error });
  console.log(`[reports] new ${report.kind} report from ${report.email || report.userId}`);
  tellOwner();
  res.json({ ok: true });
});

const ownerOnly = (req, res, next) => canSeeReports(req.account) ? next() : res.status(403).json({ error: 'Only the owner can see reports' });
app.get('/api/reports', ownerOnly, async (req, res) => res.json({ reports: await listReports() }));
app.patch('/api/reports/:id', ownerOnly, async (req, res) => {
  const r = await setReportStatus(req.params.id, req.body?.status);
  if (!r) return res.status(404).json({ error: 'Not found' });
  tellOwner();
  res.json(r);
});
app.delete('/api/reports/:id', ownerOnly, async (req, res) => {
  await deleteReport(req.params.id);
  tellOwner();
  res.json({ ok: true });
});

// --- your Groq key and your account -----------------------------------------
app.put('/api/groq-key', async (req, res) => {
  if (DEMO) return res.status(400).json({ error: 'Groq keys are off in demo mode' });
  const key = String(req.body.key || '').trim();
  if (!looksLikeGroqKey(key)) return res.status(400).json({ error: "That doesn't look like a Groq API key. They start with gsk_" });
  try {
    if (!await checkGroqKey(key)) return res.status(400).json({ error: "Groq didn't accept that key. Check it was copied in full" });
  } catch (err) {
    return res.status(502).json({ error: `Couldn't reach Groq to check the key (${err.message}). Try again in a minute` });
  }
  await req.account.setGroqKey(key);
  broadcast(req.account.id);
  res.json(req.account.groqInfo());
});

app.delete('/api/groq-key', async (req, res) => {
  await req.account.removeGroqKey();
  broadcast(req.account.id);
  res.json(req.account.groqInfo());
});

// Delete everything nuj keeps for you and cancel its Gmail access.
app.delete('/api/account', async (req, res) => {
  if (DEMO) return res.status(400).json({ error: 'There is no account to delete in demo mode' });
  const { id } = req.account;
  await deleteUser(id);
  await deleteReportsBy(id);
  console.log(`[users] deleted ${id}`);
  endSession(res);
  res.json({ ok: true });
  broadcast(id); // other open tabs reload and find themselves signed out
});

// --- background syncing ---------------------------------------------------------
async function runSync(user) {
  if (user.mailbox.isRescanning() || !user.mailbox.connected()) return;
  try {
    const { added = 0 } = await user.mailbox.sync();
    if (added) console.log(`[sync] ${user.id}: ${added} new email update(s)`);
  } catch (err) {
    console.error(`[sync] ${user.id} failed: ${err.message}`);
  }
  broadcast(user.id);
}

// One person at a time, so syncs don't pile up on Groq or Gmail. People taken off
// ALLOWED_EMAIL keep their data but stop syncing.
let syncingAll = null;
function runSyncAll() {
  if (DEMO || syncingAll) return syncingAll;
  syncingAll = (async () => {
    const users = authEnabled
      ? (await allUsers()).filter(u => u.id !== LOCAL_ID && isAllowed(u.email))
      : [await getUser(LOCAL_ID)];
    for (const user of users) await runSync(live(user));
  })().catch(err => console.error(`[sync] ${err.message}`)).finally(() => { syncingAll = null; });
  return syncingAll;
}

// --- start up / shut down ---------------------------------------------------
if (DEMO && authEnabled) throw new Error('Demo mode runs without sign-in; unset ALLOWED_EMAIL to use it');
checkAuthConfig();
await initStorage({ demo: DEMO });
await initSecrets();

app.listen(PORT, HOST, () => {
  console.log(`nuj running at ${gmail.PUBLIC_URL} (listening on ${HOST}:${PORT})`);
  if (DEMO) return console.log('Demo mode: sample data, kept in memory only. Nothing is read from Gmail or saved.');
  console.log(`Storage: ${process.env.DATABASE_URL ? 'Postgres' : 'local files in data/'} · Groq: ${SERVER_KEY ? 'server key for the owner, others add their own' : 'each person adds their own key'} · sign-in: ${authEnabled ? 'Google' : 'off (local)'}`);
  runSyncAll();
  setInterval(runSyncAll, SYNC_MINUTES * 60_000);
});

// Render stops the old instance on every deploy; write pending changes first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await flushAll();
    process.exit(0);
  });
}
