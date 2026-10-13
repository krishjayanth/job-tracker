import express from 'express';
import path from 'node:path';
import { getDb, save, createApplication, refresh, newId } from './src/store.js';
import { isStage, stagePath } from './src/stages.js';
import { classifierName } from './src/classify.js';
import { detectOllama } from './src/ollama.js';
import { buildWorkbook } from './src/export.js';
import * as gmail from './src/gmail.js';

const PORT = gmail.PORT;
const SYNC_MINUTES = Number(process.env.SYNC_INTERVAL_MINUTES || 5);
const GHOST_DAYS = Number(process.env.GHOST_AFTER_DAYS || 21);

const app = express();
app.use(express.json());
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
  req.on('close', () => clients.delete(res));
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
    },
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
    if (typeof req.body[key] === 'string') a[key] = req.body[key].trim();
  }
  if (req.body.status) addManualStatus(a, req.body.status);
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
  db.applications = db.applications.filter(x => x.id !== req.params.id);
  save();
  broadcast();
  res.json({ ok: true });
});

// --- Gmail ----------------------------------------------------------------
app.post('/api/sync', async (req, res) => {
  try {
    const result = await gmail.sync();
    broadcast();
    res.json(result);
  } catch (err) {
    broadcast();
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/google', (req, res) => {
  if (!gmail.gmailConfigured()) return res.status(400).send('credentials.json not found — see README.');
  res.redirect(gmail.authUrl());
});

app.get('/oauth2callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error));
    await gmail.handleCallback(String(req.query.code));
    res.redirect('/');
    runSync();
  } catch (err) {
    res.status(500).send(`Google sign-in failed: ${err.message}`);
  }
});

app.post('/api/disconnect', (req, res) => {
  gmail.disconnect();
  broadcast();
  res.json({ ok: true });
});

async function runSync() {
  await detectOllama(); // picks up Ollama if it was started (or stopped) since last time
  try {
    const { added = 0 } = await gmail.sync();
    if (added) console.log(`[sync] ${added} new email update(s)`);
  } catch (err) {
    console.error(`[sync] failed: ${err.message}`);
  }
  broadcast();
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Job tracker running at http://localhost:${PORT}`);
  detectOllama().then(() => console.log(`Email classifier: ${classifierName()}`));
  runSync();
  setInterval(runSync, SYNC_MINUTES * 60_000);
});
