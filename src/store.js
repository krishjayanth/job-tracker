import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeStatus } from './stages.js';
import { buildDemoDb } from './demo.js';
import { senderDomain } from './jobcheck.js';

// Storage: Postgres when DATABASE_URL is set (hosted, e.g. Neon), otherwise JSON
// files in data/ (local). Either way it's a key-value table of JSON values, and each
// person's tracker is one JSON document (db_<user id>) held in memory while in use;
// writes are batched so a sync of many emails doesn't hammer the database.
// Demo mode keeps everything in memory only, starting from sample data.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const SAVE_DELAY_MS = 800;
const UNDO_MS = 10 * 60_000; // how long an action can be undone

export const emptyDb = () => ({ applications: [], processed: {}, ignored: {}, assignments: {}, lastSync: null, lastSyncError: null });
let pool = null;
let memory = null; // Map of key -> value in demo mode; nothing touches disk
let demoMode = false;

export const usingDatabase = () => Boolean(pool);

// inMemory without demo (for tests): nothing stored, no sample data.
export async function initStorage({ demo = false, inMemory = demo } = {}) {
  if (inMemory) {
    memory = new Map();
    demoMode = demo;
  } else if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    await pool.query(`create table if not exists app_state (
      key text primary key, value jsonb not null, updated_at timestamptz not null default now())`);
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ---- key-value storage ----------------------------------------------------------

const kvFile = key => path.join(DATA_DIR, `${key}.json`);

export async function getKv(key) {
  if (memory) return memory.get(key) ?? null;
  if (pool) {
    const { rows } = await pool.query('select value from app_state where key = $1', [key]);
    return rows[0]?.value ?? null;
  }
  try { return JSON.parse(fs.readFileSync(kvFile(key), 'utf8')); } catch { return null; }
}

export async function setKv(key, value, alreadyJson = false) {
  const json = alreadyJson ? value : JSON.stringify(value);
  if (memory) {
    memory.set(key, JSON.parse(json));
  } else if (pool) {
    await pool.query(
      `insert into app_state (key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`, [key, json]);
  } else {
    // Write then rename, so a crash mid-write never leaves half a file.
    const tmp = `${kvFile(key)}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, kvFile(key));
  }
}

export async function deleteKv(key) {
  if (memory) memory.delete(key);
  else if (pool) await pool.query('delete from app_state where key = $1', [key]);
  else fs.rmSync(kvFile(key), { force: true });
}

export const newId = () => crypto.randomUUID();

// ---- one tracker per person ---------------------------------------------------------

const stores = new Map(); // user id -> Promise<Store>

// The tracker for this user, loaded once and kept in memory.
export function openStore(userId) {
  if (!stores.has(userId)) {
    stores.set(userId, (async () => {
      const key = `db_${userId}`;
      let db = await getKv(key);
      if (!db && demoMode) {
        db = buildDemoDb();
        for (const a of db.applications) refresh(a);
      }
      return new Store(key, db ?? emptyDb(), { persist: !memory });
    })());
  }
  return stores.get(userId);
}

// Forget a user's tracker (account deleted); pending writes are dropped.
export async function closeStore(userId) {
  const store = await stores.get(userId);
  store?.discard();
  stores.delete(userId);
}

// Write every tracker's pending changes (before shutdown).
export async function flushAll() {
  await Promise.all([...stores.values()].map(async p => (await p).flush()));
}

export function normalizeCompany(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|labs|group)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Recompute derived fields after any change to an application's events.
export function refresh(app) {
  app.events.sort((a, b) => a.date.localeCompare(b.date));
  app.status = computeStatus(app.events);
  app.lastActivity = app.events.at(-1)?.date ?? app.createdAt;
  app.appliedAt = app.events[0]?.date ?? app.createdAt;
  app.deadline = activeDeadline(app);
  app.needsReview = app.events.some(e => e.review?.length && !e.reviewed);
  return app;
}

// The deadline that's still open: from the latest email that set one, unless a later
// email arrived (usually "thanks for completing...") or you marked it done. A date you
// typed in yourself wins over the emails.
function activeDeadline(app) {
  if (app.status === 'rejected' || app.status === 'withdrawn') return null;
  let fromEmail = null;
  for (const e of app.events) {
    if (e.deadline) fromEmail = e.deadline;
    else if (!e.manual) fromEmail = null;
  }
  const deadline = app.manualDeadline || fromEmail;
  return deadline && deadline !== app.deadlineDone ? deadline : null;
}

// ---- two applications at the same company ----------------------------------------
// An email joins an application by thread, job ID, or company + role. Applying to the
// same place again later looks the same by name, so the date the email was sent
// decides: a "thanks for applying" email (stage applied) starts a new application when
// the one it would join had, before that email,
//   - been closed (rejected or withdrawn) at least CLOSED_GAP_DAYS earlier, or
//   - heard nothing for more than SILENT_GAP_DAYS (an offer included).
// Any other email (assessment, interview, offer, rejection) joins as before however late
// it comes, so follow-ups stay with their application. Same thread or same job ID always
// joins: those aren't decided here.
export const CLOSED_GAP_DAYS = 1;
export const SILENT_GAP_DAYS = 120;
const CLOSED = new Set(['rejected', 'withdrawn']);
const isClosed = a => CLOSED.has(a.status);
const daysBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

export function startsNewApplication(app, { date, stage }) {
  if (stage !== 'applied' || !date) return false;
  const before = app.events.filter(e => e.date <= date);
  if (!before.length) return false;
  const last = before.reduce((m, e) => (e.date > m ? e.date : m), before[0].date);
  if (CLOSED.has(computeStatus(before))) return daysBetween(last, date) >= CLOSED_GAP_DAYS;
  return daysBetween(last, date) > SILENT_GAP_DAYS;
}

// ---- re-scan support: keep what you changed by hand ---------------------------

const userEdited = a =>
  a.events.some(e => e.manual) || a.renamed || a.notes || a.url || a.edited ||
  a.manualDeadline || a.deadlineDone || a.notifiedDeadline;

// One person's applications and sync bookkeeping, with everything that reads or
// changes them. Nothing here can reach another person's data.
export class Store {
  constructor(key, db = emptyDb(), { persist = false } = {}) {
    this.key = key;
    this.db = db;
    this.db.ignored ??= {};
    this.db.assignments ??= {};
    this.undoable = new Map(); // token -> how things looked before an action (see checkpoint)
    this.persist = persist;
    this.saveTimer = null;
    this.writing = Promise.resolve();
  }

  get applications() { return this.db.applications; }

  save() {
    if (!this.persist) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  // Write pending changes now (before shutdown, or when a step must be durable).
  flush() {
    clearTimeout(this.saveTimer);
    if (!this.persist) return Promise.resolve();
    const value = JSON.stringify(this.db);
    this.writing = this.writing
      .then(() => setKv(this.key, value, true))
      .catch(err => console.error(`[store] saving ${this.key} failed: ${err.message}`));
    return this.writing;
  }

  discard() {
    clearTimeout(this.saveTimer);
    this.persist = false;
  }

  // A copy of the whole tracker under "<name>_<user id>".
  async backup(name) {
    await this.flush();
    await setKv(`${name}_${this.key.replace(/^db_/, '')}`, structuredClone(this.db));
  }

  // Snapshot the hand-made parts of Gmail-built applications before a re-scan.
  snapshotEdits() {
    return this.db.applications
      .filter(a => a.source === 'gmail' && userEdited(a))
      .map(a => ({ messageIds: a.events.filter(e => e.messageId).map(e => e.messageId), app: structuredClone(a) }));
  }

  // Re-apply a snapshot onto the freshly rebuilt applications, matched by email.
  restoreEdits(snapshots) {
    let restored = 0, kept = 0;
    for (const { messageIds, app: old } of snapshots) {
      const target = this.db.applications.find(a => a.events.some(e => messageIds.includes(e.messageId)));
      if (!target) {
        // Its emails no longer count as an application; keep yours rather than lose it.
        this.db.applications.push(old);
        kept++;
        continue;
      }
      if (old.renamed) {
        target.aliases = [...new Set([...(target.aliases || []), ...(old.aliases || []), target.company])]
          .filter(n => n !== old.company);
        target.company = old.company;
        target.renamed = true;
      }
      if (old.edited) {
        for (const field of Object.keys(old.edited)) target[field] = old[field];
        target.edited = { ...target.edited, ...old.edited };
      }
      for (const field of ['notes', 'url', 'manualDeadline', 'deadlineDone', 'notifiedDeadline']) {
        if (old[field]) target[field] = old[field];
      }
      const ids = new Set(target.events.map(e => e.id));
      target.events.push(...old.events.filter(e => e.manual && !ids.has(e.id)));
      refresh(target);
      restored++;
    }
    return { restored, kept };
  }

  createApplication({ company, role = '', jobId = '', url = '', notes = '', source = 'manual' }) {
    const now = new Date().toISOString();
    const app = {
      id: newId(), company, role, jobId, url, notes, source,
      createdAt: now, status: 'applied', lastActivity: now, appliedAt: now, events: [],
    };
    this.db.applications.push(app);
    return app;
  }

  // ---- undo ----------------------------------------------------------------------
  // Before an action that removes or moves things, remember how the applications it
  // touches looked. undo(token) puts them back exactly: their emails, what you'd
  // said about those emails, and the counts. Kept in memory for UNDO_MS.
  checkpoint(appIds, { blockedSender } = {}) {
    this.pruneUndo();
    const apps = appIds.map(id => this.db.applications.find(a => a.id === id)).filter(Boolean).map(a => structuredClone(a));
    const messageIds = apps.flatMap(a => a.events.map(e => e.messageId).filter(Boolean));
    const token = newId();
    this.undoable.set(token, {
      at: Date.now(), apps, blockedSender, remove: [],
      ignored: Object.fromEntries(messageIds.map(m => [m, this.db.ignored[m]])),
      assignments: Object.fromEntries(messageIds.map(m => [m, structuredClone(this.db.assignments[m])])),
      corrections: structuredClone(this.db.corrections || {}),
    });
    return token;
  }

  // An application the action created (e.g. "move to a new application"): undo removes it.
  undoAlsoRemoves(token, appId) {
    this.undoable.get(token)?.remove.push(appId);
  }

  undo(token) {
    const cp = this.undoable.get(token);
    if (!cp) return false;
    this.undoable.delete(token);
    const db = this.db;
    const putBack = new Set(cp.apps.map(a => a.id));
    // Emails that moved elsewhere come back with their application, so take them out
    // of wherever they went first.
    const eventIds = new Set(cp.apps.flatMap(a => a.events.map(e => e.id)));
    // Anything a sync added to these applications since then stays.
    for (const old of cp.apps) {
      const now = db.applications.find(a => a.id === old.id);
      const added = now?.events.filter(e => !eventIds.has(e.id)) || [];
      if (added.length) { old.events.push(...added); refresh(old); }
    }
    db.applications = db.applications.filter(a => !putBack.has(a.id) && !cp.remove.includes(a.id));
    for (const a of db.applications) {
      if (!a.events.some(e => eventIds.has(e.id))) continue;
      a.events = a.events.filter(e => !eventIds.has(e.id));
      refresh(a);
    }
    db.applications = db.applications.filter(a => a.events.length);
    db.applications.push(...cp.apps);
    for (const [m, was] of Object.entries(cp.ignored)) if (was) db.ignored[m] = was; else delete db.ignored[m];
    for (const [m, was] of Object.entries(cp.assignments)) if (was) db.assignments[m] = was; else delete db.assignments[m];
    if (cp.blockedSender) delete db.blockedSenders?.[cp.blockedSender];
    db.corrections = cp.corrections;
    return true;
  }

  pruneUndo() {
    for (const [token, cp] of this.undoable) if (Date.now() - cp.at > UNDO_MS) this.undoable.delete(token);
  }

  // Each time you fix how an email was sorted, counted by kind, so the owner can see
  // how often sorting needs help (Reports page). Counts only, nothing about the emails.
  noteCorrection(kind, n = 1) {
    this.db.corrections ??= {};
    this.db.corrections[kind] = (this.db.corrections[kind] || 0) + n;
  }

  // Senders you've said never send job emails (by domain): skipped by every sync, and
  // what's already filed from them is removed. Returns how many emails were removed.
  blockSender(domain) {
    const db = this.db;
    db.blockedSenders ??= {};
    db.blockedSenders[domain] = { at: new Date().toISOString() };
    const fromIt = e => !e.manual && e.from && senderDomain(e.from) === domain;
    let removed = 0;
    for (const a of db.applications) {
      const gone = a.events.filter(fromIt);
      if (!gone.length) continue;
      removed += gone.length;
      for (const e of gone) {
        if (e.messageId) db.ignored[e.messageId] = true;
        if (e.messageId) delete db.assignments[e.messageId];
      }
      a.events = a.events.filter(e => !fromIt(e));
      if (a.events.length) refresh(a);
    }
    db.applications = db.applications.filter(a => a.events.length);
    this.noteCorrection('senderBlocked');
    return removed;
  }

  // Start reading a sender again. Emails removed when it was blocked stay removed.
  unblockSender(domain) {
    delete this.db.blockedSenders?.[domain];
  }

  isBlocked(from) {
    const domain = senderDomain(from);
    return Boolean(domain && this.db.blockedSenders?.[domain]);
  }

  // Delete an application, remembering its emails so a re-scan doesn't bring it back.
  deleteApplication(id) {
    const gone = this.db.applications.find(x => x.id === id);
    for (const e of gone?.events || []) if (e.messageId) this.db.ignored[e.messageId] = true;
    this.db.applications = this.db.applications.filter(x => x.id !== id);
  }

  // Find which application an email belongs to: same Gmail thread first, then same
  // company (+ role when both sides know it), otherwise null.
  findApplication(email) {
    return this.matchApplication(email).app;
  }

  // Like findApplication, plus how sure the match is: `guess` is true when the email
  // was put with one of several applications at that company without a role or ID to go on.
  // Given the email's `date` and `stage`, a fresh "thanks for applying" sent after an
  // application ended doesn't join it (see startsNewApplication).
  matchApplication({ threadId, company, role, jobId, date, stage }) {
    const none = { app: null, guess: false };
    if (threadId) {
      const byThread = this.db.applications.find(a => a.events.some(e => e.threadId === threadId));
      if (byThread) return { app: byThread, guess: false, thread: true };
    }
    const key = normalizeCompany(company);
    if (!key) return none;
    // Aliases remember the names an application had before you renamed it.
    let sameCompany = this.db.applications.filter(a =>
      [a.company, ...(a.aliases || [])].some(name => normalizeCompany(name) === key));
    if (sameCompany.length === 0) return none;
    // A job ID is the strongest signal: same ID is the same job; a different ID is a different job.
    if (jobId) {
      const byId = sameCompany.find(a => a.jobId === jobId);
      if (byId) return { app: byId, guess: false };
      sameCompany = sameCompany.filter(a => !a.jobId);
    }
    if (date) sameCompany = sameCompany.filter(a => !startsNewApplication(a, { date, stage }));
    if (sameCompany.length === 0) return none;
    const several = sameCompany.length > 1;
    if (role) {
      // Same job worded slightly differently across emails ("Software Engineer Intern"
      // vs "Software Engineer Intern | Enterprise Technology") counts as a match.
      // Applied for it more than once: the one still open, else the latest.
      const r = normalizeCompany(role);
      const exact = sameCompany.filter(a => {
        const ar = normalizeCompany(a.role);
        return ar && (ar.includes(r) || r.includes(ar));
      }).sort((a, b) => isClosed(a) - isClosed(b) || b.appliedAt.localeCompare(a.appliedAt))[0];
      if (exact) return { app: exact, guess: false };
      // A different, known role at the same company is a separate application.
      const unknownRole = sameCompany.filter(a => !a.role);
      if (unknownRole.length) return { app: unknownRole.at(-1), guess: several, candidates: several ? sameCompany : undefined };
      return none;
    }
    sameCompany.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    // `candidates`: the applications it could be, for something smarter than "the latest" to choose from.
    return { app: sameCompany[0], guess: several, candidates: several ? sameCompany : undefined };
  }

  // Where you've said an email belongs. Kept by Gmail message id so a re-scan puts it
  // back: by application id, else by another email of that application, else by name.
  // Emails you split off into a new application (`separate`) never go back by name: that
  // would put them straight back on the application they were split from.
  assignedApplication(messageId) {
    const to = this.db.assignments[messageId];
    if (!to) return null;
    return this.db.applications.find(a => a.id === to.appId) ||
      this.db.applications.find(a => a.events.some(e => to.anchors?.includes(e.messageId))) ||
      (!to.separate && this.findApplication({ company: to.company, role: to.role, jobId: to.jobId })) ||
      this.createApplication({ company: to.company, role: to.role, jobId: to.jobId, source: 'gmail' });
  }

  // Your answer to "is this email filed under the right application?":
  //   confirm          it is; stop asking
  //   move, to         it belongs to another application
  //   new, company…    it's a separate application: split it off into a new one, taking
  //                    `also` (ids of more emails from this application) with it
  //   ignore           it isn't about an application at all
  // Returns {app} (where the email is now, or null), or {error, status}.
  reassignEmail(eventId, { action, to, company, role = '', jobId = '', also = [] }) {
    const db = this.db;
    const from = db.applications.find(a => a.events.some(e => e.id === eventId));
    if (!from) return { error: 'Email not found', status: 404 };
    const event = from.events.find(e => e.id === eventId);
    const moving = [event];
    if (action === 'new' && Array.isArray(also)) {
      moving.push(...from.events.filter(e => e !== event && !e.manual && also.includes(e.id)));
    }

    let target = null;
    if (action === 'confirm') target = from;
    else if (action === 'move') target = db.applications.find(a => a.id === to);
    else if (action === 'new') {
      if (!company?.trim()) return { error: 'Company is required', status: 400 };
      // The job ID comes from the emails split off, when one of them has it.
      const id = jobId.trim() || moving.find(e => e.jobId)?.jobId || '';
      target = this.createApplication({ company: company.trim(), role: role.trim(), jobId: id, source: 'gmail' });
    } else if (action !== 'ignore') return { error: 'Unknown action', status: 400 };
    if (action === 'move' && !target) return { error: 'Application not found', status: 404 };
    this.noteCorrection({ confirm: 'confirmed', move: 'moved', new: 'moved', ignore: 'notJob' }[action], moving.length);

    if (target !== from) from.events = from.events.filter(e => !moving.includes(e));
    if (target) {
      if (target !== from) target.events.push(...moving);
      for (const e of moving) {
        e.reviewed = true;
        if (!e.messageId) continue;
        db.assignments[e.messageId] = {
          appId: target.id, company: target.company, role: target.role, jobId: target.jobId,
          anchors: target.events.filter(x => x.messageId && x !== e).map(x => x.messageId).slice(0, 5),
          ...(action === 'new' && { separate: true }),
        };
      }
      refresh(target);
    } else if (event.messageId) {
      db.ignored[event.messageId] = true;
      delete db.assignments[event.messageId];
    }
    // An application whose only email just left has nothing to show.
    if (from.events.length === 0) db.applications = db.applications.filter(a => a !== from);
    else refresh(from);
    return { app: target };
  }
}
