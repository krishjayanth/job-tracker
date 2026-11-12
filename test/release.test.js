import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Letting go of idle trackers only matters when they're saved somewhere, so these use
// files in a scratch folder (store.js reads DATA_DIR at import time).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuj-release-'));
process.env.DATA_DIR = dir;
let store, users;
before(async () => {
  store = await import('../src/store.js');
  users = await import('../src/users.js');
  await store.initStorage();
  await (await import('../src/secrets.js')).initSecrets();
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('an idle tracker is written, let go, and loads again with its changes', async () => {
  const user = await users.getUser('idle-1');
  user.store.createApplication({ company: 'Contoso' });
  user.store.save();
  assert.equal(await users.releaseIdleUsers({ idleMs: 1000, now: Date.now() + 5000 }), 1);
  const again = await users.getUser('idle-1');
  assert.notEqual(again, user);
  assert.equal(again.store.applications[0].company, 'Contoso');
});

test('someone using nuj, syncing, holding work or with something to undo is kept', async () => {
  const now = Date.now();
  const recent = await users.getUser('idle-recent');
  recent.lastUsedAt = now;
  const held = await users.getUser('idle-held');
  held.holds = 1;
  const kept = await users.getUser('idle-kept');
  const undoing = await users.getUser('idle-undo');
  undoing.store.createApplication({ company: 'Fabrikam' });
  undoing.store.checkpoint([undoing.store.applications[0].id]);
  await users.releaseIdleUsers({ idleMs: 1000, now: now + 500, keep: u => u.id === 'idle-kept' });
  assert.equal(await users.getUser('idle-recent'), recent);
  assert.equal(await users.getUser('idle-held'), held);
  assert.equal(await users.getUser('idle-kept'), kept);
  assert.equal(await users.getUser('idle-undo'), undoing);
});
