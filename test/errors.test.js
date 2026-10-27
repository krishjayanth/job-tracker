import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initStorage, deleteKv, getKv } from '../src/store.js';
import { recordError, listErrors, openErrorCount, setErrorStatus, deleteError, forgetUserErrors, flushErrors, fingerprint, resetErrorsForTests } from '../src/errors.js';

await initStorage({ inMemory: true });
beforeEach(async () => { resetErrorsForTests(); await deleteKv('errors'); });

test('the same problem with different numbers is one group, counted', async () => {
  await recordError('groq', 'Rate limited for 42s; read with the rules instead', { userId: 'a', level: 'warning' });
  await recordError('groq', 'Rate limited for 7s; read with the rules instead', { userId: 'b', level: 'warning' });
  await recordError('groq', 'Rate limited for 7s; read with the rules instead', { userId: 'a', level: 'warning' });
  const [g, ...rest] = await listErrors();
  assert.equal(rest.length, 0);
  assert.equal(g.count, 3);
  assert.deepEqual(g.users.sort(), ['a', 'b']);
  assert.equal(g.level, 'warning');
  assert.equal(g.samples.length, 3);
});

test('the same message from a different source is a different group', () => {
  assert.notEqual(fingerprint('sync', 'socket hang up'), fingerprint('server', 'socket hang up'));
  assert.equal(fingerprint('sync', 'Request failed with status code 503'), fingerprint('sync', 'Request failed with status code 502'));
});

test('email addresses never make it into the log', async () => {
  const g = await recordError('server', new Error('No mailbox for ava@example.com'), { detail: 'sent to ava@example.com' });
  assert.equal(g.message, 'No mailbox for [email]');
  assert.equal(g.samples[0].detail, 'sent to [email]');
});

test('only errors, not warnings, count as open problems', async () => {
  await recordError('sync', 'Request failed with status code 503', { userId: 'a' });
  await recordError('gmail', 'Google sign-in for Gmail expired or was revoked', { userId: 'b', level: 'warning' });
  assert.equal(await openErrorCount(), 1);
});

test('a resolved error that happens again opens again, marked as back', async () => {
  const g = await recordError('sync', 'socket hang up');
  await setErrorStatus(g.id, 'resolved');
  assert.equal(await openErrorCount(), 0);
  const again = await recordError('sync', 'socket hang up');
  assert.equal(again.status, 'open');
  assert.equal(again.regressed, true);
  await setErrorStatus(g.id, 'resolved');
  assert.equal((await listErrors())[0].regressed, undefined);
});

test('errors are saved and come back after a restart', async () => {
  await recordError('server', 'connect ETIMEDOUT', { detail: 'GET /api/state' });
  await flushErrors();
  assert.equal((await getKv('errors')).length, 1);
  resetErrorsForTests();
  assert.equal((await listErrors())[0].message, 'connect ETIMEDOUT');
});

test('deleting an account takes it off every error, and drops errors only it had', async () => {
  await recordError('sync', 'socket hang up', { userId: 'gone' });
  await recordError('sync', 'socket hang up', { userId: 'stays' });
  await recordError('rescan', 'Gmail sign-in expired', { userId: 'gone' });
  await forgetUserErrors('gone');
  const all = await listErrors();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].users, ['stays']);
  assert.ok(all[0].samples.every(s => s.userId !== 'gone'));
});

test('an error can be deleted, and recording never throws', async () => {
  const g = await recordError('browser', undefined);
  assert.equal(g.message, 'Unknown error');
  assert.equal(await deleteError(g.id), true);
  assert.equal((await listErrors()).length, 0);
});
