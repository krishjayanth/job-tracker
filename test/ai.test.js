import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ai.js reads its limits at import time; a small server-wide limit makes it easy to reach.
process.env.INSIGHTS_DAILY_LIMIT = '3';
process.env.INSIGHTS_SERVER_DAILY_LIMIT = '5';
let ai, store;
before(async () => {
  store = await import('../src/store.js');
  ai = await import('../src/ai.js');
  await store.initStorage({ inMemory: true });
});
beforeEach(() => store.setKv('insights_usage', null));

const person = (id, owner = false) => ({ id, owner, store: new store.Store(`db_${id}`) });

// Stands in for the OpenAI client: answers with `out`, or fails the way the API does.
const fakeClient = (out, { finish = 'stop', fail } = {}) => ({
  chat: { completions: { create: async req => {
    fakeClient.last = req;
    if (fail) throw Object.assign(new Error('API error'), { status: fail });
    return { choices: [{ finish_reason: finish, message: { content: JSON.stringify(out) } }] };
  } } },
});

test('everyone but the owner gets a few runs a day', async () => {
  const friend = person('friend');
  for (let i = 0; i < 3; i++) assert.ok((await ai.reserveRun(friend)).release, `run ${i + 1}`);
  const fourth = await ai.reserveRun(friend);
  assert.equal(fourth.status, 429);
  assert.match(fourth.error, /today's 3/);
  assert.equal(ai.aiStatus(friend).left, 0);
  assert.equal((await ai.serverUsage()).limited.length, 1);

  const owner = person('owner', true);
  for (let i = 0; i < 4; i++) assert.ok((await ai.reserveRun(owner)).release);
  assert.equal(ai.aiStatus(owner).left, null);
});

test('runs asked for all at once still stop at the limit', async () => {
  const friend = person('rush');
  const runs = await Promise.all([1, 2, 3, 4, 5].map(() => ai.reserveRun(friend)));
  assert.equal(runs.filter(r => r.release).length, 3);
  assert.equal(runs.filter(r => r.status === 429).length, 2);
});

test('a run that fails is given back', async () => {
  const friend = person('refund');
  const run = await ai.reserveRun(friend);
  assert.equal(ai.aiStatus(friend).left, 2);
  await run.release();
  assert.equal(ai.aiStatus(friend).left, 3);
  assert.equal((await ai.serverUsage()).runs, 0);
});

test('the server stops everyone but the owner at its daily limit', async () => {
  const a = person('a'), b = person('b');
  for (let i = 0; i < 3; i++) await ai.reserveRun(a);
  for (let i = 0; i < 2; i++) await ai.reserveRun(b);
  const blocked = await ai.reserveRun(b);
  assert.equal(blocked.status, 503);
  assert.equal(ai.aiStatus(b).left, 1); // the refused run wasn't counted against them
  assert.ok((await ai.reserveRun(person('boss', true))).release);
});

test('asking with the same inputs gives the same fingerprint, so it isn\'t run again', () => {
  const input = { resume: 'text', overall: { applications: 3 } };
  assert.equal(ai.hashOf(input), ai.hashOf(structuredClone(input)));
  assert.notEqual(ai.hashOf(input), ai.hashOf({ ...input, resume: 'new text' }));
});

const input = {
  skillsMissingFromResume: [{ skill: 'Kubernetes', postings: 3, movedForward: 2 }],
  skillsInResume: [{ skill: 'React', postings: 2, movedForward: 1 }],
};

test('suggestions keep only known sections and keywords that were in the lists given', () => {
  const items = ai.checkSuggestions({ suggestions: [
    { title: 'Name Kubernetes', why: 'In 3 postings', change: 'Add it to Skills if true', section: 'Skills', keywords: ['kubernetes', 'Rust'] },
    { title: 'Whatever', why: '', change: 'Do a thing', section: 'Hobbies', keywords: [] },
    { title: '', why: 'No title', change: 'x', section: 'Skills', keywords: [] },
  ] }, input);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].keywords, ['Kubernetes']); // Rust was never in the data
  assert.equal(items[1].section, 'Overall');
  assert.ok(items.every(s => s.state === 'open' && s.id));
});

