// Problem reports people send from the app, for the owner to read on the Reports page.
// One shared list in storage (newest first), capped so it can't grow without bound.
import crypto from 'node:crypto';
import { getKv, setKv } from './store.js';

const KEY = 'reports';
const MAX_REPORTS = 500;
const MAX_PER_DAY = 20; // per person, so a stuck button can't flood the list
export const KINDS = ['sorting', 'bug', 'other'];

let chain = Promise.resolve();
// Read-modify-write one at a time, so two reports arriving together both land.
function update(fn) {
  const run = chain.then(async () => {
    const list = (await getKv(KEY)) || [];
    const result = fn(list);
    await setKv(KEY, list.slice(0, MAX_REPORTS));
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

export async function listReports() {
  await chain;
  return (await getKv(KEY)) || [];
}

export const openCount = async () => (await listReports()).filter(r => r.status === 'open').length;

const clip = (s, n) => String(s ?? '').slice(0, n);

// Keep only the context fields the page sends, trimmed, so a report stays small.
function cleanContext(c = {}) {
  const errors = Array.isArray(c.errors) ? c.errors.slice(-10).map(e => clip(e, 500)) : [];
  const app = c.app && typeof c.app === 'object' ? {
    company: clip(c.app.company, 200), role: clip(c.app.role, 200), status: clip(c.app.status, 40),
    timeline: Array.isArray(c.app.timeline) ? c.app.timeline.slice(-30).map(t => clip(t, 300)) : undefined,
  } : undefined;
  return {
    view: clip(c.view, 60), url: clip(c.url, 300), userAgent: clip(c.userAgent, 300),
    classifier: clip(c.classifier, 100), syncError: clip(c.syncError, 500),
    errors, ...(app && { app }),
  };
}

export function addReport({ userId, email, kind, message, context }) {
  const text = String(message || '').trim();
  if (!text) return Promise.resolve({ error: 'Tell us what went wrong' });
  return update(list => {
    const dayAgo = Date.now() - 86_400_000;
    if (list.filter(r => r.userId === userId && Date.parse(r.createdAt) > dayAgo).length >= MAX_PER_DAY) {
      return { error: "You've sent a lot of reports today. Try again tomorrow" };
    }
    const report = {
      id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'open',
      userId, email: email || null, kind: KINDS.includes(kind) ? kind : 'other',
      message: clip(text, 4000), context: cleanContext(context),
    };
    list.unshift(report);
    return { report };
  });
}

export function setReportStatus(id, status) {
  return update(list => {
    const r = list.find(x => x.id === id);
    if (r) r.status = status === 'resolved' ? 'resolved' : 'open';
    return r || null;
  });
}

// Deleting an account takes its reports with it.
export function deleteReportsBy(userId) {
  return update(list => {
    const kept = list.filter(r => r.userId !== userId);
    list.splice(0, list.length, ...kept);
  });
}

export function deleteReport(id) {
  return update(list => {
    const i = list.findIndex(x => x.id === id);
    if (i !== -1) list.splice(i, 1);
    return i !== -1;
  });
}
