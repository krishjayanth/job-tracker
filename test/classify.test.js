import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWithRules, classifyWithRules, classify } from '../src/classify.js';
import { GATE_MODEL, pickApplicationWithGroq } from '../src/groq.js';

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

test('picking an application: uses the model\'s choice only when it is sure and in range', async () => {
  const answer = out => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }] }) } } });
  const apps = [
    { role: 'Data Analyst Intern', jobId: '', status: 'applied', appliedAt: '2026-09-01T00:00:00Z', subjects: ['Thanks for applying: Data Analyst Intern'] },
    { role: 'Software Engineer', jobId: 'R-1', status: 'oa', appliedAt: '2026-09-10T00:00:00Z', subjects: [] },
  ];
  const mail = { from: 'x@contoso.com', subject: 'Next steps', body: 'About the analyst internship...' };
  assert.equal(await pickApplicationWithGroq(answer({ reasoning: '', choice: 0, confidence: 'high' }), mail, apps), 0);
  assert.equal(await pickApplicationWithGroq(answer({ reasoning: '', choice: 1, confidence: 'low' }), mail, apps), -1);
  assert.equal(await pickApplicationWithGroq(answer({ reasoning: '', choice: 5, confidence: 'high' }), mail, apps), -1);
});

// ---- from problem reports (each failed before its fix) ------------------------------

test('your own sent emails are never filed as an application', async () => {
  const own = { from: 'Sam Rivera <Sam.Rivera@gmail.com>', subject: 'Re: Interview availability', date: '2026-09-09T12:00:00.000Z',
    body: 'Hi Jordan, thanks for reaching out. I am free Tuesday or Wednesday afternoon for the interview. Best, Sam Rivera' };
  assert.equal(await classify(own, { self: 'sam.rivera@gmail.com' }), null);
  // The same email from the recruiter's side is still read.
  assert.equal((await classify({ ...own, from: 'Jordan Lee <jordan@woodgrovebank.com>' }, { self: 'sam.rivera@gmail.com' }))?.stage, 'interview');
});

test('the Gmail search leaves out mail you sent', async () => {
  const { BASE_QUERY } = await import('../src/gmail.js');
  assert.match(BASE_QUERY, /(^| )-from:me( |$)/);
});

// A HireVue reminder warns what happens if you don't finish; that isn't a rejection.
const reminder = body => ({ from: 'Air Force Civilian Service <noreply@hirevue.com>', subject: 'Interview with Air Force Civilian Service',
  date: '2026-09-09T12:00:00.000Z', body });
const WARNINGS = [
  'Reminder: please complete your HireVue interview by September 12. If you do not complete it by then, unfortunately your application will not move forward.',
  'Reminder: complete your HireVue interview by September 12, otherwise we will not be moving forward with your candidacy.',
  'Please finish your video interview by Friday. Failure to complete the interview means we will not be moving forward with your application.',
  'Your HireVue interview is due Friday. Unless it is completed, your application will not move forward.',
];

test('rules: a warning about not finishing an assessment is not a rejection', () => {
  for (const body of WARNINGS) assert.equal(classifyWithRules(reminder(body)).stage, 'oa', body);
});

test('rules: a real rejection that mentions "if" elsewhere is still a rejection', () => {
  const e = { from: 'Contoso Recruiting <no-reply@us.greenhouse-mail.io>', subject: 'Your application to Contoso', date: '2026-09-09T12:00:00.000Z',
    body: 'Thank you for applying. Unfortunately, we have decided to move forward with other candidates. We will contact you if another role opens up.' };
  assert.equal(classifyWithRules(e).stage, 'rejected');
});

test('merge: a warning in a reminder does not overrule the model\'s "assessment"', () => {
  for (const body of WARNINGS) {
    const e = reminder(body);
    assert.equal(mergeWithRules(llm({ stage: 'oa', company: 'Air Force Civilian Service' }), classifyWithRules(e), e).stage, 'oa', body);
  }
});

test('merge: when the rules overrule the model it is flagged, quoting the words', () => {
  const e = { from: 'Contoso <no-reply@us.greenhouse-mail.io>', subject: 'Contoso: next steps', date: '2026-09-09T12:00:00.000Z',
    body: 'Thanks for completing the assessment. Unfortunately, we have decided to move forward with other candidates.' };
  const r = mergeWithRules(llm({ stage: 'oa', company: 'Contoso' }), classifyWithRules(e), e);
  assert.equal(r.stage, 'rejected');
  const note = r.review.find(x => x.about === 'stage');
  assert.ok(note, 'expected a review note about the stage');
  assert.match(note.text, /unfortunately/i);
});

test('merge: no note when the model already agreed it was a rejection', () => {
  const e = { from: 'Contoso <no-reply@us.greenhouse-mail.io>', subject: 'Contoso update', date: '2026-09-09T12:00:00.000Z',
    body: 'Unfortunately, we have decided to move forward with other candidates.' };
  assert.deepEqual(mergeWithRules(llm({ stage: 'rejected', company: 'Contoso' }), classifyWithRules(e), e).review, []);
});

const club = { from: 'Horizons Finance Guild <horizonsfinance@gmail.com>', subject: 'Horizons Finance Guild - Application Update', date: '2026-08-29T12:00:00.000Z',
  body: 'Thanks for applying to Horizons Finance Guild! We would like to interview you for an analyst position at our next general body meeting.' };

test('pipeline: a club email goes to the job check, which can turn it away', async () => {
  const groq = fakeGroq({ gate: false, read: { ...fullRead, stage: 'interview', company: 'Horizons Finance Guild' } });
  assert.equal(await classify(club, { groq }), null);
  assert.ok(groq.calls.includes(GATE_MODEL));
});

test('pipeline: without a key, a club email is flagged as maybe not a job', async () => {
  const r = await classify(club);
  assert.ok(r?.review.some(x => /not sure this is about a job/i.test(x.text)), JSON.stringify(r?.review));
});

test('both prompts tell the model student clubs are not jobs', async () => {
  const prompts = [];
  const groq = { chat: { completions: { create: async req => {
    prompts.push(req.messages[0].content);
    const content = req.model === GATE_MODEL ? JSON.stringify({ job: true, why: 'test' }) : JSON.stringify(fullRead);
    return { choices: [{ finish_reason: 'stop', message: { content } }] };
  } } } };
  await classify(vague, { groq });
  assert.equal(prompts.length, 2);
  for (const p of prompts) assert.match(p, /student clubs/i);
});
