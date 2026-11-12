import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initStorage, getKv, setKv, getFile } from '../src/store.js';
import { extractText, cleanText, addVersion, updateVersion, editText, deleteVersion, listVersions, releaseResumes, versionMeta, forgetResumes, savePdf, loadPdf, removePdf, MAX_VERSIONS, MAX_TEXT } from '../src/resume.js';
import { textPdf } from '../src/textpdf.js';

before(() => initStorage({ inMemory: true }));
const fixture = name => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const text = 'Experience\n• Built things\nEducation\nSkills';

test('text comes out of a PDF and a Word file', async () => {
  for (const name of ['resume.pdf', 'resume.docx']) {
    const r = await extractText(fixture(name));
    assert.equal(r.error, undefined, name);
    assert.match(r.text, /Built a React and TypeScript dashboard/, name);
  }
});

test('a scanned PDF, or a file that is neither, gets a plain explanation', async () => {
  assert.match((await extractText(fixture('resume-scanned.pdf'))).error, /scanned/);
  assert.match((await extractText(Buffer.from('just some text'))).error, /PDF and Word/);
});

test('pasted text is tidied: one kind of bullet, no runs of blank lines', () => {
  assert.equal(cleanText('Skills\r\n\r\n\r\n●  Python   and SQL  \n▪ Go'), 'Skills\n\n• Python and SQL\n• Go');
});

test('versions: added in date order, edited, deleted, and put back with the same id', async () => {
  const user = 'u-versions';
  const later = await addVersion(user, { name: 'Rewrite', usedFrom: '2026-06-01', text });
  const first = await addVersion(user, { name: '', usedFrom: '2026-01-01', text });
  assert.deepEqual((await listVersions(user)).map(v => v.id), [first.version.id, later.version.id]);
  assert.match(first.version.name, /^Resume, /); // a name is made up when none is given
  assert.equal(first.version.words, 5);

  assert.equal((await updateVersion(user, later.version.id, { name: 'Projects first' })).version.name, 'Projects first');
  assert.equal((await updateVersion(user, 'nope', { name: 'x' })).status, 404);
  assert.match((await updateVersion(user, later.version.id, { usedFrom: 'last week' })).error, /date/);

  const { removed } = await deleteVersion(user, later.version.id);
  assert.equal((await listVersions(user)).length, 1);
  const back = await addVersion(user, removed);
  assert.equal(back.version.id, later.version.id);
  assert.equal(back.version.createdAt, later.version.createdAt);
  assert.equal((await getKv(`resumes_${user}`)).length, 2);
});

test(`at most ${MAX_VERSIONS} versions, each at most ${MAX_TEXT.toLocaleString('en-US')} characters`, async () => {
  const user = 'u-limits';
  for (let i = 0; i < MAX_VERSIONS; i++) assert.ok((await addVersion(user, { text })).version);
  assert.match((await addVersion(user, { text })).error, /up to 5/);
  assert.match((await addVersion('u-long', { text: 'a'.repeat(MAX_TEXT + 1) })).error, /longer than a resume/);
  assert.match((await addVersion('u-empty', { text: '   ' })).error, /Add the text/);
});

test('forgetting a user removes their resumes', async () => {
  await addVersion('u-gone', { text });
  await forgetResumes('u-gone');
  assert.equal(await getKv('resumes_u-gone'), null);
  assert.deepEqual(await listVersions('u-gone'), []);
});

test('a version keeps its PDF; anything else is refused; deleting the account removes them all', async () => {
  const user = 'u-pdf';
  const { version } = await addVersion(user, { text });
  assert.match((await savePdf(user, version.id, fixture('resume.docx'))).error, /Only a PDF/);
  assert.equal((await savePdf(user, 'gone', fixture('resume.pdf'))).status, 404);

  const saved = await savePdf(user, version.id, fixture('resume.pdf'));
  assert.equal(saved.version.pdf.size, fixture('resume.pdf').length);
  assert.ok((await loadPdf(user, version.id)).equals(fixture('resume.pdf')));

  // Undo after a delete brings the PDF back with the version.
  const { removed } = await deleteVersion(user, version.id);
  const back = await addVersion(user, removed);
  assert.equal(back.version.pdf.size, saved.version.pdf.size);

  await removePdf(user, version.id);
  assert.equal(await loadPdf(user, version.id), null);
  assert.equal((await listVersions(user))[0].pdf, undefined);

  await savePdf(user, version.id, fixture('resume.pdf'));
  await forgetResumes(user);
  assert.equal(await loadPdf(user, version.id), null);
});

