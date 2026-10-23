import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initStorage } from '../src/store.js';
import { addReport, listReports, openCount, setReportStatus, deleteReport, deleteReportsBy } from '../src/reports.js';

before(() => initStorage({ inMemory: true }));

test('a report is stored newest first with only the expected context', async () => {
  await addReport({ userId: 'a', email: 'a@example.com', kind: 'bug', message: 'First', context: {} });
  const { report } = await addReport({
    userId: 'b', email: 'b@example.com', kind: 'nonsense', message: '  Second  ',
    context: { view: '#/', secret: 'drop me', errors: Array.from({ length: 15 }, (_, i) => `e${i}`) },
  });
  const [latest] = await listReports();
  assert.equal(latest.id, report.id);
  assert.equal(latest.message, 'Second');
  assert.equal(latest.kind, 'other'); // unknown kinds fall back
  assert.equal(latest.status, 'open');
  assert.equal(latest.context.secret, undefined);
  assert.equal(latest.context.errors.length, 10);
});

test('an empty report is refused', async () => {
  const { error } = await addReport({ userId: 'a', message: '   ' });
  assert.ok(error);
});

test('reports can be resolved, reopened and deleted', async () => {
  const { report } = await addReport({ userId: 'c', message: 'Broken' });
  const before = await openCount();
  await setReportStatus(report.id, 'resolved');
  assert.equal(await openCount(), before - 1);
  await setReportStatus(report.id, 'open');
  assert.equal(await openCount(), before);
  assert.equal(await deleteReport(report.id), true);
  assert.equal((await listReports()).some(r => r.id === report.id), false);
});

test('deleting an account removes its reports', async () => {
  await addReport({ userId: 'gone', message: 'One' });
  await addReport({ userId: 'gone', message: 'Two' });
  await deleteReportsBy('gone');
  assert.equal((await listReports()).some(r => r.userId === 'gone'), false);
  assert.ok((await listReports()).some(r => r.userId === 'a'));
});

test('one person can only send so many reports a day', async () => {
  for (let i = 0; i < 20; i++) await addReport({ userId: 'spam', message: `r${i}` });
  const { error } = await addReport({ userId: 'spam', message: 'one more' });
  assert.match(error, /tomorrow/);
});
