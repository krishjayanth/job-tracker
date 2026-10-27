import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyAppState, summarize } from '../src/dbcopy.js';
import { poolOptions } from '../src/store.js';

// A stand-in for Postgres that understands just the statements the copy uses, with
// transactions: writes inside begin/commit only land on commit.
function fakeDb(rows = {}, { failOnInsert = null } = {}) {
  let table = new Map(Object.entries(rows).map(([key, value]) => [key, { value, updated_at: '2026-10-01T00:00:00.000Z' }]));
  let pending = null;
  const now = () => pending ?? table;
  const sql = [];
  return {
    sql, table: () => table,
    async query(text, params = []) {
      sql.push(text.split(/\s+/).slice(0, 2).join(' '));
      if (/^create table|^alter table/.test(text)) return { rows: [] };
      if (text === 'begin') { pending = new Map(table); return { rows: [] }; }
      if (text === 'commit') { table = pending; pending = null; return { rows: [] }; }
      if (text === 'rollback') { pending = null; return { rows: [] }; }
      if (text.startsWith('select count')) return { rows: [{ n: now().size }] };
      if (text.startsWith('delete from')) { now().clear(); return { rows: [] }; }
      if (text.startsWith('insert into')) {
        if (params[0] === failOnInsert) throw new Error('connection lost');
        now().set(params[0], { value: JSON.parse(params[1]), updated_at: params[2] });
        return { rows: [] };
      }
      if (text.startsWith('select key, value, updated_at')) {
        return { rows: [...now()].sort(([a], [b]) => a.localeCompare(b)).map(([key, r]) => ({ key, ...r })) };
      }
      if (text.startsWith('select key, md5')) {
        return { rows: [...now()].map(([key, r]) => ({ key, sum: crypto.createHash('md5').update(JSON.stringify(r.value)).digest('hex') })) };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}
const quiet = { log() {} };
const neon = () => fakeDb({
  users: { 'sub-1': { email: 'a@example.com' } },
  'db_sub-1': { applications: [{ company: 'Contoso' }] },
  'gmail_token_sub-1': { refresh_token: 'r' },
  'groq_key_sub-1': { sealed: 'x', last4: 'abcd' },
  'db_before_rescan_sub-1': { applications: [] },
  errors: [],
});

test('every row is copied as it is, keeping when it was last written', async () => {
  const from = neon(), to = fakeDb();
  const r = await copyAppState(from, to, { log: quiet });
  assert.equal(r.copied, 6);
  assert.deepEqual([...to.table().keys()].sort(), [...from.table().keys()].sort());
  assert.deepEqual(to.table().get('db_sub-1'), from.table().get('db_sub-1'));
});

test('the old database is only read', async () => {
  const from = neon();
  await copyAppState(from, fakeDb(), { log: quiet });
  assert.ok(from.sql.every(s => s.startsWith('select')), from.sql.join(', '));
});

test('a new database that already has data is left alone unless forced', async () => {
  const to = fakeDb({ 'db_other': { applications: [] } });
  const r = await copyAppState(neon(), to, { log: quiet });
  assert.match(r.error, /already has 1 rows/);
  assert.ok(to.table().has('db_other'));
  const forced = await copyAppState(neon(), to, { force: true, log: quiet });
  assert.equal(forced.copied, 6);
  assert.ok(!to.table().has('db_other'), 'forcing replaces what was there');
});

test('a copy that fails part-way leaves the new database as it was', async () => {
  const to = fakeDb({}, { failOnInsert: 'groq_key_sub-1' });
  await assert.rejects(copyAppState(neon(), to, { log: quiet }), /connection lost/);
  assert.equal(to.table().size, 0);
});

test('an empty old database is refused, in case it is the wrong one', async () => {
  const r = await copyAppState(fakeDb(), fakeDb(), { log: quiet });
  assert.match(r.error, /nothing in it/);
});

test('the summary says what was copied without showing any of it', () => {
  assert.equal(summarize(['users', 'db_a', 'db_b', 'gmail_token_a', 'groq_key_a', 'db_before_rescan_a', 'errors']),
    '2 trackers, 1 Gmail sign-ins, 1 Groq keys, 1 backups, 2 other');
});

test('poolOptions: Neon needs only the URL', () => {
  const url = 'postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require';
  assert.deepEqual(poolOptions(url, ''), { connectionString: url });
});

test('poolOptions: with a CA, the connection is checked against it and the URL loses its SSL settings', () => {
  const pem = '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----';
  const o = poolOptions('postgresql://u:p@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require', pem);
  assert.equal(o.connectionString, 'postgresql://u:p@aws-0-us-west-1.pooler.supabase.com:5432/postgres');
  assert.equal(o.ssl.rejectUnauthorized, true);
  assert.equal(o.ssl.ca, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----', 'pasted "\\n"s become line breaks');
});

test('poolOptions: the CA can be a path to the certificate file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nuj-ca-')), 'supabase-ca.crt');
  fs.writeFileSync(file, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  assert.match(poolOptions('postgresql://u:p@host/db', file).ssl.ca, /^-----BEGIN CERTIFICATE-----\nMIIB/);
});
