import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initStorage, getKv, setKv, Store, refresh, newId } from '../src/store.js';
import { Mailbox } from '../src/gmail.js';

before(() => initStorage({ inMemory: true }));

// A tracker with one Gmail application you've edited (a note and a status change) and
// one you added by hand.
function tracker() {
  const fromGmail = refresh({
    id: 'g1', company: 'Acme', role: 'Intern', jobId: '', url: '', notes: 'Spoke to Dana', source: 'gmail',
    createdAt: '2026-09-01T00:00:00.000Z',
    events: [
      { id: 'e1', date: '2026-09-01T00:00:00.000Z', stage: 'applied', subject: 'Thanks for applying', messageId: 'm1', threadId: 't1' },
      { id: 'e2', date: '2026-09-05T00:00:00.000Z', stage: 'interview', manual: true, subject: 'Status changed manually' },
    ],
  });
  const byHand = refresh({
    id: 'h1', company: 'Globex', role: '', jobId: '', url: '', notes: '', source: 'manual', createdAt: '2026-09-02T00:00:00.000Z',
    events: [{ id: 'e3', date: '2026-09-02T00:00:00.000Z', stage: 'applied', manual: true, subject: 'Added manually' }],
  });
  return { applications: [fromGmail, byHand], processed: { m1: true }, ignored: {}, assignments: {}, lastSync: '2026-10-01T00:00:00.000Z', lastSyncError: null, setupDone: true };
}

// A real Mailbox on a stand-in account, connected, whose reading of Gmail is replaced
// by `drain` (what a re-scan does with the inbox).
async function mailboxFor(id, db, drain) {
  const store = new Store(`db_${id}`, db, { persist: true });
  await store.flush();
  const user = { id, email: `${id}@example.com`, store, groq: () => null, needsSetup: () => false, keyRejected() {} };
  const mailbox = new Mailbox(user);
  mailbox.token = { refresh_token: 'stand-in' };
  if (drain) mailbox.drain = drain;
  return { store, mailbox };
}

// What a re-scan's reading of the inbox puts back: the application, rebuilt from its email.
const rebuild = store => () => {
  const a = store.createApplication({ company: 'Acme', role: 'Intern', source: 'gmail' });
  a.events.push({ id: newId(), date: '2026-09-01T00:00:00.000Z', stage: 'applied', subject: 'Thanks for applying', messageId: 'm1', threadId: 't1' });
  refresh(a);
  store.db.processed.m1 = true;
};

test('a re-scan that fails part-way puts everything back, edits included', async () => {
  const before = structuredClone(tracker());
  let store;
  const made = await mailboxFor('fails', tracker(), async () => {
    rebuild(store)();
    // Gmail's sign-in expired mid-way (runSync notes why before it throws).
    store.db.lastSyncError = 'Gmail sign-in expired';
    throw new Error('invalid_grant');
  });
  store = made.store;
  const { mailbox } = made;

  await assert.rejects(mailbox.rescan(), /invalid_grant/);
  assert.deepEqual(store.db.applications, before.applications);
  assert.deepEqual(store.db.processed, before.processed);
  assert.equal(store.db.lastSync, before.lastSync);
  assert.equal(store.db.rescanStartedAt, undefined);
  // Why it failed stays on show.
  assert.equal(store.db.lastSyncError, 'Gmail sign-in expired');
  assert.equal(mailbox.isRescanning(), false);
  // What's saved is the tracker as it was, not the half-rebuilt one.
  assert.deepEqual((await getKv('db_fails')).applications, before.applications);
});

test('trying again after a failed re-scan still keeps your edits and a good backup', async () => {
  let fail = true;
  let store;
  const made = await mailboxFor('retry', tracker(), async () => {
    rebuild(store)();
    if (fail) throw new Error('Network down');
    return { added: 1, scanned: 1, remaining: 0 };
  });
  store = made.store;
  await assert.rejects(made.mailbox.rescan(), /Network down/);

  fail = false;
  const r = await made.mailbox.rescan();
  assert.equal(r.restored, 1);
  const acme = store.db.applications.find(a => a.company === 'Acme');
  assert.equal(acme.notes, 'Spoke to Dana');
  assert.equal(acme.status, 'interview');
  assert.ok(store.db.applications.some(a => a.company === 'Globex'));
  assert.equal(store.db.rescanStartedAt, undefined);
  assert.equal((await getKv('db_before_rescan_retry')).applications.find(a => a.company === 'Acme').notes, 'Spoke to Dana');
});

test('emails are read with the time zone your browser last told nuj', async () => {
  const { store, mailbox } = await mailboxFor('zone', tracker());
  assert.equal(mailbox.readingOptions().timeZone, undefined);
  store.db.timeZone = 'America/Denver';
  assert.equal(mailbox.readingOptions().timeZone, 'America/Denver');
});

test('a re-scan cut off by a restart is put back from its backup when the account loads', async () => {
  const before = tracker();
  // What a restart part-way through left saved: the backup, and a tracker that's half
  // rebuilt, without your edits, still marked as being re-scanned.
  await setKv('db_before_rescan_cut', before);
  const half = { ...tracker(), applications: [], processed: {}, lastSync: null, rescanStartedAt: '2026-10-02T00:00:00.000Z' };
  const { store, mailbox } = await mailboxFor('cut', half);

  await mailbox.load();
  assert.deepEqual(store.db.applications, before.applications);
  assert.equal(store.db.lastSync, before.lastSync);
  assert.equal(store.db.rescanStartedAt, undefined);
  assert.deepEqual((await getKv('db_cut')).applications, before.applications);

  // An account that wasn't being re-scanned is left alone.
  const fine = await mailboxFor('fine', tracker());
  await fine.mailbox.load();
  assert.equal(fine.store.db.applications.length, 2);
});
