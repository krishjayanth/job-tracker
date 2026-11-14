// Resumes for Resume insights: reading the text out of an uploaded PDF or Word file, and
// keeping each person's versions. Versions live under their own key (resumes_<user id>)
// rather than in the tracker, so the long text isn't sent with every page update. A PDF is
// also kept, as a file under resume_pdf_<user id>_<version id>, so the page can show the
// real thing; a Word file never is (there'd be nothing to show it with). PDFs saved before
// files were kept as files are base64 text under the same key, moved over when next read.
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { getKv, setKv, deleteKv, deleteKvPrefix, listKvKeys, getFile, setFile, deleteFile, deleteFilePrefix, listFileKeys } from './store.js';
import { BULLET, bodyOf, carryOnCount } from './lines.js';

export const MAX_VERSIONS = 5;
export const MAX_TEXT = 40_000;
const MIN_TEXT = 80; // less than this from a PDF means it's a scan, or text nuj can't read

const key = userId => `resumes_${userId}`;
const pdfKey = (userId, versionId) => `resume_pdf_${userId}_${versionId}`;

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

// Reading happens in its own thread with a time and memory limit (see extract-worker.js).
// Resolves to the text, null if the file couldn't be read, or TIMED_OUT.
export const READ_LIMIT_MS = 20_000;
const TIMED_OUT = Symbol('timed out');
function readInWorker(kind, buffer, ms = READ_LIMIT_MS) {
  return new Promise(resolve => {
    const worker = new Worker(new URL('./extract-worker.js', import.meta.url), {
      workerData: { kind, bytes: new Uint8Array(buffer) },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish(TIMED_OUT), ms);
    worker.once('message', m => finish(m.failed ? null : m.text));
    worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));
  });
}

// Returns { text } or { error } (shown to the person, so in plain words).
export async function extractText(buffer, { limitMs = READ_LIMIT_MS } = {}) {
  const kind = fileKind(buffer);
  if (!kind) return { error: 'nuj can read PDF and Word (.docx) files. Save your resume as one of those, or paste the text.' };
  let text = await readInWorker(kind, buffer, limitMs);
  if (text === TIMED_OUT) return { error: `That ${kind === 'pdf' ? 'PDF' : 'Word file'} took too long to read. Try saving it again, or paste the text.` };
  if (text == null) return { error: `nuj couldn't open that ${kind === 'pdf' ? 'PDF' : 'Word file'}. Try saving it again, or paste the text.` };
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
  if (!cache.has(userId)) {
    const versions = (await getKv(key(userId))) ?? [];
    if (!cache.has(userId)) {
      // Rewrites accepted before wrapped bullets were understood are put right as they're
      // read (see repairWrappedEdits); doing it again changes nothing, so two first reads at
      // once can't disagree.
      if (versions.map(repairWrappedEdits).some(Boolean)) await setKv(key(userId), versions);
      cache.set(userId, versions);
      dropOrphanPdfs(userId, versions).catch(() => {});
    }
  }
  return cache.get(userId);
}

// Let go of an idle account's versions (with its tracker, see releaseIdleUsers). They're
// read back from storage the next time they're needed. Kept while a change is under way.
export function releaseResumes(userId) {
  if (chains.has(userId)) return;
  cache.delete(userId);
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
  const settled = run.catch(() => {}).then(() => { if (chains.get(userId) === settled) chains.delete(userId); });
  chains.set(userId, settled);
  return run;
}

const today = () => new Date().toISOString().slice(0, 10);
const textHash = text => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
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
    // Undo: its PDF is kept for a while after a delete (see dropPdfLater), so it comes back too.
    if (id === body.id && body.pdf?.at) {
      version.pdf = { size: Number(body.pdf.size) || 0, at: String(body.pdf.at), ...(typeof body.pdf.textHash === 'string' && { textHash: body.pdf.textHash.slice(0, 32) }) };
      const edits = Array.isArray(body.pdf.edits) ? body.pdf.edits.filter(e => ['from', 'to', 'after'].every(k => typeof e?.[k] === 'string')) : [];
      if (edits.length) version.pdf.edits = edits.slice(-MAX_PDF_EDITS).map(({ from, to, after }) => ({ from: from.slice(0, 600), to: to.slice(0, 600), after: after.slice(0, 32) }));
    }
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
    notePdfText(version);
    Object.assign(version, fields, { updatedAt: new Date().toISOString() });
    return { version };
  });
}

// A PDF saved before nuj noted which text it went with matches the text it has now: note
// that before the text changes, so the change marks the PDF out of date.
function notePdfText(version) {
  if (version.pdf && !version.pdf.textHash) version.pdf.textHash = textHash(version.text);
}

