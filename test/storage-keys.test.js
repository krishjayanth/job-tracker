import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Files in data/, as when running without a database. Set before store.js reads it.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuj-keys-'));
process.env.DATA_DIR = path.join(root, 'data');
delete process.env.DATABASE_URL;
let store, resume;
before(async () => {
  store = await import('../src/store.js');
  resume = await import('../src/resume.js');
  await store.initStorage();
});

// A resume version's ID comes from the address, so "x/../db_other" must never reach a file
// outside that version's own PDF: not another tracker, not anything beyond data/.
test('a storage key with a path in it never reaches another file', async () => {
  fs.writeFileSync(path.join(root, 'outside.json'), '{"keep":1}');
  await store.setKv('db_other', { applications: [] });
  await store.setKv('local_secret', 'c2VjcmV0');
  for (const key of ['x/../db_other', 'x/../../outside', 'x\..\db_other', '..']) {
    assert.equal(store.safeKey(key), false, key);
    assert.equal(await store.getKv(key), null, key);
    await assert.rejects(store.deleteKv(key), key);
    await assert.rejects(store.setFile(key, Buffer.from('x')), key);
  }
  assert.ok(fs.existsSync(path.join(root, 'outside.json')));
  assert.deepEqual(await store.getKv('db_other'), { applications: [] });
});

test("a resume PDF's address can't read or remove other files", async () => {
  assert.equal(await resume.loadPdf('me', 'x/../local_secret'), null);
  await resume.removePdf('me', 'x/../db_other');
  assert.equal((await resume.savePdf('me', 'x/../db_other', Buffer.from('%PDF-1.4'))).status, 404);
  assert.equal(await store.getKv('local_secret'), 'c2VjcmV0', 'left as it was');
  assert.deepEqual(await store.getKv('db_other'), { applications: [] });
  assert.ok(store.safeKey('resume_pdf_me_0b9c6f1e-1a2b-4c3d-8e9f-001122334455'));
});
