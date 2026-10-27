// Move nuj's data from Neon to Supabase (or between any two Postgres databases).
//   SOURCE_DATABASE_URL=<Neon> DATABASE_URL=<Supabase> DATABASE_CA=<Supabase's certificate> npm run copy-db
// Suspend the Render service first, so nothing writes to the old database during the
// copy; docs/DEPLOY.md has the steps. The old database is only read, never changed.
import pg from 'pg';
import { poolOptions } from '../src/store.js';
import { copyAppState } from '../src/dbcopy.js';

const from = process.env.SOURCE_DATABASE_URL;
const to = process.env.DATABASE_URL;
if (!from || !to) {
  console.error('Set SOURCE_DATABASE_URL to the old database (Neon) and DATABASE_URL to the new one (Supabase).');
  process.exit(1);
}
if (from === to) {
  console.error('SOURCE_DATABASE_URL and DATABASE_URL are the same database.');
  process.exit(1);
}

// The old database is Neon, with a public certificate; DATABASE_CA is for the new one only.
const source = new pg.Pool({ ...poolOptions(from, ''), max: 1 });
const target = new pg.Pool({ ...poolOptions(to), max: 1 });
const client = await target.connect(); // one connection, so the transaction holds together
try {
  const r = await copyAppState(source, client, { force: process.argv.includes('--force') });
  if (r.error) {
    console.error(r.error);
    process.exitCode = 1;
  } else {
    console.log('Done. Now set DATABASE_URL (and DATABASE_CA) on Render to the new database and resume the service.');
  }
} finally {
  client.release();
  await Promise.all([source.end(), target.end()]);
}
