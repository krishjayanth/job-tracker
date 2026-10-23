import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWithRules, classifyWithRules, classify } from '../src/classify.js';
import { GATE_MODEL } from '../src/groq.js';

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

// A stand-in for the Groq client: answers the job check and the full read, and records calls.
function fakeGroq({ gate, read }) {
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async req => {
      calls.push(req.model);
      const content = req.model === GATE_MODEL ? JSON.stringify({ job: gate, why: 'test' }) : JSON.stringify(read);
      return { choices: [{ finish_reason: 'stop', message: { content } }] };
    } } },
  };
}
const fullRead = { reasoning: 'A confirmation.', is_job_application_email: true, stage: 'applied', company: 'Contoso', role: '',
  job_id: '', deadline: '', summary: 'Application received', confidence: 'high' };
const simpleBills = { from: 'SimpleBills <hello@simplebills.com>', subject: 'Thank you for your application!', date: '2026-10-01T12:00:00.000Z',
  body: 'Welcome to SimpleBills! We will set up your utilities and split bills with your roommates.' };
const vague = { from: 'Contoso <hello@contoso.com>', subject: 'Thank you for your application', date: '2026-10-01T12:00:00.000Z',
  body: 'Thank you for your application to Contoso. We will be in touch soon.' };

test('pipeline: a utility "application" is dropped before any AI call', async () => {
  const groq = fakeGroq({ gate: true, read: fullRead });
  assert.equal(await classify(simpleBills, { groq }), null);
  assert.equal(await classify(simpleBills), null); // rules too
  assert.deepEqual(groq.calls, []);
});

test('pipeline: an unclear email asks the small model first, and stops if it says no', async () => {
  const groq = fakeGroq({ gate: false, read: fullRead });
  assert.equal(await classify(vague, { groq }), null);
  assert.deepEqual(groq.calls, [GATE_MODEL]);
});

test('pipeline: when the small model says yes, the full read files it without a flag', async () => {
  const groq = fakeGroq({ gate: true, read: fullRead });
  const r = await classify(vague, { groq });
  assert.equal(r.company, 'Contoso');
  assert.equal(groq.calls.length, 2);
  assert.ok(!r.review.some(x => /Not sure this is about a job/.test(x.text)));
});

test('pipeline: with the rules alone, an unclear email is filed but flagged to check', async () => {
  const r = await classify(vague);
  assert.equal(r.stage, 'applied');
  assert.ok(r.review.some(x => /Not sure this is about a job/.test(x.text)));
});

test('pipeline: emails from hiring software skip the job check', async () => {
  const groq = fakeGroq({ gate: false, read: fullRead });
  const r = await classify({ ...vague, from: 'Contoso <no-reply@us.greenhouse-mail.io>' }, { groq });
  assert.equal(r.company, 'Contoso');
  assert.ok(!groq.calls.includes(GATE_MODEL));
});
