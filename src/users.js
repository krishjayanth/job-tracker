// Everyone who uses this nuj, each with their own tracker, Gmail connection and Groq key.
// Users are keyed by Google's stable account id; running locally without sign-in
// there's one user, "local", and the demo has "demo".
import { getKv, setKv, deleteKv, openStore, closeStore } from './store.js';
import { Mailbox } from './gmail.js';
import { encrypt, decrypt } from './secrets.js';
import { groqClient, forgetClient, SERVER_KEY } from './groq.js';
import { ownerEmail } from './auth.js';

export const LOCAL_ID = 'local';
export const DEMO_ID = 'demo';
const REGISTRY = 'users'; // { [id]: { email, createdAt } }

const users = new Map(); // id -> Promise<User>

// The owner is whoever ran nuj before it had accounts: their old data moves to
// their account, and the server's own GROQ_API_KEY (if set) is used for them only.
const isOwner = (id, email) => id === LOCAL_ID || Boolean(email && email.toLowerCase() === ownerEmail());

// Load (once) and return a user, registering them the first time they sign in.
export function getUser(id, email = null) {
  if (!users.has(id)) users.set(id, loadUser(id, email).catch(err => { users.delete(id); throw err; }));
  return users.get(id);
}

// Everyone registered, loaded.
export async function allUsers() {
  const registry = (await getKv(REGISTRY)) || {};
  return Promise.all(Object.keys(registry).map(id => getUser(id)));
}

// Changes to the list of users, one at a time so two sign-ins can't overwrite each other.
let registryWrites = Promise.resolve();
function updateRegistry(change) {
  registryWrites = registryWrites.then(async () => {
    const registry = (await getKv(REGISTRY)) || {};
    change(registry);
    await setKv(REGISTRY, registry);
  });
  return registryWrites;
}

async function loadUser(id, email) {
  const known = ((await getKv(REGISTRY)) || {})[id];
  if (!known || (email && known.email !== email)) {
    await updateRegistry(r => { r[id] = { ...r[id], email, createdAt: r[id]?.createdAt ?? new Date().toISOString() }; });
  }
  email ??= known?.email ?? null;
  if (isOwner(id, email)) await adoptSingleUserData(id);
  const user = new User(id, email, await openStore(id), !known);
  await user.load();
  return user;
}

// Before accounts, there was one tracker ("db") and one Gmail sign-in ("gmail_token").
// They become the owner's, with a copy of the old tracker kept as a backup.
async function adoptSingleUserData(id) {
  const legacy = await getKv('db');
  if (!legacy || await getKv(`db_${id}`)) return;
  await setKv('db_before_accounts', legacy);
  await setKv(`db_${id}`, legacy);
  const token = await getKv('gmail_token');
  if (token) await setKv(`gmail_token_${id}`, token);
  await deleteKv('db');
  await deleteKv('gmail_token');
  console.log(`[users] moved the existing tracker (${legacy.applications?.length ?? 0} applications) to ${id}`);
}

// Delete everything kept for a user and cancel their Gmail access at Google.
export async function deleteUser(id) {
  const user = await getUser(id);
  await user.mailbox.stop();
  await user.mailbox.disconnect();
  if (user.apiKey) forgetClient(user.apiKey);
  const feed = user.store.db.calendarFeed;
  if (feed) await deleteKv(`calfeed_${feed.token}`);
  await closeStore(id);
  const keys = [`db_${id}`, `groq_key_${id}`, `db_before_rescan_${id}`];
  if (user.owner) keys.push('db_before_accounts', 'db_before_rescan'); // backups from before accounts
  for (const key of keys) await deleteKv(key);
  await updateRegistry(r => { delete r[id]; });
  users.delete(id);
}

export class User {
  constructor(id, email, store, isNew = false) {
    this.id = id;
    this.email = email;
    this.store = store;
    this.isNew = isNew;
    this.owner = isOwner(id, email);
    this.mailbox = new Mailbox(this);
    this.keyRecord = null; // { sealed, last4, savedAt, rejected? }
    this.apiKey = null;    // the decrypted Groq key, in memory only
    this.serverKeyRejected = false;
  }

  get keyName() { return `groq_key_${this.id}`; }

  async load() {
    await this.mailbox.load();
    this.keyRecord = await getKv(this.keyName);
    this.apiKey = this.keyRecord ? decrypt(this.keyRecord.sealed) : null;
    return this;
  }

  // Someone new picks how their emails are read (a Groq key or the built-in rules)
  // before anything is synced. Anyone who has synced before already made that choice.
  needsSetup() {
    const db = this.store.db;
    return !db.setupDone && !db.lastSync && !Object.keys(db.processed || {}).length;
  }

  finishSetup() {
    this.store.db.setupDone = true;
    this.store.save();
  }

  // The Groq client to classify this user's emails with, or null for the rules.
  groq() {
    if (this.apiKey && !this.keyRecord.rejected) return groqClient(this.apiKey);
    if (!this.keyRecord && this.owner && SERVER_KEY && !this.serverKeyRejected) return groqClient(SERVER_KEY);
    return null;
  }

  // What the settings show; never the key itself.
  groqInfo() {
    if (this.keyRecord) {
      return {
        source: 'own', last4: this.keyRecord.last4,
        // Unreadable means SESSION_SECRET changed since the key was saved.
        problem: !this.apiKey ? 'unreadable' : this.keyRecord.rejected ? 'rejected' : null,
      };
    }
    if (this.owner && SERVER_KEY) return { source: 'server', problem: this.serverKeyRejected ? 'rejected' : null };
    return { source: null, problem: null };
  }

  // Groq refused the key mid-sync: stop using it and tell the user.
  keyRejected() {
    if (this.apiKey && !this.keyRecord.rejected) {
      this.keyRecord = { ...this.keyRecord, rejected: true };
      setKv(this.keyName, this.keyRecord).catch(err => console.error(`[users] saving key state failed: ${err.message}`));
      console.warn(`[groq] key for ${this.id} was rejected; using rules until it's replaced`);
    } else if (!this.apiKey && !this.serverKeyRejected) {
      this.serverKeyRejected = true;
      console.warn('[groq] GROQ_API_KEY was rejected; using rules');
    }
  }

  async setGroqKey(apiKey) {
    if (this.apiKey) forgetClient(this.apiKey);
    this.apiKey = apiKey;
    this.keyRecord = { sealed: encrypt(apiKey), last4: apiKey.slice(-4), savedAt: new Date().toISOString() };
    await setKv(this.keyName, this.keyRecord);
  }

  async removeGroqKey() {
    if (this.apiKey) forgetClient(this.apiKey);
    this.apiKey = null;
    this.keyRecord = null;
    await deleteKv(this.keyName);
  }
}
