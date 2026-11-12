import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { initStorage, flushAll, refresh, newId, typedDeadline, getKv, setKv, deleteKv, setFile } from './src/store.js';
import { LATEST_RELEASE, RESCAN_ID } from './src/releases.js';
import { rescanEveryoneOnce, rescanAccount } from './src/rescan-all.js';
import { addRequest, listRequests, pendingCount, setRequestStatus, tooMany } from './src/access.js';
import { isStage, stagePath } from './src/stages.js';
import { classifierName } from './src/classify.js';
import { buildWorkbook } from './src/export.js';
import { buildIcs, newFeedToken, looksLikeFeedToken, typedInterview, validTimeZone } from './src/calendar.js';
import * as gmail from './src/gmail.js';
import { looksLikeGroqKey, checkGroqKey, SERVER_KEY } from './src/groq.js';
import { initSecrets } from './src/secrets.js';
import { canBlockDomain, senderDomain } from './src/jobcheck.js';
import { addReport, listReports, openCount, setReportStatus, deleteReport, deleteReportsBy } from './src/reports.js';
import { getUser, knownUser, allUsers, userIds, releaseIdleUsers, deleteUser, joinDates, LOCAL_ID, DEMO_ID } from './src/users.js';
import { recordError, listErrors, openErrorCount, setErrorStatus, deleteError, flushErrors } from './src/errors.js';
import { accountSummary, attentionFor, noteSeen } from './src/accounts.js';
import { buildDemoAccounts, buildDemoErrors, buildDemoFeedback, buildDemoResumes } from './src/demo.js';
import { extractText, cleanText, listVersions, addVersion, updateVersion, editText, deleteVersion, versionMeta, versionFor, currentVersion, savePdf, loadPdf, removePdf, dropPdfLater, MAX_VERSIONS, MAX_TEXT } from './src/resume.js';
import { textPdf } from './src/textpdf.js';
import { textFields } from './src/input.js';
import { computeInsights, outcomeOf, layoutLines } from './src/insights.js';
import { aiStatus, reserveRun, hashOf, findLine, reviewInput, writeReview, checkApplicationFit, demoReview, demoFit, serverUsage, CONSENT_VERSION, AI_KEY, DAILY_LIMIT, SERVER_DAILY_LIMIT } from './src/ai.js';
import { ask, pendingFor, answer, skip, stopAsking, listAsks, summarize, markRead, unreadCount } from './src/feedback.js';
import { authEnabled, checkAuthConfig, isAllowed, requireLogin, startSession, endSession } from './src/auth.js';

const PORT = gmail.PORT;
// On Render (or any host) listen on all interfaces; locally, only on this machine.
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const SYNC_MINUTES = Number(process.env.SYNC_INTERVAL_MINUTES || 5);
const GHOST_DAYS = Number(process.env.GHOST_AFTER_DAYS || 21);
const CRON_SECRET = process.env.CRON_SECRET || '';
// `npm run demo`: sample data in memory, no Gmail, no sign-in.
const DEMO = process.argv.includes('--demo');
const STARTED_AT = new Date().toISOString();
let lastCronAt = null;    // when the external pinger last called
let lastSyncPassAt = null; // when everyone's syncs last finished

const app = express();
app.set('trust proxy', 1); // Render terminates HTTPS in front of the app
// A pasted resume can be up to 40,000 characters, more than the default 100kb allows once
// it's JSON with escapes.
app.use(express.json({ limit: '200kb' }));
// Express 5 leaves req.body undefined when nothing (or no JSON) was sent; routes read
// fields from it, so an empty object instead of a crash. Upload routes still get their file.
app.use((req, res, next) => { req.body ??= {}; next(); });

// --- public routes (no sign-in needed) ---------------------------------------
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Landing page (/welcome), privacy policy (/privacy) and terms (/terms). Public so
// visitors and Google's OAuth review can read them without signing in.
app.use(express.static('public-site', { extensions: ['html'], index: false }));

// "Request an invite" on the landing page. Public, so: a hidden field bots fill in, a
// few tries per visitor an hour, and plain-word errors. The visitor's IP is only used
// for that limit, in memory; it isn't stored.
app.post('/api/access-requests', async (req, res) => {
  const { name, email, stage, note, website } = req.body || {};
  if (website) return res.json({ ok: true }); // the trap field: quietly ignore
  if (tooMany(req.ip)) return res.status(429).json({ error: "That's a lot of requests. Try again in an hour" });
  const { request, error, repeat } = await addRequest({ name, email, stage, note });
  if (error) return res.status(400).json({ error });
  console.log(`[access] ${repeat ? 'updated' : 'new'} invite request`);
  tellOwner();
  res.json({ ok: true, repeat: Boolean(repeat), email: request.email });
});

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
      recordError('sign-in', 'Sign-in refused: not on ALLOWED_EMAIL', { level: 'warning' });
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
    recordError('sign-in', err);
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
  lastCronAt = new Date().toISOString();
  runSyncAll();
});

// Someone's calendar feed (Settings → Calendar), for Google Calendar or any calendar app
// to fetch on its own. Calendar apps can't sign in, so the long random token in the
// address is the key; resetting it in Settings stops the old one.
app.get('/cal/:file', async (req, res) => {
  const token = req.params.file.replace(/\.ics$/, '');
  const userId = looksLikeFeedToken(token) && await getKv(`calfeed_${token}`);
  if (!userId) return res.status(404).send('This calendar link was turned off or reset. Get the current one from Settings in nuj.');
  const user = await getUser(userId);
  const feed = user.store.db.calendarFeed;
  if (feed?.token !== token) return res.status(404).send('This calendar link was reset. Get the current one from Settings in nuj.');
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, no-cache' });
  res.send(buildIcs(user.store.applications, { timeZone: feed.timeZone, link: `${req.protocol}://${req.get('host')}/#/calendar` }));
});

// --- everything below requires sign-in -----------------------------------------
app.use(requireLogin);
app.use(express.static('public'));
app.use('/vendor/d3', express.static(path.resolve('node_modules/d3/dist')));
app.use('/vendor/d3-sankey', express.static(path.resolve('node_modules/d3-sankey/dist')));
// PDF.js, for showing an uploaded resume as its real pages (loaded only on that page).
app.use('/vendor/pdfjs', express.static(path.resolve('node_modules/pdfjs-dist/build')));

