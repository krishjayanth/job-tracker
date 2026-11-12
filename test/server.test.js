import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// The routes, against the real server in demo mode (sample data in memory, no sign-in).
// Each run uses its own port, so it can't collide with a server you have open.
const PORT = 5600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  server = spawn(process.execPath, ['server.js', '--demo'], {
    env: { ...process.env, PORT: String(PORT), ALLOWED_EMAIL: '', RENDER: '', DATABASE_URL: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 200; i++) { // up to 20 seconds: slower while every suite runs at once
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('the demo server did not start');
});
after(() => server?.kill());

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const firstApp = async () => (await call('GET', '/api/state')).body.applications[0];

test('the state has the demo applications, each with its chart path', async () => {
  const { status, body } = await call('GET', '/api/state');
  assert.equal(status, 200);
  assert.ok(body.applications.length >= 30);
  assert.ok(body.applications.every(a => Array.isArray(a.path) && a.path[0] === 'applied'));
});

test('adding an application checks what it was sent', async () => {
  assert.equal((await call('POST', '/api/applications', {})).status, 400);
  assert.equal((await call('POST', '/api/applications', { company: { x: 1 } })).status, 400);
  assert.equal((await call('POST', '/api/applications', { company: 'Acme', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await call('POST', '/api/applications', { company: 'Acme', status: 'hired' })).status, 400);
  const ok = await call('POST', '/api/applications', { company: '  Acme  ', role: 'Intern', status: 'interview' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.company, 'Acme');
  assert.equal(ok.body.status, 'interview');
});

test('a bad field changes nothing, even alongside good ones', async () => {
  const a = await firstApp();
  const r = await call('PATCH', `/api/applications/${a.id}`, { role: 'Changed role', interviewAt: 'next tuesday' });
  assert.equal(r.status, 400);
  assert.equal((await firstApp()).role, a.role);
  assert.equal((await call('PATCH', `/api/applications/${a.id}`, { company: '' })).status, 400);
  assert.equal((await call('PATCH', `/api/applications/${a.id}`, { notes: 'x'.repeat(10_001) })).status, 400);
  assert.equal((await call('PATCH', `/api/applications/${a.id}`, { status: 'nope' })).status, 400);
});

test('an edit saves, and an empty request body is fine', async () => {
  const a = await firstApp();
  const r = await call('PATCH', `/api/applications/${a.id}`, { notes: 'Recruiter: Pat', url: 'https://jobs.example.com/1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.notes, 'Recruiter: Pat');
  const res = await fetch(`${BASE}/api/applications/${a.id}`, { method: 'PATCH' });
  assert.equal(res.status, 200);
});

test('deleting several at once is put back by one Undo', async () => {
  const { body } = await call('GET', '/api/state');
  const ids = body.applications.slice(0, 3).map(a => a.id);
  const del = await call('POST', '/api/applications/bulk', { action: 'delete', ids });
  assert.equal(del.status, 200);
  assert.equal(del.body.count, 3);
  const gone = (await call('GET', '/api/state')).body.applications;
  assert.ok(!gone.some(a => ids.includes(a.id)));
  assert.equal((await call('POST', `/api/undo/${del.body.undo}`)).status, 200);
  const back = (await call('GET', '/api/state')).body.applications;
  assert.ok(ids.every(id => back.some(a => a.id === id)));
  assert.equal((await call('POST', `/api/undo/${del.body.undo}`)).status, 410); // once only
});

test('bulk actions refuse what they do not know', async () => {
  assert.equal((await call('POST', '/api/applications/bulk', { action: 'delete', ids: [] })).status, 400);
  const a = await firstApp();
  assert.equal((await call('POST', '/api/applications/bulk', { action: 'explode', ids: [a.id] })).status, 400);
  assert.equal((await call('POST', '/api/applications/bulk', { action: 'status', status: 'hired', ids: [a.id] })).status, 400);
});

test('moving an email with odd fields is refused plainly, not a crash', async () => {
  const r = await call('POST', '/api/emails/no-such-email/assign', { action: 'new', company: 3 });
  assert.equal(r.status, 404);
});

test('a suggested rewrite goes into the version text, keeping its bullet, and Undo puts it back', async () => {
  const { body: page } = await call('GET', '/api/resume');
  const id = page.preview.versionId;
  const line = page.preview.lines.find(l => l.kind === 'bullet');
  const from = line.text.slice(line.at);
  const done = await call('POST', `/api/resume/${id}/rewrite`, { from, to: 'Rewritten by a test' });
  assert.equal(done.status, 200);
  const text = (await call('GET', `/api/resume/${id}`)).body.text;
  assert.ok(text.includes(`${line.text.slice(0, line.at)}Rewritten by a test`));
  assert.equal((await call('POST', `/api/resume/${id}/rewrite`, { from: 'A line that was never there at all', to: 'x' })).status, 400);
  assert.equal((await call('POST', `/api/resume/${id}/rewrite`, { from, to: 'two\nlines' })).status, 400);
  await call('PATCH', `/api/resume/${id}`, { text: done.body.before });
  assert.equal((await call('GET', `/api/resume/${id}`)).body.text, done.body.before);
});

test('a job can be checked from the Resume page, and the answer is kept', async () => {
  await call('POST', '/api/insights/consent', { allow: true });
  assert.equal((await call('POST', '/api/insights/fit', { posting: 'too short' })).status, 400);
  const posting = 'We are hiring an intern who knows React, TypeScript and Kubernetes to build our web app.';
  const { status, body } = await call('POST', '/api/insights/fit', { posting });
  assert.equal(status, 200);
  assert.ok(['strong', 'partial', 'weak'].includes(body.jobFit.match));
  assert.ok(Number.isInteger(body.jobFit.score));
  assert.equal(body.jobFit.redFlags.length, 3);
  assert.equal((await call('POST', '/api/insights/fit', { posting })).body.cached, true);
  assert.equal((await call('GET', '/api/resume')).body.jobFit.posting, posting);
  await call('DELETE', '/api/insights/fit');
  assert.equal((await call('GET', '/api/resume')).body.jobFit, null);
});

test('deleting a version says where its applications go', async () => {
  const { body: page } = await call('GET', '/api/resume');
  const oldest = page.versions[0];
  const { status, body } = await call('DELETE', `/api/resume/${oldest.id}`);
  assert.equal(status, 200);
  assert.ok(body.moved.count > 0);
  assert.ok(page.versions.some(v => v.name === body.moved.to));
  await call('POST', '/api/resume', body.removed); // Undo
  assert.equal((await call('GET', '/api/resume')).body.versions.length, page.versions.length);
});

test('the AI grades the resume, keeps the review, and marks its bullets done or skipped', async () => {
  await call('POST', '/api/insights/consent', { allow: true });
  const first = await call('POST', '/api/insights/review');
  assert.equal(first.status, 200);
  const { body: page } = await call('GET', '/api/resume');
  const rv = page.review;
  assert.ok(rv.score >= 1 && rv.score <= 100 && /^[A-F][+-]?$/.test(rv.grade));
  assert.equal(rv.rubric.length, 5);
  assert.equal(rv.upToDate, true);
  assert.ok(rv.bullets.length && rv.bullets.every(b => b.at >= 0), 'each graded bullet is found in the resume');
  assert.ok(!('inputHash' in rv));
  assert.equal((await call('POST', '/api/insights/review')).body.cached, true); // nothing changed: no run used
  const id = rv.bullets[0].id;
  assert.equal((await call('PATCH', `/api/insights/review/items/${id}`, { state: 'done' })).status, 200);
  assert.equal((await call('GET', '/api/resume')).body.review.bullets[0].state, 'done');
  assert.equal((await call('PATCH', `/api/insights/review/items/${id}`, { state: 'maybe' })).status, 400);
  assert.equal((await call('PATCH', '/api/insights/review/items/nope', { state: 'done' })).status, 404);
});

test('the live-update stream starts with a fingerprint of the dashboard, the same on every connection', async () => {
  const first = async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${BASE}/api/events`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    ctrl.abort();
    return new TextDecoder().decode(value);
  };
  const [a, b] = [await first(), await first()];
  assert.match(a, /^event: build\ndata: [0-9a-f]{12}\n\n/);
  assert.equal(a, b);
});
