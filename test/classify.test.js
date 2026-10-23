import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWithRules, classifyWithRules } from '../src/classify.js';

const email = { from: 'Relecloud <noreply@hirevue.com>', subject: 'Relecloud interview invitation', date: '2026-10-01T12:00:00.000Z',
  body: 'Hi, thanks for applying to Relecloud. Please complete your HireVue interview. Requisition ID: R-12345.' };
const llm = over => ({ isJob: true, stage: 'interview', company: 'Relecloud', role: '', jobId: '', deadline: '',
  summary: 'HireVue interview to complete', confidence: 'high', reasoning: 'A HireVue invite.', ...over });
const merge = over => mergeWithRules(llm(over), classifyWithRules(email), email);

test('merge: a HireVue "interview" is an assessment even when the model says interview', () => {
  assert.equal(merge().stage, 'oa');
  assert.deepEqual(merge().review, []);
});

test('merge: a company the email never names is replaced and flagged', () => {
  const r = merge({ company: 'Contoso' });
  assert.equal(r.company, 'Relecloud');
  assert.equal(r.review[0].about, 'application');
});

test('merge: a low-confidence answer is flagged for you to confirm', () => {
  assert.ok(merge({ confidence: 'low' }).review.some(r => r.about === 'application'));
});

test("merge: the model's deadline is kept only when it's a plausible date after the email", () => {
  assert.equal(merge({ deadline: '2026-10-06' }).deadline, new Date(2026, 9, 6, 23, 59).toISOString());
  assert.equal(merge({ deadline: '2025-01-01' }).deadline, '');
  assert.equal(merge({ deadline: 'next week' }).deadline, '');
});