// Every API call works on the signed-in person's own data (req.account) and nobody else's.
app.use('/api', async (req, res, next) => {
  try {
    const id = req.user?.id ?? (DEMO ? DEMO_ID : LOCAL_ID);
    req.account = live(await getUser(id, req.user?.email ?? null));
    req.account.lastUsedAt = Date.now(); // see releaseIdle
    noteSeen(req.account);
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
// Sync progress reaches that person's open tabs, at most every PROGRESS_MS: each message
// makes every open tab fetch the whole tracker again, which is a lot during a big sync.
// The last one in a burst still goes out, so the page never stops short of the real count.
const PROGRESS_MS = 1500;
function live(user) {
  if (!user.mailbox.onProgress?.throttled) {
    let last = 0, timer = null;
    const send = () => { last = Date.now(); timer = null; broadcast(user.id); };
    user.mailbox.onProgress = () => {
      if (timer) return;
      const wait = PROGRESS_MS - (Date.now() - last);
      if (wait <= 0) send();
      else timer = setTimeout(send, wait);
    };
    user.mailbox.onProgress.throttled = true;
  }
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
  req.on('close', () => {
    clearInterval(ping);
    clients.get(id)?.delete(res);
    if (!clients.get(id)?.size) clients.delete(id);
    ownerClients.delete(res);
  });
});

// The owner reads everyone's problem reports (in demo mode, whoever is looking).
const canSeeReports = user => user.owner || DEMO;
const ownerClients = new Set();
const tellOwner = () => { for (const res of ownerClients) res.write('data: reports\n\n'); };

// --- state ----------------------------------------------------------------
app.get('/api/state', async (req, res) => {
  const user = req.account;
  const reports = canSeeReports(user) ? { open: await openCount(), requests: await pendingCount(), errors: await openErrorCount(), feedback: await unreadCount() } : null;
  const db = user.store.db;
  const versions = await listVersions(user.id);
  res.json({
    applications: db.applications.map(a => ({
      ...a,
      path: stagePath(a, { ghostDays: GHOST_DAYS }),
      // The resume version it was sent with (see versionFor), for its panel.
      resumeVersion: versionFor(a, versions, db.timeZone)?.id ?? null,
      // The sender domain you could block from each email (none for Gmail, hiring software...).
      events: a.events.map(e => e.from && canBlockDomain(senderDomain(e.from)) ? { ...e, blockable: senderDomain(e.from) } : e),
    })),
    blockedSenders: Object.keys(db.blockedSenders || {}).sort(),
    gmail: DEMO ? demoGmailState(db) : {
      configured: gmail.gmailConfigured(),
      connected: user.mailbox.connected(),
      lastSync: db.lastSync,
      lastSyncError: db.lastSyncError,
      syncMinutes: SYNC_MINUTES,
      initialDays: gmail.INITIAL_DAYS,
      classifier: classifierName(user.groq()),
      progress: user.mailbox.progress,
    },
    groq: DEMO ? null : user.groqInfo(),
    // Gmail is connected but nothing has been read yet: ask how to sort first.
    needsSetup: !DEMO && user.mailbox.connected() && user.needsSetup(),
    whatsNew: whatsNewFor(user),
    // Questions the owner asked this person, shown the next time they open nuj.
    feedback: await feedbackFor(user),
    user: authEnabled ? user.email : null,
    reports,
    demo: DEMO,
    ghostDays: GHOST_DAYS,
    calendarFeed: db.calendarFeed ? { url: feedUrl(req, db.calendarFeed.token) } : null,
    // Your time zone as nuj last heard it from your browser (see PUT /api/time-zone).
    timeZone: db.timeZone ?? null,
    resumes: versions.map(({ id, name, usedFrom }) => ({ id, name, usedFrom })),
    ai: aiStatus(user, { demo: DEMO }),
  });
});

// The latest release notes, for someone who used nuj before this update and hasn't seen
// them. Only reads: someone new is marked as having seen them when their account loads
// (see noteReleaseForNewcomer in src/users.js), so loading the page never writes.
function whatsNewFor(user) {
  const db = user.store.db;
  if (DEMO || db.seenRelease === LATEST_RELEASE.id) return null;
  // Tell people whose emails are re-read with the new sorting (see rescanEveryoneOnce).
  const rescanned = db.rescanned === RESCAN_ID;
  const rereading = rescanned || (!user.owner && user.mailbox.connected());
  return {
    ...LATEST_RELEASE,
    items: LATEST_RELEASE.items.filter(i => i.needs !== 'ai' || AI_KEY),
    rescan: rereading
      ? (rescanned ? 'Your application emails have been read again with the new sorting.' : "Your application emails are being read again with the new sorting; you'll see the progress on your dashboard.")
        + ' Your notes, deadlines, status changes and fixes are kept.'
      : null,
  };
}

async function feedbackFor(user) {
  const a = await pendingFor(user.id);
  return a ? { id: a.id } : null;
}
app.post('/api/feedback/:id', async (req, res) => {
  const { enjoying, rating, sorting = null, comment = '' } = req.body || {};
  const r = await answer(req.params.id, { userId: req.account.id, email: req.account.email, enjoying, rating, sorting, comment });
  if (r.error) return res.status(400).json({ error: r.error });
  tellOwner();
  res.json({ ok: true });
});
app.post('/api/feedback/:id/skip', async (req, res) => {
  if (await skip(req.params.id, req.account.id)) tellOwner();
  res.json({ ok: true });
});

app.post('/api/whats-new/seen', (req, res) => {
  req.account.store.db.seenRelease = LATEST_RELEASE.id;
  req.account.store.save();
  res.json({ ok: true });
});

// Your time zone, from your browser: deadlines in emails ("by Oct 9 at 11:59 PM") are read
// as times where you are, not where the server is. Emails already read keep their deadline.
app.put('/api/time-zone', (req, res) => {
  const timeZone = req.body?.timeZone;
  if (!validTimeZone(timeZone)) return res.status(400).json({ error: "That isn't a time zone nuj knows" });
  if (req.account.store.db.timeZone !== timeZone) {
    req.account.store.db.timeZone = timeZone;
    req.account.store.save();
  }
  res.json({ timeZone });
});

// --- calendar feed ----------------------------------------------------------
const feedUrl = (req, token) => `${req.protocol}://${req.get('host')}/cal/${token}.ics`;

// Make (or reset) your calendar feed's address. The time zone is yours, so a deadline
// at the end of your day shows as an all-day event on the right date.
app.post('/api/calendar-feed', async (req, res) => {
  const db = req.account.store.db;
  const timeZone = validTimeZone(req.body?.timeZone) ? req.body.timeZone : 'UTC';
  if (db.calendarFeed) await deleteKv(`calfeed_${db.calendarFeed.token}`);
  const token = newFeedToken();
  await setKv(`calfeed_${token}`, req.account.id);
  db.calendarFeed = { token, timeZone, createdAt: new Date().toISOString() };
  changed(req.account);
  res.json({ url: feedUrl(req, token) });
});

app.delete('/api/calendar-feed', async (req, res) => {
  const db = req.account.store.db;
  if (db.calendarFeed) await deleteKv(`calfeed_${db.calendarFeed.token}`);
  db.calendarFeed = null;
  changed(req.account);
  res.json({ ok: true });
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
  const { fields, error } = textFields(req.body, ['company', 'role', 'jobId', 'url', 'notes'], { required: ['company'] });
  if (error) return res.status(400).json({ error });
  const status = req.body.status ?? 'applied';
  if (!isStage(status)) return res.status(400).json({ error: 'Unknown status' });
  const a = req.account.store.createApplication(fields);
  a.events.push({ id: newId(), date: new Date().toISOString(), stage: 'applied', manual: true, subject: 'Added manually' });
  if (status !== 'applied') addManualStatus(a, status);
  refresh(a);
  changed(req.account);
  res.json(a);
});

const MAX_POSTING = 20_000;

app.patch('/api/applications/:id', async (req, res) => {
  const a = req.account.store.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  // The resume it was sent with ("" goes back to working it out from the dates) and a
  // job description you pasted, both for Resume insights. Checked before anything changes.
  const { resumeId, posting } = req.body;
  if (typeof resumeId === 'string' && resumeId && !(await listVersions(req.account.id)).some(v => v.id === resumeId)) {
    return res.status(400).json({ error: 'That resume version was deleted' });
  }
  if (typeof posting === 'string' && cleanText(posting).length > MAX_POSTING) {
    return res.status(400).json({ error: `That job description is very long. Keep it under ${MAX_POSTING.toLocaleString('en-US')} characters` });
  }
  const { fields, error } = textFields(req.body, ['company', 'role', 'jobId', 'url', 'notes']);
  if (error) return res.status(400).json({ error });
  if (fields.company === '') return res.status(400).json({ error: "The company name can't be empty" });
  if (req.body.status !== undefined && !isStage(req.body.status)) return res.status(400).json({ error: 'Unknown status' });
  if (req.body.deadline !== undefined && typeof req.body.deadline !== 'string') return res.status(400).json({ error: 'Not a valid deadline' });
  if (typeof req.body.deadline === 'string' && req.body.deadline && !typedDeadline(req.body.deadline, req.account.store.db.timeZone)) {
    return res.status(400).json({ error: 'Give the deadline a date' });
  }
  const interviewAt = typeof req.body.interviewAt === 'string' ? typedInterview(req.body.interviewAt) : undefined;
  if (req.body.interviewAt && !interviewAt) return res.status(400).json({ error: 'Give the interview a date and a time' });
  // A Check fit answer was about the old job description or resume, so it goes.
  if (typeof resumeId === 'string' && (resumeId || null) !== (a.resumeId ?? null)) delete a.fit;
  if (typeof posting === 'string' && cleanText(posting) !== (a.posting ?? '')) delete a.fit;
  if (typeof resumeId === 'string') a.resumeId = resumeId || null;
  if (typeof posting === 'string') a.posting = cleanText(posting);
  if (fields.company && fields.company !== a.company) {
    a.aliases = [...new Set([...(a.aliases || []), a.company])];
    a.renamed = true;
  }
  for (const [key, value] of Object.entries(fields)) {
    // Remember hand-corrected role/ID so a re-scan doesn't overwrite them.
    if ((key === 'role' || key === 'jobId') && value !== (a[key] || '')) a.edited = { ...a.edited, [key]: true };
    a[key] = value;
  }
  if (req.body.status) {
    // Changing what an email set counts as a correction to the sorting.
    if (a.source === 'gmail' && isStage(req.body.status) && req.body.status !== a.status) req.account.store.noteCorrection('statusChanged');
    addManualStatus(a, req.body.status);
  }
  // Deadline: a date and time (or "YYYY-MM-DD" for the end of that day) sets your own;
  // "" or done=true clears the current one.
  if (typeof req.body.deadline === 'string') {
    const typed = typedDeadline(req.body.deadline, req.account.store.db.timeZone);
    if (typed) {
      a.manualDeadline = typed;
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
  // Interview: a date and time sets it; "" clears it.
  if (interviewAt !== undefined) a.interviewAt = interviewAt;
  refresh(a);
  changed(req.account);
  res.json(a);
});

// Remove a status change you made by hand, so the emails decide the status again.
// Emails can't be removed this way ("Filed correctly?" moves or removes them instead).
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
  const store = req.account.store;
  const body = req.body || {};
  // Moving or removing an email can be undone; confirming it needs no undo.
  const from = store.applications.find(a => a.events.some(e => e.id === req.params.eventId));
  const undo = body.action !== 'confirm' && from ? store.checkpoint([from.id, body.to].filter(Boolean)) : null;
  const { app: a, error, status } = store.reassignEmail(req.params.eventId, body);
  if (error) return res.status(status).json({ error });
  if (undo && body.action === 'new' && a) store.undoAlsoRemoves(undo, a.id);
  changed(req.account);
  res.json({ app: a, undo });
});

// Put things back as they were before a delete, move or ignore (the Undo in the page's message).
app.post('/api/undo/:token', (req, res) => {
  if (!req.account.store.undo(req.params.token)) return res.status(410).json({ error: 'Too late to undo that' });
  changed(req.account);
  res.json({ ok: true });
});

// Never read a sender again ("Ignore everything from simplebills.com"), and undo that.
app.post('/api/blocked-senders', (req, res) => {
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  if (!canBlockDomain(domain)) return res.status(400).json({ error: "That sender can't be blocked: it's a shared email service or hiring software" });
  const store = req.account.store;
  const touched = store.applications.filter(a => a.events.some(e => e.from && senderDomain(e.from) === domain)).map(a => a.id);
  const undo = store.checkpoint(touched, { blockedSender: domain });
  const removed = store.blockSender(domain);
  changed(req.account);
  res.json({ domain, removed, undo });
});
app.delete('/api/blocked-senders/:domain', (req, res) => {
  req.account.store.unblockSender(String(req.params.domain).toLowerCase());
  changed(req.account);
  res.json({ ok: true });
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

// Several applications at once, from the table's selection: give them all one status, or
// delete them. One checkpoint covers the lot, so a single Undo puts every one back.
app.post('/api/applications/bulk', (req, res) => {
  const store = req.account.store;
  const { action, status } = req.body || {};
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.filter(id => typeof id === 'string'))] : [];
  const apps = ids.map(id => store.applications.find(a => a.id === id)).filter(Boolean);
  if (!apps.length) return res.status(400).json({ error: 'Nothing selected' });
  if (action !== 'status' && action !== 'delete') return res.status(400).json({ error: 'Unknown action' });
  if (action === 'status' && !isStage(status)) return res.status(400).json({ error: 'Unknown status' });
  const undo = store.checkpoint(apps.map(a => a.id));
  for (const a of apps) {
    if (action === 'delete') {
      if (a.source === 'gmail') store.noteCorrection('deleted');
      store.deleteApplication(a.id);
    } else {
      if (a.source === 'gmail' && status !== a.status) store.noteCorrection('statusChanged');
      const before = a.events.length;
      addManualStatus(a, status);
      if (a.events.length > before) store.undoAlsoDrops(undo, [a.events.at(-1).id]);
      refresh(a);
    }
  }
  changed(req.account);
  res.json({ ok: true, count: apps.length, undo });
});

app.delete('/api/applications/:id', (req, res) => {
  const store = req.account.store;
  const undo = store.checkpoint([req.params.id]);
  if (store.applications.find(x => x.id === req.params.id)?.source === 'gmail') store.noteCorrection('deleted');
  store.deleteApplication(req.params.id);
  changed(req.account);
  res.json({ ok: true, undo });
});

// --- resume insights --------------------------------------------------------
// Your resume versions (their text, and a PDF to show the pages) and the AI's review of
// them. nuj itself doesn't grade the resume or read its skills: the AI does all of that,
// told only the resume, how applications went and the job descriptions you pasted.
// Changes tell your open tabs, like any other.
const UPLOAD_LIMIT = '5mb';

// The versions, the numbers behind them, and what the AI would be told for a review (with
// a fingerprint of it, so asking again when nothing changed doesn't use a run). An open
// Resume page asks again on every live update (every 1.5 seconds during a sync), so the
// answer is kept until the tracker or the versions change, or the hour turns
// (applications go quiet with time).
const pictures = new WeakMap(); // store -> { key, versions, picture }
async function resumePicture(user) {
  const versions = await listVersions(user.id);
  const timeZone = user.store.db.timeZone;
  const key = `${user.store.revision}|${Math.floor(Date.now() / 3_600_000)}|${timeZone}`;
  const kept = pictures.get(user.store);
  if (kept?.key === key && kept.versions === versions && kept.apps === user.store.applications) return kept.picture;
  const apps = user.store.applications.map(a => ({ ...a, path: stagePath(a, { ghostDays: GHOST_DAYS }) }));
  const insights = computeInsights(apps, versions, { ghostDays: GHOST_DAYS, timeZone });
  const current = versions.find(v => v.id === insights.currentId);
  const input = current && reviewInput({
    resumeText: current.text, versionName: current.name, insights,
    apps: [...apps].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt)).map(a => ({
      role: a.role || 'Not known', outcome: outcomeOf(a, { ghostDays: GHOST_DAYS }), version: versionFor(a, versions, timeZone).name,
      posting: a.posting || '',
    })),
  });
  const picture = { versions, insights, current, input, inputHash: input ? hashOf(input) : null };
  pictures.set(user.store, { key, versions, apps: user.store.applications, picture });
  return picture;
}

