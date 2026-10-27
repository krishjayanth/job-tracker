// One time, after an update to sorting: read everyone's emails again with it (the owner
// excepted, who re-scans when they like). One person at a time, like syncing, using the
// same re-scan as the Settings button: a backup first, and their edits kept. Progress is
// kept per person, so if the server sleeps part-way the rest happen on the next start,
// and anyone whose re-scan failed is tried again then.
import { getKv, setKv } from './store.js';
import { RESCAN_ID } from './releases.js';
import { recordError } from './errors.js';

// people: the accounts to consider. onUser(user): called after each attempt (to tell
// their open tabs). Returns { done, failed, finished }.
export async function rescanEveryoneOnce(people, { onUser = () => {}, log = console } = {}) {
  const record = (await getKv(RESCAN_ID)) || { done: [], startedAt: new Date().toISOString() };
  if (record.finishedAt) return { done: record.done.length, failed: 0, finished: true };
  let failed = 0;
  for (const user of people) {
    if (user.owner || record.done.includes(user.id)) continue;
    // No Gmail, or still choosing how to sort: their first sync uses the new sorting anyway.
    if (user.mailbox.connected() && !user.needsSetup()) {
      try {
        const r = await user.mailbox.rescan();
        user.store.db.rescanned = RESCAN_ID;
        user.store.save();
        log.log(`[rescan-all] ${user.id}: ${r.applications} applications, ${r.restored} with edits restored`);
      } catch (err) {
        log.error(`[rescan-all] ${user.id} failed: ${err.message}`);
        recordError('rescan', err, { userId: user.id, detail: 'The one-time re-read after a sorting update' });
        failed++;
        continue;
      } finally {
        onUser(user);
      }
    }
    record.done.push(user.id);
    await setKv(RESCAN_ID, record);
  }
  if (failed) {
    log.warn(`[rescan-all] ${failed} account(s) failed; they're tried again on the next start`);
    return { done: record.done.length, failed, finished: false };
  }
  record.finishedAt = new Date().toISOString();
  await setKv(RESCAN_ID, record);
  log.log(`[rescan-all] finished: ${record.done.length} accounts`);
  return { done: record.done.length, failed: 0, finished: true };
}

// The owner re-scanning one person's account (Reports → a problem report), after a fix
// to sorting that their report was about. The same re-scan as their Settings button.
// Returns { started, finished } (finished settles when it's done, for tests), or
// { status, error } when it can't run; nothing is read then.
export async function rescanAccount(user, { onDone = () => {}, log = console } = {}) {
  if (!user) return { status: 404, error: 'No account with that ID' };
  if (!user.mailbox.connected()) return { status: 400, error: "Their Gmail isn't connected" };
  if (user.needsSetup()) return { status: 400, error: "They haven't chosen how to sort their emails yet" };
  if (user.mailbox.isRescanning()) return { status: 409, error: 'Their emails are already being re-scanned' };
  log.log(`[rescan] ${user.id}: started by the owner`);
  const finished = user.mailbox.rescan()
    .then(r => log.log(`[rescan] ${user.id}: ${r.applications} applications, ${r.restored} with edits restored`))
    .catch(err => {
      log.error(`[rescan] ${user.id} failed: ${err.message}`);
      recordError('rescan', err, { userId: user.id, detail: 'Started by the owner' });
    })
    .finally(() => onDone(user));
  return { started: true, finished };
}
