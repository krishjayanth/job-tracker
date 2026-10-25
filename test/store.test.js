import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, refresh, newId } from '../src/store.js';

// A fresh in-memory tracker per test; it never writes anywhere.
let s;
beforeEach(() => { s = new Store('db_test'); });

const email = (date, stage, extra = {}) => ({ id: newId(), date, stage, messageId: newId(), ...extra });

function gmailApp({ company, role = '', jobId = '', threadId = newId(), events = [['2026-09-01', 'applied']] }) {
  const a = s.createApplication({ company, role, jobId, source: 'gmail' });
  a.events.push(...events.map(([date, stage, extra]) => email(`${date}T12:00:00.000Z`, stage, { threadId, ...extra })));
  return refresh(a);
}

test('findApplication: the same Gmail thread wins over everything else', () => {
  const a = gmailApp({ company: 'Contoso', threadId: 't-1' });
  assert.equal(s.findApplication({ threadId: 't-1', company: 'Someone Else' }), a);
});

test('findApplication: company names match despite case and legal suffixes', () => {
  const a = gmailApp({ company: 'Contoso Inc.' });
  assert.equal(s.findApplication({ company: 'contoso' }), a);
});

test('findApplication: same job ID is the same job; a different ID is a new one', () => {
  const a = gmailApp({ company: 'Fabrikam', jobId: 'R-100' });
  assert.equal(s.findApplication({ company: 'Fabrikam', jobId: 'R-100' }), a);
  assert.equal(s.findApplication({ company: 'Fabrikam', jobId: 'R-200' }), null);
});

test('findApplication: a role worded slightly differently still matches', () => {
  const a = gmailApp({ company: 'Litware', role: 'Software Engineer Intern' });
  assert.equal(s.findApplication({ company: 'Litware', role: 'Software Engineer Intern | Platform' }), a);
});

test('findApplication: a different known role at the same company is separate', () => {
  gmailApp({ company: 'Litware', role: 'Software Engineer Intern' });
  assert.equal(s.findApplication({ company: 'Litware', role: 'Data Analyst Intern' }), null);
});

test('findApplication: names you renamed away from still find the application', () => {
  const a = gmailApp({ company: 'Capital One' });
  a.aliases = ['CapitalOne-HR'];
  assert.equal(s.findApplication({ company: 'capitalone hr' }), a);
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
  const snapshots = s.snapshotEdits();

  // Simulate the re-scan rebuilding the application from the same emails.
  const emails = a.events.filter(e => e.messageId);
  s.db.applications.length = 0;
  const rebuilt = s.createApplication({ company: 'CapitalOne', source: 'gmail' });
  rebuilt.events.push(...structuredClone(emails));
  refresh(rebuilt);
  assert.equal(rebuilt.status, 'interview');

  assert.deepEqual(s.restoreEdits(snapshots), { restored: 1, kept: 0 });
  assert.equal(rebuilt.company, 'Capital One');
  assert.equal(rebuilt.notes, 'Referred by a friend');
  assert.equal(rebuilt.status, 'rejected');
});

test('re-scan keeps an edited application whose emails no longer classify', () => {
  const a = gmailApp({ company: 'Trey Research' });
  a.notes = 'Keep me';
  const snapshots = s.snapshotEdits();
  s.db.applications.length = 0;
  assert.deepEqual(s.restoreEdits(snapshots), { restored: 0, kept: 1 });
  assert.equal(s.db.applications[0].notes, 'Keep me');
});

test('matchApplication: a pick among several applications at one company is a guess', () => {
  gmailApp({ company: 'Contoso', role: 'Data Analyst Intern' });
  gmailApp({ company: 'Contoso', role: 'Software Engineer Intern' });
  assert.equal(s.matchApplication({ company: 'Contoso' }).guess, true);
  assert.equal(s.matchApplication({ company: 'Contoso', role: 'Software Engineer Intern' }).guess, false);
  gmailApp({ company: 'Fabrikam' });
  assert.equal(s.matchApplication({ company: 'Fabrikam' }).guess, false);
});