test('the demo writes a real PDF whose text reads back', async () => {
  const pdf = textPdf('Sam Example\nsam@example.com\n\nExperience\n• Built a dashboard used by 300 people\nSkills\nPython, SQL');
  const { text: back, error } = await extractText(pdf);
  assert.equal(error, undefined);
  assert.match(back, /Built a dashboard used by 300 people/);
  assert.match(back, /EXPERIENCE/); // headings are set in capitals
});

test('editing the text after saving a PDF marks the PDF out of date, and undoing the edit puts it right', async () => {
  const user = 'u-stale';
  const { version } = await addVersion(user, { text });
  await savePdf(user, version.id, fixture('resume.pdf'));
  const meta = async () => versionMeta((await listVersions(user))[0]);
  assert.equal((await meta()).pdf.stale, undefined);
  assert.equal((await meta()).text, undefined); // the page's list never carries the text
  const { before } = await editText(user, version.id, t => `${t}\nNew line`);
  assert.equal((await meta()).pdf.stale, true);
  await updateVersion(user, version.id, { text: before });
  assert.equal((await meta()).pdf.stale, undefined);
  assert.match((await editText(user, version.id, () => ({ error: 'nope' }))).error, /nope/);
  assert.equal((await editText(user, 'gone', t => t)).status, 404);
});

test('an idle account lets go of its versions, and they read back from storage', async () => {
  const user = 'u-idle';
  await addVersion(user, { text });
  const held = await listVersions(user);
  releaseResumes(user);
  const again = await listVersions(user);
  assert.notEqual(again, held);
  assert.deepEqual(again, held);
});

test('a PDF left behind by a restart during Undo is found when the versions are next read', async () => {
  const user = 'u-orphan';
  await addVersion(user, { text });
  await setKv(`resume_pdf_${user}_deleted-version`, 'AAAA');
  releaseResumes(user);
  await listVersions(user); // schedules its removal after the Undo window; it's still there for now
  assert.equal(await getKv(`resume_pdf_${user}_deleted-version`), 'AAAA');
});

test('a file that takes too long to read is stopped with a plain explanation', { timeout: 30_000 }, async () => {
  assert.match((await extractText(fixture('resume.pdf'), { limitMs: 1 })).error, /took too long/);
  const { text: back, error } = await extractText(fixture('resume.pdf'));
  assert.ok(back && !error); // with time to spare, read in its own thread the same as before
});

test('a PDF saved before its text was noted is still marked out of date by an edit', async () => {
  const user = 'u-old-pdf';
  const { version } = await addVersion(user, { text });
  await savePdf(user, version.id, fixture('resume.pdf'));
  delete (await listVersions(user))[0].pdf.textHash; // as saved by an older nuj
  await editText(user, version.id, t => `${t}\nNew line`);
  assert.equal(versionMeta((await listVersions(user))[0]).pdf.stale, true);
});

test('a PDF is kept as a file, and one saved as text by an older nuj moves over when read', async () => {
  const user = 'u-files';
  const { version } = await addVersion(user, { text });
  await savePdf(user, version.id, fixture('resume.pdf'));
  const key = `resume_pdf_${user}_${version.id}`;
  assert.ok((await getFile(key)).equals(fixture('resume.pdf')));
  assert.equal(await getKv(key), null);

  const old = (await addVersion(user, { text })).version;
  const oldKey = `resume_pdf_${user}_${old.id}`;
  await setKv(oldKey, fixture('resume.pdf').toString('base64'));
  assert.ok((await loadPdf(user, old.id)).equals(fixture('resume.pdf')));
  assert.ok((await getFile(oldKey)).equals(fixture('resume.pdf')));
  assert.equal(await getKv(oldKey), null);
});
