import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initStorage, deleteKv } from '../src/store.js';
import { addRequest, listRequests, pendingCount, setRequestStatus, tooMany } from '../src/access.js';

await initStorage({ inMemory: true });
beforeEach(() => deleteKv('access_requests'));

test('a request is stored trimmed, with a known stage, newest first', async () => {
  await addRequest({ name: 'Sam', email: 'sam@example.com', stage: 'applying' });
  const { request } = await addRequest({ name: '  Pat  ', email: ' Pat@Example.COM ', stage: 'nonsense', note: 'x'.repeat(5000) });
  const [latest] = await listRequests();
  assert.equal(latest.id, request.id);
  assert.equal(latest.name, 'Pat');
  assert.equal(latest.email, 'pat@example.com');
  assert.equal(latest.stage, 'other');
  assert.equal(latest.note.length, 1000);
  assert.equal(latest.status, 'pending');
});

test('bad input is refused in plain words', async () => {
  assert.match((await addRequest({ name: '', email: 'a@b.co' })).error, /name/);
  assert.match((await addRequest({ name: 'A', email: 'not an email' })).error, /email/);
});

test('asking again with the same address updates the first request', async () => {
  await addRequest({ name: 'Sam', email: 'sam@example.com' });
  const [first] = await listRequests();
  await setRequestStatus(first.id, 'dismissed');
  const again = await addRequest({ name: 'Sam Lee', email: 'SAM@example.com', note: 'Still keen' });
  assert.equal(again.repeat, true);
  const list = await listRequests();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Sam Lee');
  assert.equal(list[0].status, 'pending'); // a dismissed request comes back to waiting
  assert.equal(await pendingCount(), 1);
});

test('the form allows a few tries per visitor an hour', () => {
  const ip = `test-${Math.random()}`;
  for (let i = 0; i < 5; i++) assert.equal(tooMany(ip), false);
  assert.equal(tooMany(ip), true);
});