test('reassignEmail: confirming marks the email checked and remembers where it goes', () => {
  const a = gmailApp({ company: 'Contoso', events: [['2026-09-01', 'applied'], ['2026-09-05', 'oa', { review: [{ about: 'application', text: '?' }] }]] });
  assert.equal(a.needsReview, true);
  const e = a.events[1];
  s.reassignEmail(e.id, { action: 'confirm' });
  assert.equal(a.needsReview, false);
  assert.equal(s.assignedApplication(e.messageId), a);
});

test('reassignEmail: moving an email takes its stage along and empties out a stray application', () => {
  const right = gmailApp({ company: 'Contoso', role: 'Software Engineer Intern' });
  const stray = gmailApp({ company: 'Unknown company', events: [['2026-09-05', 'interview']] });
  const e = stray.events[0];
  const { app } = s.reassignEmail(e.id, { action: 'move', to: right.id });
  assert.equal(app, right);
  assert.equal(right.status, 'interview');
  assert.ok(!s.db.applications.includes(stray));
  // After a re-scan the ids are new; the email still finds its way back by another of its emails.
  const assignment = s.db.assignments[e.messageId];
  s.db.applications.length = 0;
  const rebuilt = gmailApp({ company: 'Contoso', events: [['2026-09-01', 'applied', { messageId: assignment.anchors[0] }]] });
  assert.equal(s.assignedApplication(e.messageId), rebuilt);
});

test('reassignEmail: a new application, or not an application at all', () => {
  const a = gmailApp({ company: 'Contoso', events: [['2026-09-01', 'applied'], ['2026-09-03', 'applied'], ['2026-09-04', 'applied']] });
  const [, second, third] = a.events;
  const { app } = s.reassignEmail(second.id, { action: 'new', company: 'Fabrikam', role: 'Analyst' });
  assert.equal(app.company, 'Fabrikam');
  assert.deepEqual(app.events, [second]);
  assert.equal(s.reassignEmail(third.id, { action: 'new', company: '  ' }).status, 400);
  s.reassignEmail(third.id, { action: 'ignore' });
  assert.equal(a.events.length, 1);
  assert.equal(s.db.ignored[third.messageId], true);
  assert.equal(s.reassignEmail('nope', { action: 'confirm' }).status, 404);
});

test('blocking a sender removes its emails, drops emptied applications and skips it from now on', () => {
  const bills = s.createApplication({ company: 'Simplebills', source: 'gmail' });
  bills.events.push(email('2026-09-01', 'applied', { from: 'SimpleBills <hello@simplebills.com>' }));
  refresh(bills);
  const mixed = s.createApplication({ company: 'Contoso', source: 'gmail' });
  mixed.events.push(email('2026-09-01', 'applied', { from: 'Contoso <jobs@contoso.com>' }));
  mixed.events.push(email('2026-09-02', 'oa', { from: 'Billing <billing@simplebills.com>' }));
  refresh(mixed);
  const blockedId = bills.events[0].messageId;

  assert.equal(s.blockSender('simplebills.com'), 2);
  assert.deepEqual(s.applications.map(a => a.company), ['Contoso']);
  assert.equal(mixed.events.length, 1);
  assert.equal(mixed.status, 'applied');
  assert.equal(s.db.ignored[blockedId], true);
  assert.equal(s.isBlocked('X <a@simplebills.com>'), true);

  s.unblockSender('simplebills.com');
  assert.equal(s.isBlocked('X <a@simplebills.com>'), false);
});

test('a guessed match lists every application it could have been', () => {
  gmailApp({ company: 'Contoso', role: 'Data Analyst Intern' });
  gmailApp({ company: 'Contoso', role: 'Software Engineer' });
  const m = s.matchApplication({ company: 'Contoso' });
  assert.equal(m.guess, true);
  assert.equal(m.candidates.length, 2);
  assert.equal(s.matchApplication({ company: 'Contoso', role: 'Software Engineer' }).candidates, undefined);
});

test('fixes to sorting are counted by kind', () => {
  const a = gmailApp({ company: 'Contoso', events: [['2026-09-01', 'applied'], ['2026-09-02', 'oa']] });
  const b = gmailApp({ company: 'Fabrikam' });
  s.reassignEmail(a.events[0].id, { action: 'confirm' });
  s.reassignEmail(a.events[1].id, { action: 'move', to: b.id });
  assert.deepEqual(s.db.corrections, { confirmed: 1, moved: 1 });
});

