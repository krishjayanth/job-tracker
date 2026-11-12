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


const resume = '[Name]\n[Contact details]\nExperience\n• Responsible for the sign-up page\n• Cut load time by 40% across 3 pages\nSkills\nReact, Kubernetes, Figma';
const reviewOut = (extra = {}) => ({
  score: 64,
  skim: 'Clean layout; loses momentum in Experience.',
  rubric: [
    { id: 'xyz', score: 4, note: 'Half the bullets are duties.' },
    { id: 'numbers', score: 5, note: 'One figure.' },
    { id: 'skills', score: 3, note: 'Kubernetes is never used.' },
    { id: 'ownership', score: 12, note: 'Scores past 10 are capped.' },
    { id: 'clarity', score: 7, note: '' },
    { id: 'charisma', score: 9, note: 'Not a rubric item.' },
  ],
  bullets: [
    { line: 'Responsible for the sign-up page', missing: ['X', 'Y', 'Q'], note: 'Missing X: a duty, not an outcome', rewrite: 'Raised sign-ups by [X%] by rebuilding the sign-up page' },
    { line: 'responsible for the sign-up page', missing: ['Y'], note: 'Same bullet again', rewrite: 'x' },
    { line: 'Led a team of 40 engineers', missing: ['Y'], note: 'Not in the resume', rewrite: 'y' },
    { line: 'Cut load time by 40% across 3 pages', missing: ['Z'], note: 'Missing Z', rewrite: 'Cut load time by 40% across 3 pages for 10,000 users by caching' },
  ],
  unprovenSkills: ['Kubernetes', 'Rust'],
  biggestWeakness: 'Duties, not results.',
  fromApplications: [{ title: 'Lead with projects', why: 'Interviews came from project-heavy roles', change: 'Move Projects up' }],
  ...extra,
});

test('a review keeps what holds up: known rubric items, real bullets, honest rewrites, listed skills', () => {
  const rv = ai.checkReview(reviewOut(), { resume, overall: { applications: 4 } });
  assert.equal(rv.score, 64);
  assert.equal(rv.grade, 'D'); // from the score, so the two agree
  assert.deepEqual(rv.rubric.map(r => r.id), ['xyz', 'numbers', 'skills', 'ownership', 'clarity']);
  assert.equal(rv.rubric.find(r => r.id === 'ownership').score, 10);
  assert.equal(rv.bullets.length, 2); // the repeat and the made-up line are dropped
  assert.deepEqual(rv.bullets[0].missing, ['X', 'Y']);
  assert.match(rv.bullets[0].rewrite, /\[X%\]/); // a placeholder is fine
  assert.equal(rv.bullets[1].rewrite, ''); // "10,000 users" was made up
  assert.ok(rv.bullets.every(b => b.id && b.state === 'open'));
  assert.deepEqual(rv.unprovenSkills, ['Kubernetes']); // Rust isn't on the resume at all
  assert.equal(rv.fromApplications.length, 1);
  assert.equal(ai.checkReview(reviewOut(), { resume, overall: { applications: 0 } }).fromApplications.length, 0);
  assert.equal(ai.checkReview({ ...reviewOut(), score: 'great' }, { resume }), null);
});

test('letter grades follow the score', () => {
  assert.deepEqual([98, 93, 90, 85, 72, 61, 40].map(ai.letterGrade), ['A+', 'A', 'A-', 'B', 'C-', 'D-', 'F']);
});