// One version laid out for the preview. The only highlights are the bullets the AI's
// review is about, which the page adds itself.
const previewOf = version => ({ versionId: version.id, name: version.name, lines: layoutLines(version.text) });

// What the page needs from the numbers: how many applications there are, which version is
// current, and which applications went out with each version (for "Show applications").
// The rest is only for the AI (see resumePicture).
const pageInsights = insights => ({
  total: insights.total,
  currentId: insights.currentId,
  byVersion: insights.byVersion.map(({ key, total, ids }) => ({ key, total, ids })),
});

// The saved review, with each graded bullet found in the version it was written for (they
// move if you edit the text; one whose line is gone, say after "Use this", has no line).
function placedReview(saved, versions, inputHash) {
  if (!saved) return null;
  const text = versions.find(v => v.id === saved.versionId)?.text ?? '';
  const { inputHash: _, ...review } = saved;
  return {
    ...review,
    upToDate: saved.inputHash === inputHash,
    bullets: saved.bullets.map(b => ({ ...b, at: findLine(text, b.line) })),
  };
}

app.get('/api/resume', async (req, res) => {
  const { versions, insights, current, inputHash } = await resumePicture(req.account);
  res.json({
    versions: versions.map(versionMeta),
    insights: pageInsights(insights),
    limits: { versions: MAX_VERSIONS, text: MAX_TEXT },
    ai: aiStatus(req.account, { demo: DEMO }),
    // upToDate: nothing the review was based on has changed since.
    review: placedReview(req.account.store.db.insights?.review, versions, inputHash),
    preview: current ? previewOf(current) : null,
    // The last job you checked from this page (Check a job), if any.
    jobFit: req.account.store.db.insights?.jobFit ?? null,
  });
});

