import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// auth.js reads its settings at import time, so set them first.
process.env.ALLOWED_EMAIL = 'owner@example.com,friend@example.com';
process.env.SESSION_SECRET = 'y'.repeat(40);
let store, users, secrets;
before(async () => {
  store = await import('../src/store.js');
  secrets = await import('../src/secrets.js');
  users = await import('../src/users.js');
  await store.initStorage({ inMemory: true });
  // What the single-user version left behind.
  await store.setKv('db', { ...store.emptyDb(), applications: [{ id: 'old', company: 'Contoso', events: [] }] });
  await store.setKv('gmail_token', { refresh_token: 'owner-refresh' });
  await secrets.initSecrets();
});

test('the owner inherits the single-user tracker and Gmail sign-in; a backup is kept', async () => {
  const owner = await users.getUser('sub-owner', 'owner@example.com');
  assert.equal(owner.store.applications[0].company, 'Contoso');
  assert.equal(owner.mailbox.connected(), true);
  assert.equal(await store.getKv('db'), null);
  assert.equal((await store.getKv('db_before_accounts')).applications.length, 1);
});

test("everyone else starts empty and can't see the owner's data", async () => {
  const friend = await users.getUser('sub-friend', 'friend@example.com');
  assert.equal(friend.isNew, true);
  assert.deepEqual(friend.store.applications, []);
  assert.equal(friend.mailbox.connected(), false);
  friend.store.createApplication({ company: 'Fabrikam' });
  const owner = await users.getUser('sub-owner');
  assert.ok(!owner.store.applications.some(a => a.company === 'Fabrikam'));
  assert.notEqual(owner.store, friend.store);
});

test('a Groq key is stored encrypted, shown only by its last 4 characters', async () => {
  const friend = await users.getUser('sub-friend');
  assert.deepEqual(friend.groqInfo(), { source: null, problem: null });
  assert.equal(friend.groq(), null);
  await friend.setGroqKey('gsk_' + 'a'.repeat(40) + 'WXYZ');
  const saved = await store.getKv('groq_key_sub-friend');
  assert.ok(!JSON.stringify(saved).includes('aaaa'));
  assert.deepEqual(friend.groqInfo(), { source: 'own', last4: 'WXYZ', problem: null });
  assert.ok(friend.groq());
});

test('a key Groq rejects stops being used and is reported', async () => {
  const friend = await users.getUser('sub-friend');
  friend.keyRejected();
  assert.equal(friend.groq(), null);
  assert.equal(friend.groqInfo().problem, 'rejected');
  // Saving a new key clears it.
  await friend.setGroqKey('gsk_' + 'b'.repeat(40));
  assert.equal(friend.groqInfo().problem, null);
});

test("a key sealed with another secret can't be read back", () => {
  const sealed = secrets.encrypt('gsk_secret');
  assert.equal(secrets.decrypt(sealed), 'gsk_secret');
  const [iv, tag, data] = sealed.split('.');
  assert.equal(secrets.decrypt([iv, tag, data.slice(0, -2) + 'AA'].join('.')), null);
});

test('deleting an account removes its data, key and Gmail sign-in, and only its own', async () => {
  const friend = await users.getUser('sub-friend');
  await friend.store.flush();
  await users.deleteUser('sub-friend');
  for (const key of ['db_sub-friend', 'groq_key_sub-friend', 'gmail_token_sub-friend']) assert.equal(await store.getKv(key), null, key);
  assert.ok(!('sub-friend' in await store.getKv('users')));
  assert.equal((await users.getUser('sub-owner')).store.applications[0].company, 'Contoso');
  // Signing in again starts over.
  const again = await users.getUser('sub-friend', 'friend@example.com');
  assert.deepEqual(again.store.applications, []);
});

test('someone new is asked how to sort before anything is synced; existing users are not', async () => {
  const fresh = await users.getUser('sub-fresh', 'friend@example.com');
  assert.equal(fresh.needsSetup(), true);
  fresh.finishSetup();
  assert.equal(fresh.needsSetup(), false);

  const synced = await users.getUser('sub-synced', 'friend@example.com');
  synced.store.db.lastSync = new Date().toISOString();
  assert.equal(synced.needsSetup(), false);
});