test('suggestions come back from the model, and a cut-off or failed answer is a plain error', async () => {
  const out = { suggestions: [{ title: 'Name Kubernetes', why: 'In 3 postings', change: 'Add it', section: 'Skills', keywords: ['Kubernetes'] }] };
  const items = await ai.writeSuggestions(input, { client: fakeClient(out) });
  assert.equal(items[0].title, 'Name Kubernetes');
  assert.equal(fakeClient.last.response_format.json_schema.strict, true);
  assert.ok(!JSON.stringify(fakeClient.last.messages).includes('company'), 'no company names are sent');
  await assert.rejects(ai.writeSuggestions(input, { client: fakeClient(out, { finish: 'length' }) }), /couldn't finish/);
  await assert.rejects(ai.writeSuggestions(input, { client: fakeClient(out, { fail: 429 }) }), /busy/);
  await assert.rejects(ai.writeSuggestions(input, { client: fakeClient({ suggestions: [] }) }), /anything useful/);
});

test('check fit keeps requirements from the posting and rewrites of real resume lines', () => {
  const resumeText = 'Experience\n• Built a REST API used by 1,200 people\n• Fixed bugs';
  const posting = 'You will build REST APIs in Node.js. Experience with Kubernetes is a plus.';
  const fit = ai.checkFit({
    match: 'great', summary: 'Close.',
    matched: ['REST APIs', 'Python'], missing: ['Kubernetes', 'ten years of Rust'],
    rewrites: [
      { from: 'Built a REST API used by 1,200 people', to: 'Built a Node.js REST API used by 1,200 people', why: 'Names Node.js' },
      { from: 'Led a team of 40 engineers', to: 'Led a team', why: 'Made up' },
      { from: 'Built a REST API used by 1,200 people', to: 'built a rest api used by 1,200 people', why: 'No change' },
    ],
  }, { resumeText, posting });
  assert.equal(fit.match, 'partial'); // not one of the three answers
  assert.deepEqual(fit.matched, ['REST APIs']);
  assert.deepEqual(fit.missing, ['Kubernetes']);
  assert.equal(fit.rewrites.length, 1);
  assert.match(fit.rewrites[0].to, /Node\.js/);
});

test('demo answers pass the same checks', () => {
  const resumeText = 'Projects\n• Built a REST API in Node.js used by 1,200 people\nSkills\nReact';
  const posting = 'React, Node.js and Kubernetes';
  const fit = ai.demoFit({ resumeText, posting });
  assert.deepEqual(fit.missing, ['Kubernetes']);
  assert.equal(fit.rewrites.length, 1);
  const items = ai.demoSuggestions({
    ...input, byVersion: [], checksThatFailed: [],
    byKindOfRole: [{ kind: 'Frontend', applications: 6, finished: 5, movedForward: 3 }],
  });
  assert.ok(items.length >= 2);
  assert.deepEqual(items[0].keywords, ['Kubernetes']);
});

test('suggestions keep the resume lines they point at, and drop lines that are not there', () => {
  const resume = 'Experience\n• Rebuilt 6 member pages in JavaScript, raising sign-ups by 18%\n• Fixed bugs';
  const [s] = ai.checkSuggestions({ suggestions: [{
    title: 'Lead with results', why: 'Easier to skim', change: 'Put the result first', section: 'Experience', keywords: [],
    lines: ['rebuilt 6 member pages in javascript, raising sign-ups by 18%', 'Led a team of 40 engineers'],
    rewrites: [
      { from: 'Rebuilt 6 member pages in JavaScript, raising sign-ups by 18%', to: 'Raised sign-ups by 18% by rebuilding 6 pages' },
      { from: 'Invented the internet in a weekend', to: 'Invented it' },
    ],
  }] }, { ...input, resume });
  assert.equal(s.lines.length, 1);
  assert.equal(s.rewrites.length, 1);
  assert.equal(ai.findLine(resume, s.lines[0]), 1);
  assert.equal(ai.findLine(resume, 'Fixed bugs'), -1); // too short to tell apart
});

test('a rewrite that adds a number the line did not have is dropped, as made up', () => {
  assert.equal(ai.addsNumbers('Built the sign-up page', 'Built the sign-up page, raising sign-ups by 40%'), true);
  assert.equal(ai.addsNumbers('Cut load time by 40% across 3 pages', 'Across 3 pages, cut load time by 40%'), false);
  assert.equal(ai.addsNumbers('Built the sign-up page', 'Built the sign-up page, raising sign-ups by [X%]'), false);
  const resume = 'Experience\n• Built the sign-up page';
  const [s] = ai.checkSuggestions({ suggestions: [{
    title: 'Add results', why: 'x', change: 'Say how it went', section: 'Experience', keywords: [], lines: [],
    rewrites: [{ from: 'Built the sign-up page', to: 'Built the sign-up page, raising sign-ups by 40%' }],
  }] }, { ...input, resume });
  assert.equal(s.rewrites.length, 0);
  const fit = ai.checkFit({ match: 'weak', summary: '', matched: [], missing: [],
    rewrites: [{ from: 'Built the sign-up page', to: 'Built the sign-up page for 10,000 users', why: '' }] }, { resumeText: resume, posting: 'x' });
  assert.equal(fit.rewrites.length, 0);
});

test('the AI is told about small groups and interviews, and never sees your name or contact details', () => {
  const group = (key, counted, extra = {}) => ({ key, name: key, total: counted, counted, forward: 1, interviews: 1, ...extra });
  const sent = ai.suggestionsInput({
    resumeText: 'Sam Example\nsam@example.com · 555-123-4567\nExperience\n• Built things',
    versionName: 'v1', apps: [],
    insights: {
      total: 8, counted: 8, forward: 3, interviews: 1, mainKinds: ['Data'],
      byVersion: [group('v1', 6), group('v0', 2)], byFunction: [], byLevel: [],
      keywords: { missing: [{ name: 'SQL', postings: 2, forward: 1, kinds: ['Data'] }], matched: [] }, checks: [],
    },
  });
  assert.ok(!sent.resume.includes('Sam') && !sent.resume.includes('@') && !sent.resume.includes('555'));
  assert.equal(sent.overall.reachedInterview, 1);
  assert.equal(sent.byVersion[0].tooFewToCompare, undefined);
  assert.equal(sent.byVersion[1].tooFewToCompare, true);
  assert.deepEqual(sent.skillsMissingFromResume[0].askedForBy, ['Data']);
  assert.deepEqual(sent.mainKindsOfRole, ['Data']);
});
