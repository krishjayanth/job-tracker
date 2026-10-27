// Asking people how nuj is going: the owner asks one person or everyone from the Developer
// page, and the next time each of them opens nuj they see three quick questions (are you
// enjoying it, a 1-5 rating, is the email sorting right) and an optional comment.
// Each ask is kept with its answers, in one shared list like problem reports.
import crypto from 'node:crypto';
import { getKv, setKv } from './store.js';

const KEY = 'feedback';
const MAX_ASKS = 100;
export const ENJOYING = ['yes', 'okay', 'no'];
export const SORTING = ['right', 'some', 'wrong', 'unsure'];

let chain = Promise.resolve();
// Read-modify-write one at a time, so answers arriving together all land.
function update(fn) {
  const run = chain.then(async () => {
    const list = (await getKv(KEY)) || [];
    const result = fn(list);
    await setKv(KEY, list.slice(0, MAX_ASKS));
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

export async function listAsks() {
  await chain;
  return (await getKv(KEY)) || [];
}

// userIds: who's asked. Everyone means everyone with access now, not people who join later:
// someone who signed up yesterday has nothing to say yet.
export function ask({ userIds, everyone = false }) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return Promise.resolve({ error: 'There is no one to ask' });
  return update(list => {
    const a = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), everyone, userIds: ids, answers: [], skipped: [] };
    list.unshift(a);
    return { ask: a };
  });
}

const waitingFor = (a, userId) => !a.stoppedAt && a.userIds.includes(userId)
  && !a.answers.some(x => x.userId === userId) && !a.skipped.includes(userId);

// The questions waiting for this person, if any: the newest ask they haven't answered or skipped.
export async function pendingFor(userId) {
  return (await listAsks()).find(a => waitingFor(a, userId)) || null;
}

// Answering (or skipping) one ask settles any older ones still waiting for them too, so
// nobody gets the same questions twice in a row.
function settleOlder(list, a, userId) {
  for (const older of list.slice(list.indexOf(a) + 1)) if (waitingFor(older, userId)) older.skipped.push(userId);
}

const clip = (s, n) => String(s ?? '').trim().slice(0, n);

// Returns { answer } or { error } (shown to the person, so in plain words).
export function answer(askId, { userId, email = null, enjoying, rating, sorting = null, comment = '' }) {
  const r = Number(rating);
  if (!ENJOYING.includes(enjoying)) return Promise.resolve({ error: 'Say whether you’re enjoying nuj' });
  if (!Number.isInteger(r) || r < 1 || r > 5) return Promise.resolve({ error: 'Pick a rating from 1 to 5 stars' });
  if (sorting !== null && !SORTING.includes(sorting)) return Promise.resolve({ error: 'Say how the email sorting is doing' });
  return update(list => {
    const a = list.find(x => x.id === askId);
    if (!a || !waitingFor(a, userId)) return { error: 'These questions were already answered or closed' };
    const given = { userId, email, at: new Date().toISOString(), enjoying, rating: r, sorting, comment: clip(comment, 2000) };
    a.answers.push(given);
    settleOlder(list, a, userId);
    return { answer: given };
  });
}

// "Not now": they won't see these questions again.
export function skip(askId, userId) {
  return update(list => {
    const a = list.find(x => x.id === askId);
    if (!a || !waitingFor(a, userId)) return false;
    a.skipped.push(userId);
    settleOlder(list, a, userId);
    return true;
  });
}

// Stop showing an ask to anyone who hasn't seen it yet; its answers stay.
export function stopAsking(askId) {
  return update(list => {
    const a = list.find(x => x.id === askId);
    if (a && !a.stoppedAt) a.stoppedAt = new Date().toISOString();
    return a || null;
  });
}

// The owner marking answers read (or unread again). items: [{ askId, userId }], since
// each person answers an ask once. Returns how many changed.
export function markRead(items, read = true) {
  return update(list => {
    let changed = 0;
    for (const { askId, userId } of items) {
      const x = list.find(a => a.id === askId)?.answers.find(y => y.userId === userId);
      if (!x || Boolean(x.readAt) === read) continue;
      if (read) x.readAt = new Date().toISOString(); else delete x.readAt;
      changed++;
    }
    return changed;
  });
}

export async function unreadCount() {
  return (await listAsks()).reduce((n, a) => n + a.answers.filter(x => !x.readAt).length, 0);
}

// Deleting an account takes its answers with it.
export function forgetUserFeedback(userId) {
  return update(list => {
    for (const a of list) {
      a.userIds = a.userIds.filter(id => id !== userId);
      a.answers = a.answers.filter(x => x.userId !== userId);
      a.skipped = a.skipped.filter(id => id !== userId);
    }
  });
}

// Every answer so far, summed up: the average rating and how the answers split.
export function summarize(asks) {
  const answers = asks.flatMap(a => a.answers);
  const count = (key, values) => Object.fromEntries(values.map(v => [v, answers.filter(x => x[key] === v).length]));
  return {
    answers: answers.length,
    rating: answers.length ? Math.round((answers.reduce((n, x) => n + x.rating, 0) / answers.length) * 10) / 10 : null,
    enjoying: count('enjoying', ENJOYING),
    sorting: count('sorting', SORTING),
  };
}
