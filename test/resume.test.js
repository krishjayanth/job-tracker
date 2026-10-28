import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initStorage, getKv } from '../src/store.js';
import { extractText, cleanText, addVersion, updateVersion, deleteVersion, listVersions, forgetResumes, MAX_VERSIONS, MAX_TEXT } from '../src/resume.js';

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
