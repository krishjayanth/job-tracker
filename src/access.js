// Invite requests from the landing page, for the owner to read on the Reports page.
// The form is public, so everything here assumes the input could be junk: fields are
// trimmed and capped, one address keeps one request, and the list is capped too.
import crypto from 'node:crypto';
import { getKv, setKv } from './store.js';

const KEY = 'access_requests';
const MAX_REQUESTS = 1000;
export const STAGES = ['starting', 'applying', 'interviewing', 'other'];
const EMAIL = /^[^\s@<>()]{1,64}@[^\s@<>()]+\.[a-z]{2,}$/i;

let chain = Promise.resolve();
// Read-modify-write one at a time, so two requests arriving together both land.
function update(fn) {
  const run = chain.then(async () => {
    const list = (await getKv(KEY)) || [];
    const result = fn(list);
    await setKv(KEY, list.slice(0, MAX_REQUESTS));
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

export async function listRequests() {
  await chain;
  return (await getKv(KEY)) || [];
}

export const pendingCount = async () => (await listRequests()).filter(r => r.status === 'pending').length;

const clip = (s, n) => String(s ?? '').trim().slice(0, n);

// Returns { request } or { error } (shown to the visitor, so in plain words).
export function addRequest({ name, email, stage, note }) {
  const clean = {
    name: clip(name, 100),
    email: clip(email, 254).toLowerCase(),
    stage: STAGES.includes(stage) ? stage : 'other',
    note: clip(note, 1000),
  };
  if (!clean.name) return Promise.resolve({ error: 'Add your name' });
  if (!EMAIL.test(clean.email)) return Promise.resolve({ error: "That email address doesn't look right" });
  return update(list => {
    // Asking twice updates the first request instead of adding another.
    const existing = list.find(r => r.email === clean.email);
    if (existing) {
      Object.assign(existing, clean, { updatedAt: new Date().toISOString() });
      if (existing.status === 'dismissed') existing.status = 'pending';
      return { request: existing, repeat: true };
    }
    const request = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'pending', ...clean };
    list.unshift(request);
    return { request };
  });
}

export function setRequestStatus(id, status) {
  return update(list => {
    const r = list.find(x => x.id === id);
    if (r) r.status = ['pending', 'invited', 'dismissed'].includes(status) ? status : r.status;
    return r || null;
  });
}

// A small per-visitor limit on the public form, kept in memory (it resets on restart,
// which is fine: it only has to stop someone hammering the button).
const hits = new Map(); // key -> [timestamps]
export function tooMany(key, { max = 5, windowMs = 60 * 60_000 } = {}) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) hits.clear(); // don't let the map grow without bound
  return recent.length > max;
}