test('undo puts back a deleted application, and its emails can sync again', () => {
  const a = gmailApp({ company: 'Contoso', events: [['2026-09-01', 'applied'], ['2026-09-05', 'oa']] });
  a.notes = 'Referral from Pat';
  const messageId = a.events[0].messageId;
  const token = s.checkpoint([a.id]);
  s.deleteApplication(a.id);
  assert.equal(s.db.ignored[messageId], true);
  assert.equal(s.undo(token), true);
  const back = s.applications.find(x => x.id === a.id);
  assert.equal(back.notes, 'Referral from Pat');
  assert.equal(back.status, 'oa');
  assert.equal(s.db.ignored[messageId], undefined);
  assert.equal(s.undo(token), false); // once only
});

test('undo moves an email back, and removes an application the move created', () => {
  const a = gmailApp({ company: 'Contoso', events: [['2026-09-01', 'applied'], ['2026-09-05', 'oa']] });
  const b = gmailApp({ company: 'Fabrikam' });
  const moved = a.events[1];
  const t1 = s.checkpoint([a.id, b.id]);
  s.reassignEmail(moved.id, { action: 'move', to: b.id });
  s.undo(t1);
  assert.ok(s.applications.find(x => x.id === a.id).events.some(e => e.id === moved.id));
  assert.ok(!s.applications.find(x => x.id === b.id).events.some(e => e.id === moved.id));
  assert.equal(s.db.assignments[moved.messageId], undefined);

  const t2 = s.checkpoint([a.id]);
  const { app: created } = s.reassignEmail(moved.id, { action: 'new', company: 'Northwind' });
  s.undoAlsoRemoves(t2, created.id);
  s.undo(t2);
  assert.equal(s.applications.some(x => x.company === 'Northwind'), false);
  assert.equal(s.applications.find(x => x.id === a.id).events.length, 2);
});

test('undo stops ignoring a sender and brings its emails back, keeping newer ones', () => {
  const bills = s.createApplication({ company: 'Simplebills', source: 'gmail' });
  bills.events.push(email('2026-09-01', 'applied', { from: 'SimpleBills <hello@simplebills.com>' }));
  refresh(bills);
  const token = s.checkpoint([bills.id], { blockedSender: 'simplebills.com' });
  s.blockSender('simplebills.com');
  assert.equal(s.applications.length, 0);
  s.undo(token);
  assert.equal(s.applications.length, 1);
  assert.equal(s.isBlocked('a@simplebills.com'), false);
  assert.deepEqual(s.db.corrections, {});

  // A sync that adds to an application during the undo window isn't lost.
  const c = gmailApp({ company: 'Contoso' });
  const t = s.checkpoint([c.id]);
  c.events.push(email('2026-09-09', 'interview'));
  refresh(c);
  s.undo(t);
  assert.equal(s.applications.find(x => x.id === c.id).events.length, 2);
});

// ---- two applications at one company, told apart by when the emails were sent

const at = day => `${day}T12:00:00.000Z`;

test('a new "thanks for applying" after a rejection starts a new application', () => {
  const old = gmailApp({ company: 'Contoso', role: 'Software Engineer Intern', events: [['2026-01-10', 'applied'], ['2026-02-01', 'rejected']] });
  assert.equal(s.matchApplication({ company: 'Contoso', role: 'Software Engineer Intern', date: at('2026-08-01'), stage: 'applied' }).app, null);
  // Without a role, too, and a withdrawn application counts as closed.
  assert.equal(s.matchApplication({ company: 'Contoso', date: at('2026-08-01'), stage: 'applied' }).app, null);
  old.events.at(-1).stage = 'withdrawn';
  refresh(old);
  assert.equal(s.findApplication({ company: 'Contoso', date: at('2026-02-03'), stage: 'applied' }), null);
  // Sent the same day it closed: more likely a late copy of the first confirmation.
  assert.equal(s.findApplication({ company: 'Contoso', date: '2026-02-01T18:00:00.000Z', stage: 'applied' }), old);
});