// Change one version's text with `change(text)`, which returns the new text, or
// { text, pdfEdit: { from, to } } for a line swapped for another (a rewrite you accepted), or
// { error }. Done in turn with other changes, so it always starts from the latest text.
// Returns the version and the text it had before (for Undo).
export function editText(userId, id, change) {
  return update(userId, versions => {
    const version = versions.find(v => v.id === id);
    if (!version) return { error: 'That version was deleted', status: 404 };
    const out = change(version.text);
    if (out?.error) return out;
    const { fields, error } = checkFields({ text: typeof out === 'string' ? out : out.text }, { partial: true });
    if (error) return { error };
    const before = version.text;
    notePdfText(version);
    const applied = pdfEditsFor(version);
    Object.assign(version, fields, { updatedAt: new Date().toISOString() });
    // A swapped line is noted against the PDF, so the preview can draw it over the old line
    // and a copy of the PDF can be written with it (see pdfedit.js). Not after a change by
    // hand: nuj can't tell which lines that moved, so the PDF is simply out of date.
    if (out.pdfEdit && version.pdf && applied) {
      version.pdf.edits = [...applied, { from: out.pdfEdit.from, to: out.pdfEdit.to, after: textHash(version.text) }].slice(-MAX_PDF_EDITS);
    }
    return { version, before };
  });
}

// ---- lines changed since the PDF was saved -------------------------------------------
// Each accepted rewrite is kept as { from, to, after }: the line's words before and after,
// and a fingerprint of the whole text it left. Undo just puts the text back, so which edits
// still hold is read off the text: none when it's as the PDF was saved, the edits up to the
// one that left this exact text, or null when the text was changed some other way.
const MAX_PDF_EDITS = 50;
// Rewrites accepted before nuj knew a bullet can wrap onto several lines replaced only its
// first line, leaving the rest under the new wording ("…frontend features" then "downloads
// by leading 5+ engineers…"), and the PDF was only told about the first line. Undone back to
// the PDF's own text (checked against the fingerprint saved with it) and replayed a whole
// bullet at a time, the text and the record of edits come out as they should have been.
// Anything that doesn't undo exactly is left alone. Returns whether it changed the version.
export function repairWrappedEdits(version) {
  const applied = pdfEditsFor(version);
  if (!applied?.length) return false;
  const lines = version.text.split('\n');
  for (const e of [...applied].reverse()) {
    const i = lines.findIndex(l => bodyOf(l) === e.to);
    if (i < 0) return false;
    lines[i] = (lines[i].match(BULLET)?.[0] ?? '') + e.from;
  }
  if (textHash(lines.join('\n')) !== version.pdf.textHash) return false;
  const edits = [];
  for (const e of applied) {
    const i = lines.findIndex(l => bodyOf(l) === e.from);
    if (i < 0) return false;
    const span = 1 + carryOnCount(lines, i);
    const from = lines.slice(i, i + span).map(bodyOf).join(' ');
    lines.splice(i, span, (lines[i].match(BULLET)?.[0] ?? '') + e.to);
    edits.push({ from, to: e.to, after: textHash(lines.join('\n')) });
  }
  const text = lines.join('\n');
  if (text === version.text) return false;
  Object.assign(version, { text, words: countWords(text), updatedAt: new Date().toISOString() });
  version.pdf.edits = edits;
  return true;
}

export function pdfEditsFor(version) {
  const pdf = version.pdf;
  if (!pdf?.textHash) return [];
  const now = textHash(version.text);
  if (now === pdf.textHash) return [];
  const edits = pdf.edits || [];
  for (let k = edits.length - 1; k >= 0; k--) if (edits[k].after === now) return edits.slice(0, k + 1);
  return null;
}

// Where the text differs from the PDF because of those edits: [{ at, from }], the line
// number in the text now and the words the PDF shows there. Undoing the edits from the
// last, each line goes back to what it was; a rewrite swaps one line for one line, so the
// line numbers match.
export function pdfLineChanges(version) {
  const applied = pdfEditsFor(version);
  if (!applied?.length) return [];
  const lines = version.text.split('\n');
  const shown = [...lines];
  for (const e of [...applied].reverse()) {
    const i = shown.findIndex(l => bodyOf(l) === e.to);
    if (i < 0) return [];
    shown[i] = (shown[i].match(BULLET)?.[0] ?? '') + e.from;
  }
  return lines.map((line, at) => (shown[at] !== line ? { at, from: bodyOf(shown[at]) } : null)).filter(Boolean);
}

export function deleteVersion(userId, id) {
  return update(userId, versions => {
    const i = versions.findIndex(v => v.id === id);
    if (i < 0) return { error: 'That version was already deleted', status: 404 };
    const [removed] = versions.splice(i, 1);
    return { removed };
  });
}

