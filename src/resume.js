// Resumes for Resume insights: reading the text out of an uploaded PDF or Word file, and
// keeping each person's versions. Only the text is kept, never the file. Versions live
// under their own key (resumes_<user id>) rather than in the tracker, so the long text
// isn't sent with every page update.
import crypto from 'node:crypto';
import { getKv, setKv, deleteKv } from './store.js';

export const MAX_VERSIONS = 5;
export const MAX_TEXT = 40_000;
const MIN_TEXT = 80; // less than this from a PDF means it's a scan, or text nuj can't read

const key = userId => `resumes_${userId}`;

// ---- reading an upload ------------------------------------------------------------

// Tidy text pulled from a file or pasted in: one kind of bullet, no runs of spaces or
// blank lines, nothing past MAX_TEXT.
export function cleanText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/^[ \t]*[•●▪◦‣■□][ \t]*/gm, '• ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// What kind of file this is, from its first bytes rather than its name.
export function fileKind(buffer) {
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'docx'; // a zip, which a .docx is
  return null;
}

// Returns { text } or { error } (shown to the person, so in plain words).
export async function extractText(buffer) {
  const kind = fileKind(buffer);
  if (!kind) return { error: 'nuj can read PDF and Word (.docx) files. Save your resume as one of those, or paste the text.' };
  let text;
  try {
    if (kind === 'pdf') {
      const { getDocumentProxy, extractText: pdfText } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      text = (await pdfText(pdf, { mergePages: true })).text;
    } else {
      const { default: mammoth } = await import('mammoth');
      text = (await mammoth.extractRawText({ buffer })).value;
    }
  } catch {
    return { error: `nuj couldn't open that ${kind === 'pdf' ? 'PDF' : 'Word file'}. Try saving it again, or paste the text.` };
  }
  text = cleanText(text);
  if (text.length < MIN_TEXT) {
    return { error: kind === 'pdf'
      ? 'This PDF has no text nuj can read, which usually means it was scanned. Try a Word file or paste the text.'
      : 'This file has no text in it. Try another file or paste the text.' };
  }
  return { text: text.slice(0, MAX_TEXT), kind, cut: text.length > MAX_TEXT };
}

// ---- versions -----------------------------------------------------------------------
const cache = new Map(); // user id -> versions, so each page update doesn't read storage
const chains = new Map(); // user id -> the last change, so changes happen one at a time

export async function listVersions(userId) {
  if (!cache.has(userId)) cache.set(userId, (await getKv(key(userId))) ?? []);
  return cache.get(userId);
}

function update(userId, fn) {
  const run = (chains.get(userId) ?? Promise.resolve()).then(async () => {
    const versions = structuredClone(await listVersions(userId));
    const result = fn(versions);
    if (result.error) return result;
    versions.sort((a, b) => a.usedFrom.localeCompare(b.usedFrom) || a.createdAt.localeCompare(b.createdAt));
    await setKv(key(userId), versions);
    cache.set(userId, versions);
    return result;
  });
  chains.set(userId, run.catch(() => {}));
  return run;
}

const today = () => new Date().toISOString().slice(0, 10);
const validDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
// Bullets on their own don't count as words.
export const countWords = text => (text.match(/\S*[\p{L}\p{N}]\S*/gu) || []).length;

// The parts of a version you can set, checked. Returns { fields } or { error }.
function checkFields({ name, usedFrom, text }, { partial = false } = {}) {
  const fields = {};
  if (name !== undefined || !partial) {
    fields.name = String(name ?? '').trim().slice(0, 60) || `Resume, ${new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
  }
  if (usedFrom !== undefined || !partial) {
    if (usedFrom && !validDay(usedFrom)) return { error: 'Pick the date you started sending this version' };
    fields.usedFrom = usedFrom || today();
  }
  if (text !== undefined || !partial) {
    const clean = cleanText(text);
    if (!clean) return { error: 'Add the text of your resume' };
    if (clean.length > MAX_TEXT) return { error: `That's longer than a resume usually is. Keep it under ${MAX_TEXT.toLocaleString('en-US')} characters` };
    fields.text = clean;
    fields.words = countWords(clean);
  }
  return { fields };
}

// `id` is only given when putting back a version you just deleted (Undo).
export function addVersion(userId, body) {
  const { fields, error } = checkFields(body);
  if (error) return Promise.resolve({ error });
  return update(userId, versions => {
    if (versions.length >= MAX_VERSIONS) return { error: `You can keep up to ${MAX_VERSIONS} versions. Delete one to add another` };
    const id = typeof body.id === 'string' && /^[\w-]{8,64}$/.test(body.id) && !versions.some(v => v.id === body.id) ? body.id : crypto.randomUUID();
    const now = new Date().toISOString();
    const version = { id, ...fields, createdAt: body.createdAt && !Number.isNaN(Date.parse(body.createdAt)) ? body.createdAt : now, updatedAt: now };
    versions.push(version);
    return { version };
  });
}

export function updateVersion(userId, id, body) {
  const { fields, error } = checkFields(body, { partial: true });
  if (error) return Promise.resolve({ error });
  return update(userId, versions => {
    const version = versions.find(v => v.id === id);
    if (!version) return { error: 'That version was deleted', status: 404 };
    Object.assign(version, fields, { updatedAt: new Date().toISOString() });
    return { version };
  });
}

export function deleteVersion(userId, id) {
  return update(userId, versions => {
    const i = versions.findIndex(v => v.id === id);
    if (i < 0) return { error: 'That version was already deleted', status: 404 };
    const [removed] = versions.splice(i, 1);
    return { removed };
  });
}

// For an account being deleted.
export async function forgetResumes(userId) {
  await chains.get(userId);
  cache.delete(userId);
  chains.delete(userId);
  await deleteKv(key(userId));
}

// What the page lists: everything but the text.
export const versionMeta = ({ text, ...meta }) => meta;

// ---- which version an application was sent with ---------------------------------------
// The one you picked for it; otherwise the latest version you'd started using by the day
// you applied; otherwise (applied before your first version) the earliest.
// `versions` are sorted by usedFrom, as stored.
export function versionFor(app, versions) {
  if (!versions.length) return null;
  if (app.resumeId) {
    const picked = versions.find(v => v.id === app.resumeId);
    if (picked) return picked;
  }
  const day = String(app.appliedAt ?? app.createdAt ?? '').slice(0, 10);
  return versions.filter(v => v.usedFrom <= day).at(-1) ?? versions[0];
}

// The version you're sending now: the one with the latest start date.
export const currentVersion = versions => versions.at(-1) ?? null;