// One version with its text; ?preview=1 lays it out for the preview instead.
app.get('/api/resume/:id', async (req, res) => {
  const version = (await listVersions(req.account.id)).find(v => v.id === req.params.id);
  if (!version) return res.status(404).json({ error: 'That version was deleted' });
  res.json(req.query.preview ? previewOf(version) : version);
});

// Read the text out of a PDF or Word file, for you to check before saving. The file
// itself is never stored.
app.post('/api/resume/extract', express.raw({ type: () => true, limit: UPLOAD_LIMIT }), async (req, res) => {
  if (tooMany(`resume:${req.account.id}`, { max: 30 })) return res.status(429).json({ error: "That's a lot of uploads. Try again in an hour" });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Choose a file to upload' });
  const result = await extractText(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.post('/api/resume', async (req, res) => {
  const { version, error } = await addVersion(req.account.id, req.body || {});
  if (error) return res.status(400).json({ error });
  broadcast(req.account.id);
  res.json(versionMeta(version));
});

app.patch('/api/resume/:id', async (req, res) => {
  const { version, error, status } = await updateVersion(req.account.id, req.params.id, req.body || {});
  if (error) return res.status(status || 400).json({ error });
  broadcast(req.account.id);
  res.json(versionMeta(version));
});

// Deleting returns the version, so the page's Undo can add it back as it was (its PDF
// is kept until the Undo has passed).
app.delete('/api/resume/:id', async (req, res) => {
  const timeZone = req.account.store.db.timeZone;
  const before = await listVersions(req.account.id);
  const { removed, error, status } = await deleteVersion(req.account.id, req.params.id);
  if (error) return res.status(status || 400).json({ error });
  if (removed.pdf) dropPdfLater(req.account.id, removed.id);
  // Its applications now count toward another version: say which, so it's no surprise.
  const after = await listVersions(req.account.id);
  const moved = req.account.store.applications.filter(a => versionFor(a, before, timeZone)?.id === removed.id);
  const to = new Map();
  for (const a of moved) {
    const name = versionFor(a, after, timeZone)?.name;
    if (name) to.set(name, (to.get(name) ?? 0) + 1);
  }
  broadcast(req.account.id);
  res.json({ removed, moved: { count: moved.length, to: [...to].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null } });
});

// Put a suggested rewrite into the version's text, in place of the line it rewrites. The
// line keeps its bullet. Returns the text from before, for Undo.
app.post('/api/resume/:id/rewrite', async (req, res) => {
  const { from, to } = req.body || {};
  if (typeof from !== 'string' || typeof to !== 'string' || !to.trim() || to.length > 600 || /[\r\n]/.test(to)) {
    return res.status(400).json({ error: "That rewrite can't be used as it is. Copy it instead" });
  }
  const result = await editText(req.account.id, req.params.id, text => {
    const lines = text.split('\n');
    const i = findLine(text, from);
    if (i < 0) return { error: "That line isn't in this version any more" };
    const bullet = lines[i].match(/^\s*(?:[•●▪◦‣■□*–-]|\d+[.)])\s+/)?.[0] ?? '';
    lines[i] = bullet + to.trim();
    return lines.join('\n');
  });
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  broadcast(req.account.id);
  res.json({ version: versionMeta(result.version), before: result.before });
});

// A version's PDF: shown on the page as its real pages. Only a PDF is kept.
app.get('/api/resume/:id/pdf', async (req, res) => {
  const pdf = await loadPdf(req.account.id, req.params.id);
  if (!pdf) return res.status(404).json({ error: 'This version has no PDF' });
  res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-cache', 'Content-Disposition': 'inline' });
  res.send(pdf);
});

app.put('/api/resume/:id/pdf', express.raw({ type: () => true, limit: UPLOAD_LIMIT }), async (req, res) => {
  if (tooMany(`resume-pdf:${req.account.id}`, { max: 20 })) return res.status(429).json({ error: "That's a lot of uploads. Try again in an hour" });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Choose a PDF to upload' });
  const { version, error, status } = await savePdf(req.account.id, req.params.id, req.body);
  if (error) return res.status(status || 400).json({ error });
  broadcast(req.account.id);
  res.json(versionMeta(version));
});

app.delete('/api/resume/:id/pdf', async (req, res) => {
  await removePdf(req.account.id, req.params.id);
  broadcast(req.account.id);
  res.json({ ok: true });
});

// --- AI for resume insights (src/ai.js) -------------------------------------------
// Uses the server's OpenAI key, with a daily limit for everyone but the owner. Nothing is
// sent until you've allowed it once.
app.post('/api/insights/consent', (req, res) => {
  const db = req.account.store.db;
  db.insights ??= {};
  db.insights.consent = req.body?.allow === false ? null : { at: new Date().toISOString(), version: CONSENT_VERSION };
  changed(req.account);
  res.json({ ai: aiStatus(req.account, { demo: DEMO }) });
});

// Checks shared by both AI actions. Returns an error to send, or null.
function aiBlocked(user) {
  const ai = aiStatus(user, { demo: DEMO });
  if (!ai.available) return { status: 400, body: { error: "AI reviews aren't set up on this server" } };
  if (!ai.consent) return { status: 403, body: { error: 'Allow nuj to send your resume to OpenAI first', needsConsent: true } };
  return null;
}

// Grade the current resume. Asking again when nothing it rests on has changed gives back
// the review you have, without using a run.
app.post('/api/insights/review', async (req, res) => {
  const user = req.account;
  const blocked = aiBlocked(user);
  if (blocked) return res.status(blocked.status).json(blocked.body);
  const { input, inputHash, current } = await resumePicture(user);
  if (!input) return res.status(400).json({ error: 'Add your resume first' });
  const db = user.store.db;
  if (db.insights.review?.inputHash === inputHash) return res.json({ cached: true, ai: aiStatus(user, { demo: DEMO }) });
  const run = await reserveRun(user);
  if (run.error) return res.status(run.status).json({ error: run.error, ai: aiStatus(user, { demo: DEMO }) });
  let review;
  try {
    review = DEMO ? demoReview(input) : await writeReview(input);
    if (!review) throw new Error("The AI's review didn't come back complete. Try again later");
  } catch (err) {
    await run.release();
    return res.status(502).json({ error: err.message });
  }
  // The score you had before, so the page can show how far a rewrite moved it.
  const previous = db.insights.review ? { score: db.insights.review.score, at: db.insights.review.at, version: db.insights.review.version } : null;
  db.insights.review = { ...review, inputHash, at: new Date().toISOString(), version: current.name, versionId: current.id, previous };
  delete db.insights.suggestions; // what came before reviews
  changed(user);
  res.json({ ai: aiStatus(user, { demo: DEMO }) });
});

// A graded bullet or a point from your applications: Done, Skip, or back to open (Undo).
app.patch('/api/insights/review/items/:id', (req, res) => {
  const review = req.account.store.db.insights?.review;
  const item = [...(review?.bullets || []), ...(review?.fromApplications || [])].find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'That part of the review is gone. Grade your resume again' });
  if (!['open', 'done', 'dismissed'].includes(req.body?.state)) return res.status(400).json({ error: 'Unknown choice' });
  item.state = req.body.state;
  item.decidedAt = item.state === 'open' ? null : new Date().toISOString();
  changed(req.account);
  res.json({ ok: true });
});

