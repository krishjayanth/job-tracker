import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeStatus } from './stages.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

let db = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { applications: [], processed: {}, lastSync: null, lastSyncError: null };
  }
}

export function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
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
  return app;
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