// ---- a version's PDF -----------------------------------------------------------------
export async function savePdf(userId, versionId, buffer) {
  if (fileKind(buffer) !== 'pdf') return { error: 'Only a PDF can be shown here. Save your resume as a PDF and try again' };
  const found = (await listVersions(userId)).some(v => v.id === versionId);
  if (!found) return { error: 'That version was deleted', status: 404 };
  await setFile(pdfKey(userId, versionId), buffer);
  return update(userId, versions => {
    const version = versions.find(v => v.id === versionId);
    if (!version) return { error: 'That version was deleted', status: 404 };
    // Which text the PDF was saved with: edit the text afterwards and the PDF shows the old
    // wording (see versionMeta).
    version.pdf = { size: buffer.length, at: new Date().toISOString(), textHash: textHash(version.text) };
    return { version };
  });
}

export async function loadPdf(userId, versionId) {
  const key = pdfKey(userId, versionId);
  const file = await getFile(key);
  if (file) return Buffer.from(file);
  // Saved by an older nuj as base64 text: move it to a file, a third smaller.
  const old = await getKv(key);
  if (!old) return null;
  const buffer = Buffer.from(old, 'base64');
  await setFile(key, buffer);
  await deleteKv(key);
  return buffer;
}

const forgetPdf = key => Promise.all([deleteFile(key), deleteKv(key)]);

// The PDF no longer matches the version (its text came from another file): stop showing it.
export async function removePdf(userId, versionId) {
  await forgetPdf(pdfKey(userId, versionId));
  return update(userId, versions => {
    const version = versions.find(v => v.id === versionId);
    if (version) delete version.pdf;
    return { version };
  });
}

// After a version is deleted its PDF waits out the Undo, then goes unless the version came
// back. A restart in between is caught when the versions are next read (dropOrphanPdfs).
export function dropPdfLater(userId, versionId, ms = 10 * 60_000) {
  setTimeout(async () => {
    if (!(await listVersions(userId)).some(v => v.id === versionId)) await forgetPdf(pdfKey(userId, versionId));
  }, ms).unref?.();
}

// PDFs whose version is gone: a restart came during the Undo after a delete. They get the
// same wait, in case the Undo still comes.
async function dropOrphanPdfs(userId, versions) {
  const prefix = `resume_pdf_${userId}_`;
  for (const k of new Set([...await listFileKeys(prefix), ...await listKvKeys(prefix)])) {
    const versionId = k.slice(prefix.length);
    if (!versions.some(v => v.id === versionId)) dropPdfLater(userId, versionId);
  }
}

// For an account being deleted.
export async function forgetResumes(userId) {
  await chains.get(userId);
  cache.delete(userId);
  chains.delete(userId);
  await deleteKv(key(userId));
  await deleteKvPrefix(`resume_pdf_${userId}_`);
  await deleteFilePrefix(`resume_pdf_${userId}_`);
}

// What the page lists: everything but the text. `stale`: the text was changed by hand after
// the PDF was saved, so the PDF shows the old wording and the page shows the text instead.
// `edited`: how many accepted rewrites are drawn over the PDF.
export function versionMeta({ text, ...meta }) {
  if (!meta.pdf) return meta;
  const { textHash: _, edits: __, ...pdf } = meta.pdf;
  const applied = pdfEditsFor({ text, pdf: meta.pdf });
  return { ...meta, pdf: { ...pdf, ...(applied === null ? { stale: true } : applied.length ? { edited: applied.length } : {}) } };
}

// ---- which version an application was sent with ---------------------------------------
// The day a moment fell on where you are. Start dates are days on your own calendar, so an
// application sent late in the evening has to be compared on your day, not London's.
export function dayIn(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso ?? '').slice(0, 10);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10); // a time zone this server doesn't know
  }
}

// The one you picked for it; otherwise the latest version you'd started using by the day
// you applied; otherwise (applied before your first version) the earliest.
// `versions` are sorted by usedFrom, as stored.
export function versionFor(app, versions, timeZone) {
  if (!versions.length) return null;
  if (app.resumeId) {
    const picked = versions.find(v => v.id === app.resumeId);
    if (picked) return picked;
  }
  const day = dayIn(app.appliedAt ?? app.createdAt, timeZone);
  return versions.filter(v => v.usedFrom <= day).at(-1) ?? versions[0];
}

// The version you're sending now: the latest one you've started sending. One set to start
// on a later day isn't current until then (unless no version has started yet).
export function currentVersion(versions, { timeZone, now = Date.now() } = {}) {
  const today = dayIn(new Date(now).toISOString(), timeZone);
  return versions.filter(v => v.usedFrom <= today).at(-1) ?? versions[0] ?? null;
}
