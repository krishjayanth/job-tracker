// One-time copy of your local tracker into the hosted Postgres database, so the website
// starts with all your applications and edits.
//   DATABASE_URL=postgres://... npm run migrate [data/db_local.json]
// It's stored the way single-user nuj kept it ("db"), and becomes the owner's (the
// first ALLOWED_EMAIL) when they first sign in, if they have no tracker there yet.
// Gmail sign-in is not copied: the hosted site uses a different Google client, so you
// connect Gmail again by signing in there.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { poolOptions, prepareTable } from '../src/store.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to your database connection string first (and DATABASE_CA for Supabase).');
  process.exit(1);
}
// data/db_local.json since accounts; data/db.json before.
const file = path.resolve(process.argv[2] || ['data/db_local.json', 'data/db.json'].find(f => fs.existsSync(f)) || 'data/db_local.json');
const db = JSON.parse(fs.readFileSync(file, 'utf8'));

const pool = new pg.Pool({ ...poolOptions(url), max: 1 });
await prepareTable(pool);
const { rows } = await pool.query(`select jsonb_array_length(value->'applications') as n from app_state where key = 'db'`);
if (rows[0] && !process.argv.includes('--force')) {
  console.error(`The database already holds ${rows[0].n} applications. Re-run with --force to overwrite them.`);
  process.exit(1);
}
await pool.query(
  `insert into app_state (key, value) values ('db', $1::jsonb)
   on conflict (key) do update set value = excluded.value, updated_at = now()`, [JSON.stringify(db)]);
await pool.end();
console.log(`Copied ${db.applications.length} applications from ${file} to the database.`);
