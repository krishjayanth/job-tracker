import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initStorage, deleteKv } from '../src/store.js';
import { ask, pendingFor, answer, skip, stopAsking, forgetUserFeedback, listAsks, summarize, markRead, unreadCount } from '../src/feedback.js';

await initStorage({ inMemory: true });
beforeEach(() => deleteKv('feedback'));

const good = { enjoying: 'yes', rating: 5, sorting: 'right' };

test('the questions wait for the people asked, and only them', async () => {
  const { ask: a } = await ask({ userIds: ['a', 'b'] });
  assert.equal((await pendingFor('a')).id, a.id);
  assert.equal((await pendingFor('b')).id, a.id);
  assert.equal(await pendingFor('c'), null);
});

test('answering stores the answer and the questions stop showing', async () => {
  const { ask: a } = await ask({ userIds: ['a'] });
  const { answer: given } = await answer(a.id, { userId: 'a', email: 'a@example.com', ...good, comment: '  Love it  ' });
  assert.equal(given.comment, 'Love it');
  assert.equal(await pendingFor('a'), null);
  const { error } = await answer(a.id, { userId: 'a', ...good });
  assert.ok(error, 'a second answer is refused');
});

test('answers have to make sense', async () => {
  const { ask: a } = await ask({ userIds: ['a'] });
  assert.ok((await answer(a.id, { userId: 'a', ...good, rating: 6 })).error);
  assert.ok((await answer(a.id, { userId: 'a', ...good, rating: 2.5 })).error);
  assert.ok((await answer(a.id, { userId: 'a', ...good, enjoying: 'maybe' })).error);
  assert.ok((await answer(a.id, { userId: 'a', ...good, sorting: 'great' })).error);
  // No Gmail connected: the sorting question isn't asked.
  assert.ok((await answer(a.id, { userId: 'a', ...good, sorting: null })).answer);
});

test('someone not asked can\'t answer', async () => {
  const { ask: a } = await ask({ userIds: ['a'] });
  assert.ok((await answer(a.id, { userId: 'b', ...good })).error);
});

test('"Not now" skips the questions for good', async () => {
  const { ask: a } = await ask({ userIds: ['a'] });
  assert.equal(await skip(a.id, 'a'), true);
  assert.equal(await pendingFor('a'), null);
  assert.equal(await skip(a.id, 'a'), false);
});

test('asked twice, they see the newest once, and answering it settles the older one', async () => {
  const { ask: older } = await ask({ userIds: ['a', 'b'] });
  const { ask: newer } = await ask({ userIds: ['a'] });
  assert.equal((await pendingFor('a')).id, newer.id);
  await answer(newer.id, { userId: 'a', ...good });
  assert.equal(await pendingFor('a'), null);
  assert.equal((await pendingFor('b')).id, older.id, 'others asked by the older one still are');
});

test('stopping an ask hides it from anyone yet to answer, and keeps the answers', async () => {
  const { ask: a } = await ask({ userIds: ['a', 'b'] });
  await answer(a.id, { userId: 'a', ...good });
  await stopAsking(a.id);
  assert.equal(await pendingFor('b'), null);
  assert.equal((await listAsks())[0].answers.length, 1);
});

test('deleting an account removes its answers', async () => {
  const { ask: a } = await ask({ userIds: ['gone', 'stays'] });
  await answer(a.id, { userId: 'gone', ...good });
  await forgetUserFeedback('gone');
  const [kept] = await listAsks();
  assert.deepEqual(kept.userIds, ['stays']);
  assert.equal(kept.answers.length, 0);
});

test('asking no one is refused', async () => {
  assert.ok((await ask({ userIds: [] })).error);
});

test('the summary averages ratings and counts each answer', async () => {
  const { ask: a } = await ask({ userIds: ['a', 'b', 'c'] });
  await answer(a.id, { userId: 'a', enjoying: 'yes', rating: 5, sorting: 'right' });
  await answer(a.id, { userId: 'b', enjoying: 'okay', rating: 4, sorting: 'some' });
  await answer(a.id, { userId: 'c', enjoying: 'yes', rating: 4, sorting: null });
  const s = summarize(await listAsks());
  assert.equal(s.answers, 3);
  assert.equal(s.rating, 4.3);
  assert.deepEqual(s.enjoying, { yes: 2, okay: 1, no: 0 });
  assert.deepEqual(s.sorting, { right: 1, some: 1, wrong: 0, unsure: 0 });
  assert.equal(summarize([]).rating, null);
});

test('answers arrive unread, and can be marked read and unread again', async () => {
  const { ask: a } = await ask({ userIds: ['a', 'b'] });
  await answer(a.id, { userId: 'a', ...good });
  await answer(a.id, { userId: 'b', ...good });
  assert.equal(await unreadCount(), 2);
  assert.equal(await markRead([{ askId: a.id, userId: 'a' }]), 1);
  assert.equal(await unreadCount(), 1);
  assert.ok((await listAsks())[0].answers.find(x => x.userId === 'a').readAt);
  // Already read, or no such answer: nothing changes.
  assert.equal(await markRead([{ askId: a.id, userId: 'a' }, { askId: 'nope', userId: 'b' }]), 0);
  assert.equal(await markRead([{ askId: a.id, userId: 'a' }], false), 1);
  assert.equal(await unreadCount(), 2);
});
