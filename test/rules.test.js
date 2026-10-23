import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWithRules, extractJobId, extractDeadline, resolveCompanyName, stripJobId } from '../src/rules.js';

const email = (subject, body = '', from = 'Recruiting <no-reply@us.greenhouse-mail.io>') => ({ from, subject, body });

test('stage: confirmation, assessment, interview, offer and rejection emails', () => {
  const cases = [
    [email('Thank you for applying to Contoso', 'We have received your application.'), 'applied'],
    [email('Fabrikam Online Assessment', 'Please complete the coding assessment on HackerRank.'), 'oa'],
    [email('Next steps with Northwind', 'We would like to schedule a phone interview with you.'), 'interview'],
    [email('Congratulations from Litware!', 'We are pleased to extend you an offer of employment.'), 'offer'],
    [email('Your application to Proseware', 'Unfortunately, we have decided to move forward with other candidates.'), 'rejected'],
  ];
  for (const [e, stage] of cases) assert.equal(classifyWithRules(e)?.stage, stage, e.subject);
});

test('stage: a rejection that opens with "thank you for applying" is still a rejection', () => {
  const e = email('Your Woodgrove Bank application',
    'Thank you for applying. Unfortunately, we will not be moving forward with your candidacy.');
  assert.equal(classifyWithRules(e).stage, 'rejected');
});

test('stage: offer wording only counts when the subject says so', () => {
  const e = email('Assessment invitation from Trey Research',
    'We are excited to offer you the chance to take an online assessment.');
  assert.equal(classifyWithRules(e).stage, 'oa');
});

test('stage: "interview" in the subject wins over a plain confirmation body', () => {
  const e = email('Interview with Relecloud', 'Thank you for your application. Pick a time that works for you.');
  assert.equal(classifyWithRules(e).stage, 'interview');
});

test('stage: AI and recorded video interviews (HireVue etc.) are assessments', () => {
  const cases = [
    email('AI Interview: Relecloud', 'Thank you for your application. Your AI interview link is below.'),
    email('Relecloud Interview Invitation', 'Please complete your HireVue interview within 5 days.'),
    email('Next steps with Contoso', 'You are invited to a one-way video interview. Record your answers at any time.'),
    email('Fabrikam: interview invitation', 'Complete your interview by Friday.', 'Fabrikam <noreply@hirevue.com>'),
  ];
  for (const e of cases) assert.equal(classifyWithRules(e).stage, 'oa', e.subject);
  // A HireVue rejection is still a rejection.
  const no = email('Your Contoso application', 'Thank you for completing your HireVue. Unfortunately, we will not be moving forward.');
  assert.equal(classifyWithRules(no).stage, 'rejected');
});

test('non-application emails are ignored', () => {
  assert.equal(classifyWithRules(email('Your weekly newsletter', 'Ten tips for a better resume.')), null);
});

test('company: from the subject, ignoring Re:/Reminder prefixes', () => {
  assert.equal(classifyWithRules(email('Reminder: Thank you for applying to Wingtip Toys', 'Application received.')).company, 'Wingtip Toys');
});

test('company: from a Workday sender code when the subject has none', () => {
  const e = email('Application received', 'Thank you for applying. We have received your application.', 'HR <coho@myworkday.com>');
  assert.equal(classifyWithRules(e).company, 'Coho');
});

test('company: never the hiring software vendor', () => {
  const e = email('Application received', 'Thank you for applying.', 'Workday <no-reply@myworkday.com>');
  assert.notEqual(classifyWithRules(e).company.toLowerCase(), 'workday');
});

test('role and job ID come out of a typical confirmation', () => {
  const r = classifyWithRules(email(
    'Thank you for applying to Contoso',
    'Thank you for your application for the Software Engineer Intern position. Requisition ID: R-574294.'));
  assert.equal(r.role, 'Software Engineer Intern');
  assert.equal(r.jobId, 'R-574294');
});

test('extractJobId: labelled, Workday-style and bare IDs; not years', () => {
  assert.equal(extractJobId('', 'Job number: 200046156'), '200046156');
  assert.equal(extractJobId('Software Engineer Intern (R-2026-73270)', ''), 'R-2026-73270');
  assert.equal(extractJobId('Data Analyst JR2026958', ''), 'JR2026958');
  assert.equal(extractJobId('Software Developer Co-op - 39908', ''), '39908');
  assert.equal(extractJobId('Summer 2027 Internship', 'Thanks for applying!'), '');
});

test('stripJobId removes the ID from a role title', () => {
  assert.equal(stripJobId('Software Developer Intern 2027 - 128497', '128497'), 'Software Developer Intern 2027');
  assert.equal(stripJobId('AI Intern (Job number: 200049019)', '200049019'), 'AI Intern');
});

test('resolveCompanyName maps sender codes and strips legal suffixes', () => {
  assert.equal(resolveCompanyName('fmr'), 'Fidelity Investments');
  assert.equal(resolveCompanyName('Fabrikam, Inc.'), 'Fabrikam');
  assert.equal(resolveCompanyName('Contoso Corporation'), 'Contoso');
});

test('extractDeadline: absolute dates, with and without a time', () => {
  const sent = new Date(2026, 9, 1, 10, 0).toISOString();
  assert.equal(
    extractDeadline('Please complete the assessment by October 9 at 11:59 PM.', sent),
    new Date(2026, 9, 9, 23, 59).toISOString());
  assert.equal(
    extractDeadline('The link expires on Oct 12.', sent),
    new Date(2026, 9, 12, 23, 59).toISOString());
});

test('extractDeadline: relative deadlines count from the email date', () => {
  const sent = new Date(2026, 9, 1, 10, 0);
  const expected = new Date(2026, 9, 6, 23, 59).toISOString();
  assert.equal(extractDeadline('This assessment expires in 5 days.', sent.toISOString()), expected);
  assert.equal(extractDeadline('You have five days to complete the challenge, due within 5 days.', sent.toISOString()), expected);
});

test('extractDeadline: a December email\'s "Jan 5" means next year', () => {
  const sent = new Date(2026, 11, 20).toISOString();
  assert.equal(extractDeadline('Submit your work by Jan 5.', sent), new Date(2027, 0, 5, 23, 59).toISOString());
});

test('extractDeadline: ignores the company\'s own promises and past dates', () => {
  const sent = new Date(2026, 9, 1).toISOString();
  assert.equal(extractDeadline('We will get back to you within 5 days.', sent), '');
  assert.equal(extractDeadline('Please complete it by September 3.', sent), '');
});
