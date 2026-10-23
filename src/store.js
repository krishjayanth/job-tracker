import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeStatus } from './stages.js';
import { buildDemoDb } from './demo.js';

// Storage: Postgres when DATABASE_URL is set (hosted, e.g. Neon), otherwise JSON
// files in data/ (local). Either way it's a key-value table of JSON values, and each
// person's tracker is one JSON document (db_<user id>) held in memory while in use;
// writes are batched so a sync of many emails doesn't hammer the database.
// Demo mode keeps everything in memory only, starting from sample data.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const SAVE_DELAY_MS = 800;

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
  matchApplication({ threadId, company, role, jobId }) {
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
    const several = sameCompany.length > 1;
    // A job ID is the strongest signal: same ID is the same job; a different ID is a different job.
    if (jobId) {
      const byId = sameCompany.find(a => a.jobId === jobId);
      if (byId) return { app: byId, guess: false };
      sameCompany = sameCompany.filter(a => !a.jobId);
      if (sameCompany.length === 0) return none;
    }
    if (role) {
      // Same job worded slightly differently across emails ("Software Engineer Intern"
      // vs "Software Engineer Intern | Enterprise Technology") counts as a match.
      const r = normalizeCompany(role);
      const exact = sameCompany.find(a => {
        const ar = normalizeCompany(a.role);
        return ar && (ar.includes(r) || r.includes(ar));
      });
      if (exact) return { app: exact, guess: false };
      // A different, known role at the same company is a separate application.
      const unknownRole = sameCompany.filter(a => !a.role);
      if (unknownRole.length) return { app: unknownRole.at(-1), guess: several };
      return none;
    }
    return { app: sameCompany.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))[0], guess: several };
  }

  // Where you've said an email belongs. Kept by Gmail message id so a re-scan puts it
  // back: by application id, else by another email of that application, else by name.
  assignedApplication(messageId) {
    const to = this.db.assignments[messageId];
    if (!to) return null;
    return this.db.applications.find(a => a.id === to.appId) ||
      this.db.applications.find(a => a.events.some(e => to.anchors?.includes(e.messageId))) ||
      this.findApplication({ company: to.company, role: to.role, jobId: to.jobId }) ||
      this.createApplication({ company: to.company, role: to.role, jobId: to.jobId, source: 'gmail' });
  }

  // Your answer to "is this email filed under the right application?":
  //   confirm          it is; stop asking
  //   move, to         it belongs to another application
  //   new, company…    it belongs to an application that isn't in the tracker yet
  //   ignore           it isn't about an application at all
  // Returns {app} (where the email is now, or null), or {error, status}.
  reassignEmail(eventId, { action, to, company, role = '', jobId = '' }) {
    const db = this.db;
    const from = db.applications.find(a => a.events.some(e => e.id === eventId));
    if (!from) return { error: 'Email not found', status: 404 };
    const event = from.events.find(e => e.id === eventId);

    let target = null;
    if (action === 'confirm') target = from;
    else if (action === 'move') target = db.applications.find(a => a.id === to);
    else if (action === 'new') {
      if (!company?.trim()) return { error: 'Company is required', status: 400 };
      target = this.createApplication({ company: company.trim(), role: role.trim(), jobId: jobId.trim(), source: 'gmail' });
    } else if (action !== 'ignore') return { error: 'Unknown action', status: 400 };
    if (action === 'move' && !target) return { error: 'Application not found', status: 404 };

    if (target !== from) from.events = from.events.filter(e => e !== event);
    if (target) {
      if (target !== from) target.events.push(event);
      event.reviewed = true;
      if (event.messageId) {
        db.assignments[event.messageId] = {
          appId: target.id, company: target.company, role: target.role, jobId: target.jobId,
          anchors: target.events.filter(e => e.messageId && e !== event).map(e => e.messageId).slice(0, 5),
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
