// What went wrong on the server and in people's browsers, for the owner's Developer page.
// Errors are grouped: the same problem (once numbers, IDs and addresses are taken out of
// its message) is one entry with a count, when it was first and last seen, and which
// accounts it hit, so a sync failing every five minutes doesn't bury everything else.
// Messages are clipped and email addresses removed: this is about what broke, not
// what anyone's emails say.
import crypto from 'node:crypto';
import { getKv, setKv } from './store.js';

const KEY = 'errors';
const MAX_GROUPS = 300;
const MAX_SAMPLES = 5; // the latest few occurrences of each, with their details
const MAX_USERS = 50;
const SAVE_DELAY_MS = 2000;
export const SOURCES = ['sync', 'gmail', 'groq', 'server', 'sign-in', 'rescan', 'browser'];
export const LEVELS = ['error', 'warning'];

let groups = null; // id -> group, loaded once
let loading = null;
let timer = null;

const EMAIL = /[^\s@<>()"']+@[^\s@<>()"']+\.[a-z]{2,}/gi;
const clip = (s, n) => String(s ?? '').replace(EMAIL, '[email]').trim().slice(0, n);

// The message with the parts that change from one time to the next replaced, so the
// same problem always lands in the same group.
export function fingerprint(source, message) {
  const shape = clip(message, 300).toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '#')
    .replace(/\b[0-9a-f]{12,}\b/g, '#')
    .replace(/\d+(\.\d+)?/g, '#');
  return crypto.createHash('sha1').update(`${source}\n${shape}`).digest('hex').slice(0, 16);
}

async function load() {
  if (groups) return groups;
  loading ??= getKv(KEY).then(list => {
    groups = new Map((list || []).map(g => [g.id, g]));
    return groups;
  });
  return loading;
}

function save() {
  clearTimeout(timer);
  timer = setTimeout(flushErrors, SAVE_DELAY_MS);
  timer.unref?.(); // a pending save never keeps the process (or a test run) alive
}

export async function flushErrors() {
  clearTimeout(timer);
  timer = null;
  if (!groups) return;
  // The most recent first; the oldest drop off once there are too many.
  const list = [...groups.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, MAX_GROUPS);
  groups = new Map(list.map(g => [g.id, g]));
  await setKv(KEY, list).catch(err => console.error(`[errors] saving failed: ${err.message}`));
}

// Note something that went wrong. err: an Error or a message. userId: whose account it
// happened in, if anyone's. detail: a little extra (a route, a file and line) shown with it.
// Never throws: logging an error mustn't cause another.
export async function recordError(source, err, { userId = null, level = 'error', detail = '' } = {}) {
  try {
    const message = clip(err?.message ?? err, 300) || 'Unknown error';
    const src = SOURCES.includes(source) ? source : 'server';
    const id = fingerprint(src, message);
    const now = new Date().toISOString();
    const all = await load();
    let g = all.get(id);
    if (!g) {
      g = { id, source: src, level: LEVELS.includes(level) ? level : 'error', message, count: 0,
        firstAt: now, lastAt: now, users: [], samples: [], status: 'open' };
      all.set(id, g);
    }
    // Back after you marked it fixed: open again, and say so.
    if (g.status === 'resolved') { g.status = 'open'; g.regressed = true; }
    g.count++;
    g.lastAt = now;
    g.message = message; // the latest wording
    if (userId && !g.users.includes(userId)) g.users = [userId, ...g.users].slice(0, MAX_USERS);
    g.samples = [{ at: now, userId, detail: clip(detail, 300), message }, ...g.samples].slice(0, MAX_SAMPLES);
    save();
    return g;
  } catch (e) {
    console.error(`[errors] couldn't record an error: ${e.message}`);
    return null;
  }
}

export async function listErrors() {
  return [...(await load()).values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export async function openErrorCount() {
  return [...(await load()).values()].filter(g => g.status === 'open' && g.level === 'error').length;
}

export async function setErrorStatus(id, status) {
  const g = (await load()).get(id);
  if (!g) return null;
  g.status = status === 'resolved' ? 'resolved' : 'open';
  if (g.status === 'resolved') { g.resolvedAt = new Date().toISOString(); delete g.regressed; }
  save();
  return g;
}

export async function deleteError(id) {
  const removed = (await load()).delete(id);
  if (removed) save();
  return removed;
}

// Deleting an account takes its name off every error; errors only it had go entirely.
export async function forgetUserErrors(userId) {
  const all = await load();
  for (const [id, g] of all) {
    if (!g.users.includes(userId)) continue;
    g.users = g.users.filter(u => u !== userId);
    g.samples = g.samples.filter(s => s.userId !== userId);
    if (!g.users.length && !g.samples.length) all.delete(id);
  }
  save();
}

// For tests: start again from storage.
export function resetErrorsForTests() {
  clearTimeout(timer);
  groups = null;
  loading = null;
}