test('a review comes back from the model, and a cut-off or incomplete one is a plain error', async () => {
  const input = { resume, overall: { applications: 0 } };
  const rv = await ai.writeReview(input, { client: fakeClient(reviewOut()) });
  assert.equal(rv.grade, 'D');
  assert.equal(fakeClient.last.response_format.json_schema.strict, true);
  assert.ok(fakeClient.last.max_completion_tokens > 4096, 'a full review needs room');
  assert.match(fakeClient.last.messages[0].content, /XYZ/);
  await assert.rejects(ai.writeReview(input, { client: fakeClient(reviewOut(), { finish: 'length' }) }), /couldn't finish/);
  await assert.rejects(ai.writeReview(input, { client: fakeClient(reviewOut(), { fail: 429 }) }), /busy/);
  await assert.rejects(ai.writeReview(input, { client: fakeClient(reviewOut({ rubric: [] })) }), /complete/);
});

test('tailoring keeps keywords from the posting, real bullets, sections the resume has, and no made-up numbers', () => {
  const resumeText = 'Experience\n• Built a REST API used by 1,200 people\n• Fixed bugs\nSKILLS\nReact';
  const posting = 'You will build REST APIs in Node.js with GraphQL. Experience with Kubernetes and Terraform is a plus. Agile teams.';
  const fit = ai.checkFit({
    score: 140, summary: 'Close.',
    matched: ['REST APIs', 'Python'],
    missingKeywords: ['Kubernetes', 'Node.js', 'GraphQL', 'Terraform', 'Agile', 'Rust'],
    redFlags: ['No metrics on half the bullets', 'No cloud work', 'Generic skills line', 'A fourth'],
    rewrites: [
      { from: 'Built a REST API used by 1,200 people', to: 'Built a Node.js REST API used by 1,200 people', why: 'Names Node.js' },
      { from: 'Fixed bugs', to: 'Fixed 30 bugs', why: 'Made up' },
      { from: 'Led a team of 40 engineers', to: 'Led a team', why: 'Not a line' },
    ],
    skipped: [
      { section: 'Skills', why: 'A bare list', rewrite: 'Languages: React\nTools: [N] more' },
      { section: 'Awards', why: 'There is no such section', rewrite: 'x' },
    ],
  }, { resumeText, posting });
  assert.equal(fit.score, 100);
  assert.equal(fit.match, 'strong');
  assert.deepEqual(fit.matched, ['REST APIs']);
  assert.deepEqual(fit.missingKeywords, ['Kubernetes', 'Node.js', 'GraphQL', 'Terraform', 'Agile']);
  assert.equal(fit.redFlags.length, 3);
  assert.deepEqual(fit.rewrites.map(r => r.from), ['Built a REST API used by 1,200 people']);
  assert.deepEqual(fit.skipped.map(x => x.section), ['Skills']);
  assert.equal(ai.matchOf(60), 'partial');
  assert.equal(ai.matchOf(20), 'weak');
});

test('tailoring tells the model the company and role, but not your name', async () => {
  await ai.checkApplicationFit({ resumeText: 'Sam Example\nsam@example.com\nExperience\n• Built things', posting: 'React', role: 'Frontend Intern', company: 'Contoso' },
    { client: fakeClient({ score: 50, summary: '', matched: [], missingKeywords: [], redFlags: [], rewrites: [], skipped: [] }) });
  const sent = JSON.parse(fakeClient.last.messages[1].content);
  assert.equal(sent.company, 'Contoso');
  assert.equal(sent.role, 'Frontend Intern');
  assert.ok(!sent.resume.includes('Sam') && !sent.resume.includes('@'));
});

test('demo answers pass the same checks', () => {
  const text = 'Sam\nsam@example.com\nExperience\n• Helped with the website\n• Built a REST API in Node.js used by 1,200 people\nSkills\nReact, Node.js, Kubernetes';
  const rv = ai.demoReview({ resume: text, overall: { applications: 3, finished: 2, reachedInterview: 1 } });
  assert.ok(rv.score >= 1 && rv.score <= 100);
  assert.equal(rv.rubric.length, 5);
  assert.ok(rv.bullets.some(b => b.line === 'Helped with the website'));
  assert.ok(rv.unprovenSkills.includes('Kubernetes'));
  const fit = ai.demoFit({ resumeText: text, posting: 'We want React, Node.js and Terraform experience.' });
  assert.deepEqual(fit.missingKeywords, ['Terraform']);
  assert.equal(fit.redFlags.length, 3);
});

test('a rewrite that adds a number the line did not have counts as made up', () => {
  assert.equal(ai.addsNumbers('Built the sign-up page', 'Built the sign-up page, raising sign-ups by 40%'), true);
  assert.equal(ai.addsNumbers('Cut load time by 40% across 3 pages', 'Across 3 pages, cut load time by 40%'), false);
  assert.equal(ai.addsNumbers('Built the sign-up page', 'Built the sign-up page, raising sign-ups by [X%]'), false);
});

test('the review is told how applications went and the job descriptions you pasted, never your name', () => {
  const group = (key, counted) => ({ key, name: key, total: counted, counted, forward: 1, interviews: 1 });
  const sent = ai.reviewInput({
    resumeText: 'Sam Example\nsam@example.com · 555-123-4567\nExperience\n• Built things',
    versionName: 'v1',
    apps: [
      { role: 'Data Analyst', outcome: 'forward', version: 'v1', posting: `SQL and Tableau. ${'More. '.repeat(400)}` },
      { role: 'Data Engineer', outcome: 'stalled', version: 'v1', posting: '' },
    ],
    insights: { total: 8, counted: 8, forward: 3, interviews: 1, mainKinds: ['Data'], byVersion: [group('v1', 6), group('v0', 2)], byFunction: [], byLevel: [] },
  });
  assert.ok(!sent.resume.includes('Sam') && !sent.resume.includes('@') && !sent.resume.includes('555'));
  assert.equal(sent.overall.reachedInterview, 1);
  assert.equal(sent.byVersion[1].tooFewToCompare, true);
  assert.equal(sent.jobDescriptions.length, 1);
  assert.ok(sent.jobDescriptions[0].text.length <= 1500);
  assert.ok(!('posting' in sent.applications[0]));
  assert.ok(!('skillsMissingFromResume' in sent) && !('checksThatFailed' in sent), 'nuj no longer judges skills or checks itself');
});

test('agreeing to an older list of what is sent asks again', () => {
  const friend = person('consent');
  friend.store.db.insights = { consent: { at: '2026-10-01T00:00:00Z' } }; // before the job descriptions were sent
  assert.equal(ai.aiStatus(friend).consent, false);
  friend.store.db.insights.consent.version = ai.CONSENT_VERSION;
  assert.equal(ai.aiStatus(friend).consent, true);
});
