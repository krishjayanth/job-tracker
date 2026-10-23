// Encryption for secrets kept with someone's data (their Groq API key), so a copy of
// the database alone doesn't hand them out. AES-256-GCM, keyed from SESSION_SECRET;
// without one (running locally), from a random key stored next to the data.
// Changing SESSION_SECRET makes stored keys unreadable: people are asked to add them again.
import crypto from 'node:crypto';
import { getKv, setKv } from './store.js';

let key = null;

export async function initSecrets() {
  let secret = process.env.SESSION_SECRET || '';
  if (secret.length < 32) {
    secret = await getKv('local_secret');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('base64url');
      await setKv('local_secret', secret);
    }
  }
  key = crypto.createHash('sha256').update(`nuj stored secrets\0${secret}`).digest();
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
}

// The original text, or null if it was encrypted with a different key or tampered with.
export function decrypt(sealed) {
  try {
    const [iv, tag, data] = String(sealed).split('.').map(s => Buffer.from(s, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
