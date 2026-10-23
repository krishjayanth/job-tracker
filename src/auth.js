// "Sign in with Google", limited to the email(s) in ALLOWED_EMAIL; each of them gets
// their own tracker. The session is a signed cookie (HMAC with SESSION_SECRET), so
// there's nothing extra to store.
import crypto from 'node:crypto';

const COOKIE = 'nuj_session';
const MAX_AGE_DAYS = 30;
const ALLOWED = (process.env.ALLOWED_EMAIL || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SECRET = process.env.SESSION_SECRET || '';
const SECURE = Boolean(process.env.RENDER) || (process.env.PUBLIC_URL || '').startsWith('https://');

// Sign-in is required whenever ALLOWED_EMAIL is set. Hosted without it (on Render),
// the server refuses to start rather than expose your inbox data.
export const authEnabled = ALLOWED.length > 0;

export function checkAuthConfig() {
  if (process.env.RENDER && !authEnabled) {
    throw new Error('ALLOWED_EMAIL must be set when hosted; refusing to start without a login');
  }
  if (authEnabled && SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters');
  }
}

export const isAllowed = email => ALLOWED.includes(String(email).toLowerCase());
// The first allowed email is the owner: the person who used nuj before it had accounts.
export const ownerEmail = () => ALLOWED[0] ?? null;

const sign = value => crypto.createHmac('sha256', SECRET).update(value).digest('base64url');

function readSession(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [payload, mac] = decodeURIComponent(raw).split('.');
  if (!payload || !mac) return null;
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const { sub, email, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  // Sessions from before accounts carry no account id; those sign in again.
  if (!sub || Date.now() > exp || !isAllowed(email)) return null;
  return { id: sub, email };
}

// `sub` is Google's stable id for the account; it's what a user's data is kept under.
export function startSession(res, { sub, email }) {
  const payload = Buffer.from(JSON.stringify({ sub, email, exp: Date.now() + MAX_AGE_DAYS * 86_400_000 })).toString('base64url');
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true, secure: SECURE, sameSite: 'lax', maxAge: MAX_AGE_DAYS * 86_400_000, path: '/',
  });
}

export function endSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

// Express middleware: let signed-in requests through; send everyone else to the
// landing page (home), /login (other pages) or a 401 (API calls).
export function requireLogin(req, res, next) {
  if (!authEnabled) return next();
  const session = readSession(req);
  if (session) {
    req.user = session;
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required' });
  res.redirect(req.path === '/' ? '/welcome' : '/login');
}
