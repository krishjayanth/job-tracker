import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDb, createApplication, findApplication, matchApplication, assignedApplication, reassignEmail,
  refresh, snapshotEdits, restoreEdits, newId,
} from '../src/store.js';

// These only touch the in-memory document; nothing calls save().
beforeEach(() => { const db = getDb(); db.applications.length = 0; db.assignments = {}; db.ignored = {}; });

const email = (date, stage, extra = {}) => ({ id: newId(), date, stage, messageId: newId(), ...extra });

function gmailApp({ company, role = '', jobId = '', threadId = newId(), events = [['2026-09-01', 'applied']] }) {
  const a = createApplication({ company, role, jobId, source: 'gmail' });
  a.events.push(...events.map(([date, stage, extra]) => email(`${date}T12:00:00.000Z`, stage, { threadId, ...extra })));
  return refresh(a);
}

test('findApplication: the same Gmail thread wins over everything else', () => {
  const a = gmailApp({ company: 'Contoso', threadId: 't-1' });
  assert.equal(findApplication({ threadId: 't-1', company: 'Someone Else' }), a);
});

test('findApplication: company names match despite case and legal suffixes', () => {
  const a = gmailApp({ company: 'Contoso Inc.' });
  assert.equal(findApplication({ company: 'contoso' }), a);
});

test('findApplication: same job ID is the same job; a different ID is a new one', () => {
  const a = gmailApp({ company: 'Fabrikam', jobId: 'R-100' });
  assert.equal(findApplication({ company: 'Fabrikam', jobId: 'R-100' }), a);
  assert.equal(findApplication({ company: 'Fabrikam', jobId: 'R-200' }), null);
});

test('findApplication: a role worded slightly differently still matches', () => {
  const a = gmailApp({ company: 'Litware', role: 'Software Engineer Intern' });
  assert.equal(findApplication({ company: 'Litware', role: 'Software Engineer Intern | Platform' }), a);
});

test('findApplication: a different known role at the same company is separate', () => {
  gmailApp({ company: 'Litware', role: 'Software Engineer Intern' });
  assert.equal(findApplication({ company: 'Litware', role: 'Data Analyst Intern' }), null);
});

test('findApplication: names you renamed away from still find the application', () => {
  const a = gmailApp({ company: 'Capital One' });
  a.aliases = ['CapitalOne-HR'];
  assert.equal(findApplication({ company: 'capitalone hr' }), a);
});

test('refresh: deadline comes from the latest email and clears on a later email', () => {
  const due = '2026-09-10T23:59:00.000Z';
  const a = gmailApp({ company: 'Proseware', events: [['2026-09-01', 'applied'], ['2026-09-03', 'oa', { deadline: due }]] });
  assert.equal(a.status, 'oa');
  assert.equal(a.deadline, due);
  a.events.push(email('2026-09-05T12:00:00.000Z', 'oa')); // "thanks for completing the assessment"
  assert.equal(refresh(a).deadline, null);
});

test('refresh: a deadline you marked done stays done, and rejection clears it', () => {
  const due = '2026-09-10T23:59:00.000Z';
  const a = gmailApp({ company: 'Proseware', events: [['2026-09-01', 'applied'], ['2026-09-03', 'oa', { deadline: due }]] });
  a.deadlineDone = due;
  assert.equal(refresh(a).deadline, null);
  a.deadlineDone = null;
  a.events.push(email('2026-09-04T12:00:00.000Z', 'rejected'));
  assert.equal(refresh(a).deadline, null);
});

