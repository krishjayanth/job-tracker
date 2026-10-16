import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeStatus } from './stages.js';
import { buildDemoDb } from './demo.js';

// Storage: Postgres when DATABASE_URL is set (hosted, e.g. Neon), otherwise JSON
// files in data/ (local). Either way the whole tracker is one JSON document held in
// memory; writes are batched so a sync of many emails doesn't hammer the database.
// Demo mode keeps everything in memory only, starting from sample data.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SAVE_DELAY_MS = 800;

const emptyDb = () => ({ applications: [], processed: {}, lastSync: null, lastSyncError: null });
let db = emptyDb();
let pool = null;
let memory = null; // Map of key -> value in demo mode; nothing touches disk

export const usingDatabase = () => Boolean(pool);

export async function initStore({ demo = false } = {}) {
  if (demo) {
    memory = new Map();
    db = buildDemoDb();
    for (const a of db.applications) refresh(a);
  } else if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    await pool.query(`create table if not exists app_state (
      key text primary key, value jsonb not null, updated_at timestamptz not null default now())`);
    const { rows } = await pool.query(`select value from app_state where key = 'db'`);
    db = rows[0]?.value ?? emptyDb();
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = emptyDb(); }
  }
}

let saveTimer = null;
let writing = Promise.resolve();

export function save() {
  if (memory) return;
  if (!pool) {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY_MS);
}

// Write pending changes now (before shutdown, or when a step must be durable).
export function flush() {
  clearTimeout(saveTimer);
  if (!pool) return Promise.resolve();
  const value = JSON.stringify(db);
  writing = writing
    .then(() => setKv('db', value, true))
    .catch(err => console.error(`[store] save failed: ${err.message}`));
  return writing;
}

// Small extra values (the Gmail sign-in token, backups) stored next to the data.
export async function getKv(key) {
  if (memory) return memory.get(key) ?? null;
  if (pool) {
    const { rows } = await pool.query('select value from app_state where key = $1', [key]);
    return rows[0]?.value ?? null;
  }
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${key}.json`), 'utf8')); } catch { return null; }
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
    fs.writeFileSync(path.join(DATA_DIR, `${key}.json`), json);
  }
}

export async function deleteKv(key) {
  if (memory) memory.delete(key);
  else if (pool) await pool.query('delete from app_state where key = $1', [key]);
  else fs.rmSync(path.join(DATA_DIR, `${key}.json`), { force: true });
}

export const getDb = () => db;
export const newId = () => crypto.randomUUID();

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

// Snapshot the hand-made parts of Gmail-built applications before a re-scan.
export function snapshotEdits() {
  return db.applications
    .filter(a => a.source === 'gmail' && userEdited(a))
    .map(a => ({ messageIds: a.events.filter(e => e.messageId).map(e => e.messageId), app: structuredClone(a) }));
}

// Re-apply a snapshot onto the freshly rebuilt applications, matched by email.
export function restoreEdits(snapshots) {
  let restored = 0, kept = 0;
  for (const { messageIds, app: old } of snapshots) {
    const target = db.applications.find(a => a.events.some(e => messageIds.includes(e.messageId)));
    if (!target) {
      // Its emails no longer count as an application; keep yours rather than lose it.
      db.applications.push(old);
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

export async function backup(name) {
  await flush();
  await setKv(name, structuredClone(db));
}

export function createApplication({ company, role = '', jobId = '', url = '', notes = '', source = 'manual' }) {
  const now = new Date().toISOString();
  const app = {
    id: newId(), company, role, jobId, url, notes, source,
    createdAt: now, status: 'applied', lastActivity: now, appliedAt: now, events: [],
  };
  db.applications.push(app);
  return app;
}

// Find which application an email belongs to: same Gmail thread first, then same
// company (+ role when both sides know it), otherwise null.
export function findApplication({ threadId, company, role, jobId }) {
  if (threadId) {
    const byThread = db.applications.find(a => a.events.some(e => e.threadId === threadId));
    if (byThread) return byThread;
  }
  const key = normalizeCompany(company);
  if (!key) return null;
  // Aliases remember the names an application had before you renamed it.
  let sameCompany = db.applications.filter(a =>
    [a.company, ...(a.aliases || [])].some(name => normalizeCompany(name) === key));
  if (sameCompany.length === 0) return null;
  // A job ID is the strongest signal: same ID is the same job; a different ID is a different job.
  if (jobId) {
    const byId = sameCompany.find(a => a.jobId === jobId);
    if (byId) return byId;
    sameCompany = sameCompany.filter(a => !a.jobId);
    if (sameCompany.length === 0) return null;
  }
  if (role) {
    // Same job worded slightly differently across emails ("Software Engineer Intern"
    // vs "Software Engineer Intern | Enterprise Technology") counts as a match.
    const r = normalizeCompany(role);
    const exact = sameCompany.find(a => {
      const ar = normalizeCompany(a.role);
      return ar && (ar.includes(r) || r.includes(ar));
    });
    if (exact) return exact;
    // A different, known role at the same company is a separate application.
    const unknownRole = sameCompany.filter(a => !a.role);
    if (unknownRole.length) return unknownRole.at(-1);
    return null;
  }
  return sameCompany.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))[0];
}
