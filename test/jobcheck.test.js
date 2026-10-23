import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobSignal, fromHiringSoftware, canBlockDomain, senderDomain } from '../src/jobcheck.js';

const verdict = (subject, body = '', from = 'Team <hello@example.com>') => jobSignal({ from, subject, body }).verdict;

test('rental, utility, bank and school applications are not jobs', () => {
  assert.equal(verdict('Thank you for your application!', 'Welcome to SimpleBills. We will set up your utilities and split your bills with roommates.', 'SimpleBills <hello@simplebills.com>'), 'not_job');
  assert.equal(verdict('We received your rental application', 'Your application for the apartment at 12 Elm St is being reviewed by the landlord.'), 'not_job');
  assert.equal(verdict('Your credit card application', 'Thank you for applying. We will complete a credit check.'), 'not_job');
  assert.equal(verdict('Application received', 'Thanks for applying for admission. The admissions office will contact you about financial aid.'), 'not_job');
});

test('job emails from employers and hiring software are jobs', () => {
  assert.equal(verdict('Thank you for applying to Contoso', 'We received your application for the Software Engineer Intern position.'), 'job');
  assert.equal(verdict('Your application', 'Thanks!', 'Contoso <no-reply@us.greenhouse-mail.io>'), 'job');
  // An employer whose name is a finance word, with a normal footer.
  assert.equal(verdict('Thank you for applying to State Farm Insurance', 'We received your application for the Data Analyst role. Privacy Policy | Terms'), 'job');
  assert.equal(verdict('Visa: interview invitation', 'We would like to schedule an interview for the Associate role.'), 'job');
});

test('an application that never says what it is for is unsure', () => {
  assert.equal(verdict('Thank you for your application', 'We will be in touch soon.'), 'unsure');
});

test('hiring software is recognised by domain or exact address', () => {
  assert.equal(fromHiringSoftware('Workday <contoso@myworkday.com>'), true);
  assert.equal(fromHiringSoftware('<jobs-noreply@linkedin.com>'), true);
  assert.equal(fromHiringSoftware('LinkedIn <messages-noreply@linkedin.com>'), false); // social, not applications
  assert.equal(fromHiringSoftware('Rippling <payroll@rippling.com>'), false);
});

test('only an ordinary company domain can be blocked', () => {
  assert.equal(senderDomain('SimpleBills <Hello@SimpleBills.com>'), 'simplebills.com');
  assert.equal(canBlockDomain('simplebills.com'), true);
  assert.equal(canBlockDomain('gmail.com'), false);
  assert.equal(canBlockDomain('us.greenhouse-mail.io'), false);
  assert.equal(canBlockDomain('not a domain'), false);
});