// Check a job from the Resume page: how well a version fits a job description you paste,
// for a job you haven't applied to yet. The last one is kept to show when you come back.
app.post('/api/insights/fit', async (req, res) => {
  const user = req.account;
  const blocked = aiBlocked(user);
  if (blocked) return res.status(blocked.status).json(blocked.body);
  const posting = cleanText(typeof req.body?.posting === 'string' ? req.body.posting : '');
  if (posting.length < 40) return res.status(400).json({ error: 'Paste the whole job description' });
  if (posting.length > MAX_POSTING) return res.status(400).json({ error: `That job description is very long. Keep it under ${MAX_POSTING.toLocaleString('en-US')} characters` });
  const versions = await listVersions(user.id);
  const version = versions.find(v => v.id === req.body?.versionId) ?? currentVersion(versions, { timeZone: user.store.db.timeZone });
  if (!version) return res.status(400).json({ error: 'Add your resume first' });
  const db = user.store.db;
  db.insights ??= {};
  const key = hashOf(['tailor', posting, version.id, version.updatedAt]);
  if (db.insights.jobFit?.key === key) return res.json({ jobFit: db.insights.jobFit, cached: true, ai: aiStatus(user, { demo: DEMO }) });
  const run = await reserveRun(user);
  if (run.error) return res.status(run.status).json({ error: run.error, ai: aiStatus(user, { demo: DEMO }) });
  let result;
  try {
    const args = { resumeText: version.text, posting, role: '' };
    result = DEMO ? demoFit(args) : await checkApplicationFit(args);
  } catch (err) {
    await run.release();
    return res.status(502).json({ error: err.message });
  }
  db.insights.jobFit = { key, at: new Date().toISOString(), posting, versionId: version.id, versionName: version.name, ...result };
  changed(user);
  res.json({ jobFit: db.insights.jobFit, ai: aiStatus(user, { demo: DEMO }) });
});