test('follow-ups stay with their application however late they come', () => {
  const a = gmailApp({ company: 'Fabrikam', role: 'Backend Engineer', events: [['2026-01-10', 'applied'], ['2026-02-01', 'rejected']] });
  for (const stage of ['oa', 'interview', 'offer', 'rejected']) {
    assert.equal(s.findApplication({ company: 'Fabrikam', role: 'Backend Engineer', date: at('2026-09-01'), stage }), a);
  }
  // An open application, quiet for a while: another "applied" email is part of it.
  const open = gmailApp({ company: 'Northwind', events: [['2026-03-01', 'applied'], ['2026-03-20', 'interview']] });
  assert.equal(s.findApplication({ company: 'Northwind', date: at('2026-06-01'), stage: 'applied' }), open);
  // The same thread or job ID is always the same application.
  assert.equal(s.findApplication({ threadId: a.events[0].threadId, company: 'Fabrikam', date: at('2026-09-01'), stage: 'applied' }), a);
  const withId = gmailApp({ company: 'Litware', jobId: 'R-1', events: [['2026-01-10', 'applied'], ['2026-02-01', 'rejected']] });
  assert.equal(s.findApplication({ company: 'Litware', jobId: 'R-1', date: at('2026-09-01'), stage: 'applied' }), withId);
});

test('after months of silence a new "thanks for applying" starts a new application', () => {
  const a = gmailApp({ company: 'Proseware', events: [['2026-01-10', 'applied']] });
  assert.equal(s.findApplication({ company: 'Proseware', date: at('2026-05-01'), stage: 'applied' }), a);
  assert.equal(s.findApplication({ company: 'Proseware', date: at('2026-06-01'), stage: 'applied' }), null);
});

test('applied twice for one role: later emails go to the application still open', () => {
  gmailApp({ company: 'Contoso', role: 'Software Engineer Intern', events: [['2026-01-10', 'applied'], ['2026-02-01', 'rejected']] });
  const again = gmailApp({ company: 'Contoso', role: 'Software Engineer Intern', events: [['2026-08-01', 'applied']] });
  const m = s.matchApplication({ company: 'Contoso', role: 'Software Engineer Intern', date: at('2026-08-10'), stage: 'oa' });
  assert.equal(m.app, again);
  assert.equal(m.guess, false);
});

// What a sync does with each email, oldest first (see Mailbox#drain in src/gmail.js).
function syncEmail(e, { company, role = '' }) {
  const app = s.assignedApplication(e.messageId) ||
    s.matchApplication({ threadId: e.threadId, company, role, date: e.date, stage: e.stage }).app ||
    s.createApplication({ company, role, source: 'gmail' });
  app.events.push(structuredClone(e));
  refresh(app);
}

test('splitting emails off into a new application, which a re-scan keeps apart', () => {
  // One thread-less confirmation each time, so only the name links them: merged.
  const merged = gmailApp({ company: 'Woodgrove Bank', role: 'Analyst', events: [
    ['2026-01-10', 'applied', { threadId: 't1' }], ['2026-01-20', 'oa', { threadId: 't1' }],
    ['2026-03-01', 'applied', { threadId: 't2', jobId: 'R-9' }], ['2026-03-10', 'interview', { threadId: 't2' }],
  ] });
  const [, , second, interview] = merged.events;
  const { app } = s.reassignEmail(second.id, { action: 'new', company: 'Woodgrove Bank', role: 'Analyst', also: [interview.id, 'not-here'] });
  assert.equal(s.applications.length, 2);
  assert.deepEqual(app.events.map(e => e.stage), ['applied', 'interview']);
  assert.equal(app.status, 'interview');
  assert.equal(app.appliedAt, at('2026-03-01'));
  assert.equal(app.jobId, 'R-9'); // from the emails split off
  assert.deepEqual(merged.events.map(e => e.stage), ['applied', 'oa']);
  assert.equal(merged.status, 'oa');
  assert.deepEqual(s.db.corrections, { moved: 2 });

  // A full re-scan rebuilds everything from the emails, oldest first.
  const emails = s.applications.flatMap(a => a.events).sort((a, b) => a.date.localeCompare(b.date));
  s.db.applications.length = 0;
  for (const e of emails) syncEmail(e, { company: 'Woodgrove Bank', role: 'Analyst' });
  assert.equal(s.applications.length, 2);
  const [first, split] = s.applications;
  assert.deepEqual(first.events.map(e => e.stage), ['applied', 'oa']);
  assert.deepEqual(split.events.map(e => e.stage), ['applied', 'interview']);
});
