import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// auth.js reads its settings at import time, so set them first.
process.env.ALLOWED_EMAIL = 'me@example.com';
process.env.SESSION_SECRET = 'x'.repeat(40);
let auth;
before(async () => { auth = await import('../src/auth.js'); });

// Just enough of Express's req/res for the session helpers.
function signIn(email) {
  let cookie;
  auth.startSession({ cookie: (name, value) => { cookie = `${name}=${encodeURIComponent(value)}`; } }, { sub: `id-${email}`, email });
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

test('a signed session cookie lets you in, as your own account', () => {
  const r = request('/api/state', signIn('me@example.com'));
  assert.equal(r.next, true);
  assert.deepEqual(r.user, { id: 'id-me@example.com', email: 'me@example.com' });
});

test('a session from before accounts (no account id) must sign in again', () => {
  const payload = Buffer.from(JSON.stringify({ email: 'me@example.com', exp: Date.now() + 1e9 })).toString('base64url');
  const mac = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  assert.equal(request('/api/state', `nuj_session=${encodeURIComponent(`${payload}.${mac}`)}`).status, 401);
});

test('without a session, home goes to the landing page, other pages to /login, and the API returns 401', () => {
  assert.equal(request('/').redirect, '/welcome');
  assert.equal(request('/index.html').redirect, '/login');
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
