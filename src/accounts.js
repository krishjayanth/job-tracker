// One line per account for the owner's Developer page: whether it's working, never what's
// in it. Counts and dates only (how many applications, when it last synced); no
// companies, roles or email subjects, as the privacy policy promises.
export const EXPIRED = 'Google sign-in for Gmail expired or was revoked';

// What sorts this account's emails: their own Groq key, the server's, or the rules.
function sorting(user) {
  const info = user.groqInfo();
  if (info.source === 'own') return { by: 'groq', key: 'own', problem: info.problem };
  if (info.source === 'server') return { by: 'groq', key: 'server', problem: info.problem };
  return { by: 'rules', key: null, problem: null };
}

// user: a loaded User. joinedAt: from the registry. allowed: still on ALLOWED_EMAIL.
// errors / reports: counts of open ones from this account.
export function accountSummary(user, { joinedAt = null, allowed = true, errors = 0, reports = 0 } = {}) {
  const db = user.store.db;
  const connected = user.mailbox.connected();
  const gmail = connected ? 'connected' : db.lastSyncError === EXPIRED ? 'expired' : 'off';
  const progress = user.mailbox.progress;
  const summary = {
    id: user.id,
    email: user.email,
    owner: user.owner,
    joinedAt,
    lastSeenAt: db.lastSeenAt ?? null,
    allowed,
    gmail,
    setupDone: !user.needsSetup(),
    sorting: sorting(user),
    applications: db.applications.length,
    emails: db.applications.reduce((n, a) => n + a.events.filter(e => !e.manual).length, 0),
    toCheck: db.applications.filter(a => a.needsReview).length,
    lastSync: db.lastSync ?? null,
    lastSyncError: db.lastSyncError ?? null,
    busy: progress ? { mode: progress.mode, done: progress.done, total: progress.total } : null,
    errors,
    reports,
  };
  summary.attention = attentionFor(summary);
  return summary;
}

// Why this account might need you, most pressing first; empty when all's well.
export function attentionFor(a) {
  const why = [];
  if (!a.allowed) return why; // taken off the list: nothing to fix
  if (a.gmail === 'expired') why.push('Gmail sign-in expired');
  else if (a.lastSyncError) why.push('Last sync failed');
  if (a.sorting.problem === 'rejected') why.push('Groq key rejected');
  if (a.sorting.problem === 'unreadable') why.push('Groq key needs re-entering');
  if (a.gmail === 'connected' && !a.setupDone) why.push('Hasn’t finished setup');
  if (a.errors) why.push(`${a.errors} open error${a.errors === 1 ? '' : 's'}`);
  if (a.reports) why.push(`${a.reports} open report${a.reports === 1 ? '' : 's'}`);
  return why;
}

// How often to record that someone used nuj: once in a while is plenty for "last seen",
// and saves a write on every request.
export const SEEN_EVERY_MS = 5 * 60_000;
export function noteSeen(user, now = Date.now()) {
  const db = user.store.db;
  if (db.lastSeenAt && now - Date.parse(db.lastSeenAt) < SEEN_EVERY_MS) return false;
  db.lastSeenAt = new Date(now).toISOString();
  user.store.save();
  return true;
}
