import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// auth.js reads its settings at import time, so set them first.
process.env.ALLOWED_EMAIL = 'me@example.com';
process.env.SESSION_SECRET = 'x'.repeat(40);
let auth;
before(async () => { auth = await import('../src/auth.js'); });

// Just enough of Express's req/res for the session helpers.
function signIn(email) {
  let cookie;
  auth.startSession({ cookie: (name, value) => { cookie = `${name}=${encodeURIComponent(value)}`; } }, email);
  return cookie;
}
function request(path, cookie) {
  const req = { path, headers: cookie ? { cookie } : {} };
  const out = { next: false };
  const res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; },
    redirect(to) { out.redirect = to; },
  };
  auth.requireLogin(req, res, () => { out.next = true; });
  return { ...out, user: req.user };
}

test('a signed session cookie lets you in', () => {
  const r = request('/api/state', signIn('me@example.com'));
  assert.equal(r.next, true);
  assert.equal(r.user.email, 'me@example.com');
});

test('without a session, pages redirect to /login and the API returns 401', () => {
  assert.equal(request('/').redirect, '/login');
  assert.equal(request('/api/state').status, 401);
});

test('a tampered cookie is rejected', () => {
  const cookie = signIn('me@example.com');
  const [name, value] = cookie.split('=');
  const [, mac] = decodeURIComponent(value).split('.');
  const forged = Buffer.from(JSON.stringify({ email: 'me@example.com', exp: Date.now() + 1e12 })).toString('base64url');
  assert.equal(request('/api/state', `${name}=${encodeURIComponent(`${forged}.${mac}`)}`).status, 401);
});

test('a session for an email that is not allowed is rejected', () => {
  assert.equal(request('/api/state', signIn('someone@example.com')).status, 401);
});

test('isAllowed ignores case', () => {
  assert.equal(auth.isAllowed('Me@Example.com'), true);
  assert.equal(auth.isAllowed('other@example.com'), false);
});