app.delete('/api/insights/fit', (req, res) => {
  if (req.account.store.db.insights?.jobFit) {
    delete req.account.store.db.insights.jobFit;
    changed(req.account);
  }
  res.json({ ok: true });
});

// How well the resume this went out with fits its pasted job description.
app.post('/api/applications/:id/fit', async (req, res) => {
  const user = req.account;
  const a = user.store.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const blocked = aiBlocked(user);
  if (blocked) return res.status(blocked.status).json(blocked.body);
  if (!a.posting) return res.status(400).json({ error: 'Paste the job description first' });
  const version = versionFor(a, await listVersions(user.id), user.store.db.timeZone);
  if (!version) return res.status(400).json({ error: 'Add your resume first' });
  // 'tailor': answers from before tailoring (no score) are asked again.
  const key = hashOf(['tailor', a.posting, version.id, version.updatedAt]);
  if (a.fit?.key === key) return res.json({ fit: a.fit, cached: true, ai: aiStatus(user, { demo: DEMO }) });
  const run = await reserveRun(user);
  if (run.error) return res.status(run.status).json({ error: run.error, ai: aiStatus(user, { demo: DEMO }) });
  let result;
  try {
    const args = { resumeText: version.text, posting: a.posting, role: a.role, company: a.company };
    result = DEMO ? demoFit(args) : await checkApplicationFit(args);
  } catch (err) {
    await run.release();
    return res.status(502).json({ error: err.message });
  }
  a.fit = { key, at: new Date().toISOString(), versionName: version.name, ...result };
  changed(user);
  res.json({ fit: a.fit, ai: aiStatus(user, { demo: DEMO }) });
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
  if (user.needsSetup()) return res.status(409).json({ error: 'Choose how nuj should read your emails first' });
  try {
    const result = await user.mailbox.sync();
    broadcast(user.id);
    res.json(result);
  } catch (err) {
    broadcast(user.id);
    res.status(500).json({ error: user.store.db.lastSyncError || gmail.plainSyncError(err) });
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

// The first-run choice is made (a Groq key saved, or the built-in rules): start reading.
app.post('/api/setup', (req, res) => {
  const user = req.account;
  user.finishSetup();
  res.json({ ok: true });
  broadcast(user.id);
  runSync(user);
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
    recordError('rescan', err, { userId: user.id, detail: "One application's emails" });
    res.status(500).json({ error: gmail.plainSyncError(err) });
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

const ownerOnly = (req, res, next) => canSeeReports(req.account) ? next() : res.status(403).json({ error: 'Only the person who runs this nuj can do that' });
app.get('/api/reports', ownerOnly, async (req, res) => res.json({ reports: await listReports() }));
// Re-read someone's emails with the current sorting, from their problem report. Their own
// edits are kept and a backup is made first, as with their Settings button.
app.post('/api/accounts/:id/rescan', ownerOnly, async (req, res) => {
  if (DEMO) return res.status(400).json({ error: 'Re-scan reads Gmail, so it is off in demo mode' });
  const user = await knownUser(req.params.id);
  const r = await rescanAccount(user && live(user), { onDone: u => broadcast(u.id) });
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.status(202).json({ started: true });
});
app.get('/api/access-requests', ownerOnly, async (req, res) => res.json({ requests: await listRequests() }));
app.patch('/api/access-requests/:id', ownerOnly, async (req, res) => {
  const r = await setRequestStatus(req.params.id, req.body?.status);
  if (!r) return res.status(404).json({ error: 'Not found' });
  tellOwner();
  res.json(r);
});

// How sorting is doing across everyone: emails filed, and how often people fix them.
// Totals only; nothing about anyone's applications or emails.
app.get('/api/reports/stats', ownerOnly, async (req, res) => {
  const people = DEMO ? [req.account] : await allUsers();
  const corrections = {};
  let emails = 0, withAi = 0;
  for (const user of people) {
    const db = user.store.db;
    if (user.groq()) withAi++;
    emails += db.applications.reduce((n, a) => n + a.events.filter(e => !e.manual).length, 0);
    for (const [kind, n] of Object.entries(db.corrections || {})) corrections[kind] = (corrections[kind] || 0) + n;
  }
  res.json({ accounts: people.length, withAi, emails, corrections });
});
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

// --- errors from people's browsers ------------------------------------------------
// The dashboard sends what crashed (a message and where), so it reaches the Developer
// page without anyone having to report it. A few an hour per person is plenty.
app.post('/api/client-errors', (req, res) => {
  const { message, where, view } = req.body || {};
  if (!message || tooMany(`client-errors:${req.account.id}`, { max: 30 })) return res.status(204).end();
  recordError('browser', String(message), { userId: req.account.id, detail: [where, view].filter(Boolean).join(' · ') });
  res.status(204).end();
});

// --- the Developer page (owner only) -----------------------------------------------
// How the server is doing, every account's health, and what went wrong. Counts and dates
// only: nothing here shows anyone's applications or emails.
app.get('/api/dev/overview', ownerOnly, async (req, res) => {
  const [errors, joined, reports] = await Promise.all([listErrors(), joinDates(), listReports()]);
  const openErrors = {}, openReports = {};
  for (const g of errors) if (g.status === 'open') for (const id of g.users) openErrors[id] = (openErrors[id] || 0) + 1;
  for (const r of reports) if (r.status === 'open' && r.userId) openReports[r.userId] = (openReports[r.userId] || 0) + 1;
  const people = DEMO ? [req.account] : (await allUsers()).filter(u => u.id !== LOCAL_ID || !authEnabled);
  const accounts = people.map(u => accountSummary(u, {
    joinedAt: joined[u.id] ?? null,
    allowed: !authEnabled || isAllowed(u.email),
    errors: openErrors[u.id] || 0,
    reports: openReports[u.id] || 0,
  }));
  if (DEMO) accounts.push(...buildDemoAccounts().map(a => ({ ...a, attention: attentionFor(a) })));
  const emails = Object.fromEntries(accounts.map(a => [a.id, a.email]));
  const asks = await listAsks();
  // Resume insights' AI, as counts: today's runs and how many people hit their limit.
  const aiUsage = await serverUsage();
  const withResume = (await Promise.all(people.map(u => listVersions(u.id)))).filter(v => v.length).length;
  for (const a of accounts) {
    const waiting = asks.find(x => !x.stoppedAt && x.userIds.includes(a.id) && !x.answers.some(y => y.userId === a.id) && !x.skipped.includes(a.id));
    a.feedbackAsked = waiting ? waiting.createdAt : null;
  }
  res.json({
    server: {
      startedAt: STARTED_AT,
      version: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
      node: process.version,
      storage: DEMO ? 'memory' : process.env.DATABASE_URL ? 'postgres' : 'files',
      memoryMb: Math.round(process.memoryUsage().rss / 1_048_576),
      syncMinutes: SYNC_MINUTES,
      lastSyncPassAt,
      lastCronAt,
      cronConfigured: CRON_SECRET.length >= 16,
      demo: DEMO,
      insights: { available: Boolean(AI_KEY) || DEMO, runs: aiUsage.runs, serverLimit: SERVER_DAILY_LIMIT, dailyLimit: DAILY_LIMIT, limited: aiUsage.limited.length, withResume },
    },
    accounts,
    // Each error with the addresses of the accounts it hit, for reading at a glance.
    errors: errors.map(g => ({ ...g, emails: g.users.map(id => emails[id] || null) })),
    feedback: {
      summary: summarize(asks),
      asks: asks.map(({ userIds, skipped, answers, ...rest }) => ({
        ...rest, asked: userIds.length, skipped: skipped.length,
        // An account without an address (running locally, or the demo) goes by its ID.
        who: userIds.length === 1 ? emails[userIds[0]] || userIds[0] : null,
        answers: answers.map(x => ({ ...x, askId: rest.id, email: emails[x.userId] || x.email || (x.userId in emails ? x.userId : null) })),
      })),
    },
  });
});

app.patch('/api/dev/errors/:id', ownerOnly, async (req, res) => {
  const g = await setErrorStatus(req.params.id, req.body?.status);
  if (!g) return res.status(404).json({ error: 'Not found' });
  tellOwner();
  res.json(g);
});
app.delete('/api/dev/errors/:id', ownerOnly, async (req, res) => {
  await deleteError(req.params.id);
  tellOwner();
  res.json({ ok: true });
});

// Ask one person, or everyone with access, how nuj is going. They see the questions the
// next time they open it. Everyone means everyone but you (in demo mode, you too, to try it).
app.post('/api/dev/feedback', ownerOnly, async (req, res) => {
  const to = String(req.body?.to || '');
  let userIds;
  if (to === 'everyone') {
    userIds = DEMO
      ? [req.account.id, ...buildDemoAccounts().filter(a => a.allowed).map(a => a.id)]
      : (await allUsers()).filter(u => u.id !== LOCAL_ID && !u.owner && isAllowed(u.email)).map(u => u.id);
  } else {
    const known = DEMO ? (to === req.account.id || buildDemoAccounts().some(a => a.id === to)) : Boolean(await knownUser(to));
    if (!known) return res.status(404).json({ error: 'No account with that ID' });
    userIds = [to];
  }
  const r = await ask({ userIds, everyone: to === 'everyone' });
  if (r.error) return res.status(400).json({ error: r.error });
  console.log(`[feedback] asked ${userIds.length} account(s)`);
  res.json({ asked: userIds.length });
});
// Mark answers read (or unread again): { items: [{ askId, userId }], read }.
app.post('/api/dev/feedback/read', ownerOnly, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 1000) : [];
  const changed = await markRead(items.map(i => ({ askId: String(i?.askId), userId: String(i?.userId) })), req.body?.read !== false);
  tellOwner();
  res.json({ changed });
});
app.post('/api/dev/feedback/:id/stop', ownerOnly, async (req, res) => {
  const a = await stopAsking(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Check someone's Gmail now instead of waiting for the next round.
app.post('/api/accounts/:id/sync', ownerOnly, async (req, res) => {
  if (DEMO) return res.status(400).json({ error: 'Syncing reads Gmail, so it is off in demo mode' });
  const user = await knownUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'No account with that ID' });
  if (!user.mailbox.connected()) return res.status(400).json({ error: "Their Gmail isn't connected" });
  if (user.needsSetup()) return res.status(400).json({ error: "They haven't chosen how to sort their emails yet" });
  res.status(202).json({ started: true });
  runSync(live(user));
});

// Delete someone's account when they ask (the privacy policy promises it within 30 days),
// the same as their own "Delete my account". Your own is deleted from Settings.
app.delete('/api/accounts/:id', ownerOnly, async (req, res) => {
  if (DEMO) return res.status(400).json({ error: 'There are no accounts to delete in demo mode' });
  const user = await knownUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'No account with that ID' });
  if (user.owner) return res.status(400).json({ error: 'Delete your own account from Settings' });
  await deleteUser(user.id);
  await deleteReportsBy(user.id);
  console.log(`[users] deleted ${user.id} (by the owner)`);
  broadcast(user.id); // their open tabs reload
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

// Anything a route didn't handle itself: noted for the Developer page, and a plain
// message for the person instead of a stack trace.
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: req.path.startsWith('/api/resume') ? 'That file is too big. nuj takes resumes up to 5 MB' : "That's more than nuj can take in one go" });
  }
  console.error(`[server] ${req.method} ${req.path}: ${err.stack || err.message}`);
  recordError('server', err, { userId: req.account?.id ?? null, detail: `${req.method} ${req.route?.path ?? req.path}` });
  if (res.headersSent) return next(err);
  res.status(err.status && err.status < 500 ? err.status : 500).json({ error: 'Something went wrong on our side. Try again in a moment' });
});
process.on('unhandledRejection', err => {
  console.error(`[server] unhandled: ${err?.stack || err}`);
  recordError('server', err ?? 'Unhandled rejection', { detail: 'Not tied to a request' });
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
// Loaded one at a time and let go again when idle, so a pass never holds everyone's tracker.
let syncingAll = null;
function runSyncAll() {
  if (DEMO || syncingAll) return syncingAll;
  syncingAll = (async () => {
    const ids = authEnabled ? (await userIds()).filter(id => id !== LOCAL_ID) : [LOCAL_ID];
    for (const id of ids) {
      const user = await getUser(id);
      if (authEnabled && !isAllowed(user.email)) continue;
      await runSync(live(user));
      await releaseIdle();
    }
    lastSyncPassAt = new Date().toISOString();
  })().catch(err => console.error(`[sync] ${err.message}`)).finally(() => { syncingAll = null; });
  return syncingAll;
}

// Trackers nobody has used for IDLE_MINUTES (and with no tab open) leave memory; see
// releaseIdleUsers. The next request or sync loads them again.
const IDLE_MS = Number(process.env.IDLE_MINUTES || 30) * 60_000;
async function releaseIdle() {
  try {
    await releaseIdleUsers({ idleMs: IDLE_MS, keep: user => clients.has(user.id) });
  } catch (err) {
    recordError('server', err, { detail: 'Letting go of idle trackers' });
  }
}

// Once after an update to sorting, everyone else's emails are read again (src/rescan-all.js).
async function rescanAll() {
  try {
    const people = (await allUsers()).filter(u => u.id !== LOCAL_ID && isAllowed(u.email));
    // Each waits its turn, so none may be let go of meanwhile (see releaseIdle).
    for (const u of people) u.holds++;
    try {
      await rescanEveryoneOnce(people.map(live), { onUser: user => broadcast(user.id) });
    } finally {
      for (const u of people) u.holds--;
    }
  } catch (err) {
    console.error(`[rescan-all] ${err.message}`);
  }
}

// --- start up / shut down ---------------------------------------------------
if (DEMO && authEnabled) throw new Error('Demo mode runs without sign-in; unset ALLOWED_EMAIL to use it');
checkAuthConfig();
await initStorage({ demo: DEMO });
if (DEMO) {
  await setKv('errors', buildDemoErrors());
  await setKv('feedback', buildDemoFeedback());
  // The demo's resumes as real PDFs, so the preview shows pages like an upload would.
  const resumes = buildDemoResumes();
  for (const v of resumes) {
    const pdf = textPdf(v.text);
    await setFile(`resume_pdf_${DEMO_ID}_${v.id}`, pdf);
    v.pdf = { size: pdf.length, at: v.updatedAt };
  }
  await setKv(`resumes_${DEMO_ID}`, resumes);
}
await initSecrets();

app.listen(PORT, HOST, () => {
  console.log(`nuj running at ${gmail.PUBLIC_URL} (listening on ${HOST}:${PORT})`);
  if (DEMO) return console.log('Demo mode: sample data, kept in memory only. Nothing is read from Gmail or saved.');
  console.log(`Storage: ${process.env.DATABASE_URL ? 'Postgres' : 'local files in data/'} · Groq: ${SERVER_KEY ? 'server key for the owner, others add their own' : 'each person adds their own key'} · sign-in: ${authEnabled ? 'Google' : 'off (local)'}`);
  runSyncAll();
  setInterval(runSyncAll, SYNC_MINUTES * 60_000);
  setInterval(releaseIdle, 10 * 60_000).unref();
  // After the start-up sync has had its turn.
  if (authEnabled) setTimeout(rescanAll, 60_000);
});

// Render stops the old instance on every deploy; write pending changes first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await Promise.all([flushAll(), flushErrors()]);
    process.exit(0);
  });
}