test('re-scan keeps your edits: renames, notes and manual status changes come back', () => {
  const a = gmailApp({ company: 'CapitalOne', events: [['2026-09-01', 'applied'], ['2026-09-08', 'interview']] });
  a.company = 'Capital One';
  a.aliases = ['CapitalOne'];
  a.renamed = true;
  a.notes = 'Referred by a friend';
  a.events.push({ id: newId(), date: '2026-09-09T12:00:00.000Z', stage: 'rejected', manual: true });
  refresh(a);
  const snapshots = snapshotEdits();

  // Simulate the re-scan rebuilding the application from the same emails.
  const emails = a.events.filter(e => e.messageId);
  getDb().applications.length = 0;
  const rebuilt = createApplication({ company: 'CapitalOne', source: 'gmail' });
  rebuilt.events.push(...structuredClone(emails));
  refresh(rebuilt);
  assert.equal(rebuilt.status, 'interview');

  assert.deepEqual(restoreEdits(snapshots), { restored: 1, kept: 0 });
  assert.equal(rebuilt.company, 'Capital One');
  assert.equal(rebuilt.notes, 'Referred by a friend');
  assert.equal(rebuilt.status, 'rejected');
});

test('re-scan keeps an edited application whose emails no longer classify', () => {
  const a = gmailApp({ company: 'Trey Research' });
  a.notes = 'Keep me';
  const snapshots = snapshotEdits();
  getDb().applications.length = 0;
  assert.deepEqual(restoreEdits(snapshots), { restored: 0, kept: 1 });
  assert.equal(getDb().applications[0].notes, 'Keep me');
});

test('matchApplication: a pick among several applications at one company is a guess', () => {
  gmailApp({ company: 'Contoso', role: 'Data Analyst Intern' });
  gmailApp({ company: 'Contoso', role: 'Software Engineer Intern' });
  assert.equal(matchApplication({ company: 'Contoso' }).guess, true);
  assert.equal(matchApplication({ company: 'Contoso', role: 'Software Engineer Intern' }).guess, false);
  gmailApp({ company: 'Fabrikam' });
  assert.equal(matchApplication({ company: 'Fabrikam' }).guess, false);
});

test('reassignEmail: confirming marks the email checked and remembers where it goes', () => {
  const a = gmailApp({ company: 'Contoso', events: [['2026-09-01', 'applied'], ['2026-09-05', 'oa', { review: [{ about: 'application', text: '?' }] }]] });
  assert.equal(a.needsReview, true);
  const e = a.events[1];
  reassignEmail(e.id, { action: 'confirm' });
  assert.equal(a.needsReview, false);
  assert.equal(assignedApplication(e.messageId), a);
});

test('reassignEmail: moving an email takes its stage along and empties out a stray application', () => {
  const right = gmailApp({ company: 'Contoso', role: 'Software Engineer Intern' });
  const stray = gmailApp({ company: 'Unknown company', events: [['2026-09-05', 'interview']] });
  const e = stray.events[0];
  const { app } = reassignEmail(e.id, { action: 'move', to: right.id });
  assert.equal(app, right);
  assert.equal(right.status, 'interview');
  assert.ok(!getDb().applications.includes(stray));
  // After a re-scan the ids are new; the email still finds its way back by another of its emails.
  const assignment = getDb().assignments[e.messageId];
  getDb().applications.length = 0;
  const rebuilt = gmailApp({ company: 'Contoso', events: [['2026-09-01', 'applied', { messageId: assignment.anchors[0] }]] });
  assert.equal(assignedApplication(e.messageId), rebuilt);
});

test('reassignEmail: a new application, or not an application at all', () => {
  const a = gmailApp({ company: 'Contoso', events: [['2026-09-01', 'applied'], ['2026-09-03', 'applied'], ['2026-09-04', 'applied']] });
  const [, second, third] = a.events;
  const { app } = reassignEmail(second.id, { action: 'new', company: 'Fabrikam', role: 'Analyst' });
  assert.equal(app.company, 'Fabrikam');
  assert.deepEqual(app.events, [second]);
  assert.equal(reassignEmail(third.id, { action: 'new', company: '  ' }).status, 400);
  reassignEmail(third.id, { action: 'ignore' });
  assert.equal(a.events.length, 1);
  assert.equal(getDb().ignored[third.messageId], true);
  assert.equal(reassignEmail('nope', { action: 'confirm' }).status, 404);
});
