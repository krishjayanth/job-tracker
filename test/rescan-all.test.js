import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initStorage, deleteKv } from '../src/store.js';
import { rescanEveryoneOnce, rescanAccount } from '../src/rescan-all.js';
import { RESCAN_ID } from '../src/releases.js';

await initStorage({ inMemory: true });
beforeEach(() => deleteKv(RESCAN_ID));

const quiet = { log() {}, warn() {}, error() {} };
// A stand-in account: counts its re-scans, and can be made to fail.
function person(id, { owner = false, connected = true, needsSetup = false, fails = false, rescanning = false } = {}) {
  const user = {
    id, owner, rescans: 0, fails, email: `${id}@example.com`,
    store: { db: {}, save() {} },
    needsSetup: () => needsSetup,
    mailbox: {
      connected: () => connected,
      isRescanning: () => rescanning,
      rescan: async () => {
        user.rescans++;
        if (user.fails) throw new Error('Gmail sign-in expired');
        return { applications: 3, restored: 1 };
      },
    },
  };
  return user;
}

test('everyone with Gmail is re-scanned once, except the owner and anyone still setting up', async () => {
  const owner = person('owner', { owner: true });
  const a = person('a');
  const noGmail = person('b', { connected: false });
  const settingUp = person('c', { needsSetup: true });
  const told = [];
  const r = await rescanEveryoneOnce([owner, a, noGmail, settingUp], { log: quiet, onUser: u => told.push(u.id) });
  assert.equal(r.finished, true);
  assert.deepEqual([owner, a, noGmail, settingUp].map(u => u.rescans), [0, 1, 0, 0]);
  assert.equal(a.store.db.rescanned, RESCAN_ID);
  assert.deepEqual(told, ['a']);

  // Once finished, a restart doesn't run it again.
  await rescanEveryoneOnce([owner, a], { log: quiet });
  assert.equal(a.rescans, 1);
});

test('a failed re-scan is tried again on the next start, without redoing the others', async () => {
  const a = person('a');
  const b = person('b', { fails: true });
  const first = await rescanEveryoneOnce([a, b], { log: quiet });
  assert.equal(first.finished, false);
  assert.equal(first.failed, 1);

  b.fails = false;
  const second = await rescanEveryoneOnce([a, b], { log: quiet });
  assert.equal(second.finished, true);
  assert.equal(a.rescans, 1);
  assert.equal(b.rescans, 2);
});

// ---- the owner re-scanning one account (Reports page) ---------------------------------

test('rescanAccount: starts their re-scan and tells their tabs when it ends', async () => {
  const a = person('a');
  const told = [];
  const r = await rescanAccount(a, { log: quiet, onDone: u => told.push(u.id) });
  assert.equal(r.started, true);
  await r.finished;
  assert.equal(a.rescans, 1);
  assert.deepEqual(told, ['a']);
});

test("rescanAccount: refuses, without reading anything, when it can't run", async () => {
  const cases = [
    [null, 404],
    [person('b', { connected: false }), 400],
    [person('c', { needsSetup: true }), 400],
    [person('d', { rescanning: true }), 409],
  ];
  for (const [user, status] of cases) {
    const r = await rescanAccount(user, { log: quiet });
    assert.equal(r.status, status, user?.id);
    assert.ok(r.error, user?.id);
    assert.equal(user?.rescans ?? 0, 0);
  }
});

test('rescanAccount: a re-scan that fails is logged and still tells their tabs', async () => {
  const a = person('a', { fails: true });
  const errors = [], told = [];
  const r = await rescanAccount(a, { log: { ...quiet, error: m => errors.push(m) }, onDone: u => told.push(u.id) });
  await r.finished;
  assert.match(errors[0], /Gmail sign-in expired/);
  assert.deepEqual(told, ['a']);
});
