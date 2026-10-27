import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountSummary, attentionFor, noteSeen, EXPIRED, SEEN_EVERY_MS } from '../src/accounts.js';

// A stand-in account with one application of two Gmail emails and a note of your own.
function person({ connected = true, needsSetup = false, groq = { source: 'own', problem: null }, db = {} } = {}) {
  const saves = [];
  return {
    id: 'u1', email: 'u1@example.com', owner: false, saves,
    store: {
      db: {
        applications: [{ company: 'Contoso', role: 'Intern', needsReview: true,
          events: [{ stage: 'applied', subject: 'Thanks' }, { stage: 'oa', subject: 'Assessment' }, { stage: 'oa', manual: true }] }],
        lastSync: '2026-10-20T10:00:00.000Z', lastSyncError: null, ...db,
      },
      save() { saves.push(Date.now()); },
    },
    needsSetup: () => needsSetup,
    groqInfo: () => groq,
    mailbox: { connected: () => connected, progress: null },
  };
}

test('a summary has counts and dates, never what the applications are', () => {
  const s = accountSummary(person(), { joinedAt: '2026-09-01T00:00:00.000Z' });
  assert.equal(s.applications, 1);
  assert.equal(s.emails, 2); // your own status change isn't an email
  assert.equal(s.toCheck, 1);
  assert.deepEqual(s.sorting, { by: 'groq', key: 'own', problem: null });
  assert.deepEqual(s.attention, []);
  const text = JSON.stringify(s);
  assert.ok(!text.includes('Contoso') && !text.includes('Assessment') && !text.includes('Intern'));
});

test('an expired Gmail sign-in reads as expired, not just off', () => {
  const s = accountSummary(person({ connected: false, db: { lastSyncError: EXPIRED } }));
  assert.equal(s.gmail, 'expired');
  assert.deepEqual(s.attention, ['Gmail sign-in expired']);
  assert.equal(accountSummary(person({ connected: false })).gmail, 'off');
});

test('what needs attention, most pressing first', () => {
  const s = accountSummary(person({ needsSetup: true, groq: { source: 'own', problem: 'rejected' }, db: { lastSyncError: 'socket hang up' } }), { errors: 2, reports: 1 });
  assert.deepEqual(s.attention, ['Last sync failed', 'Groq key rejected', 'Hasn’t finished setup', '2 open errors', '1 open report']);
});

test('someone taken off the allow-list needs nothing from you', () => {
  assert.deepEqual(attentionFor({ allowed: false, gmail: 'expired', sorting: {}, errors: 3 }), []);
});

test('a re-scan in progress shows how far it has got', () => {
  const p = person();
  p.mailbox.progress = { mode: 'rescan', done: 4, total: 10 };
  assert.deepEqual(accountSummary(p).busy, { mode: 'rescan', done: 4, total: 10 });
});

test('"last seen" is written once in a while, not on every request', () => {
  const p = person();
  const t = Date.parse('2026-10-26T12:00:00.000Z');
  assert.equal(noteSeen(p, t), true);
  assert.equal(noteSeen(p, t + 60_000), false);
  assert.equal(noteSeen(p, t + SEEN_EVERY_MS + 1), true);
  assert.equal(p.saves.length, 2);
  assert.equal(p.store.db.lastSeenAt, new Date(t + SEEN_EVERY_MS + 1).toISOString());
});
