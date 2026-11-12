// Copying everything nuj keeps from one Postgres database to another (moving from Neon to
// Supabase): every row of app_state and app_files (resume PDFs), as it is, in one
// transaction, then checked row by row. An old database may have no app_files yet.
// source and target are anything with query(text, params) that returns { rows }.
import { prepareTable } from './store.js';

export async function copyAppState(source, target, { force = false, log = console } = {}) {
  const { rows } = await source.query('select key, value, updated_at from app_state order by key');
  if (!rows.length) return { error: 'The old database has nothing in it. Check SOURCE_DATABASE_URL points at Neon.' };

  // Files: none when the old database predates them (the query fails on a missing table).
  const files = (await source.query('select key, data, updated_at from app_files order by key').catch(() => ({ rows: [] }))).rows;

  await prepareTable(target);
  const existing = Number((await target.query('select count(*)::int as n from app_state')).rows[0].n);
  if (existing && !force) {
    return { error: `The new database already has ${existing} rows. Re-run with --force to replace them with the old database's.` };
  }

  await target.query('begin');
  try {
    if (existing) await target.query('delete from app_state');
    await target.query('delete from app_files');
    for (const r of rows) {
      await target.query('insert into app_state (key, value, updated_at) values ($1, $2::jsonb, $3)',
        [r.key, JSON.stringify(r.value), r.updated_at]);
    }
    for (const f of files) {
      await target.query('insert into app_files (key, data, updated_at) values ($1, $2, $3)', [f.key, f.data, f.updated_at]);
    }
    await target.query('commit');
  } catch (err) {
    await target.query('rollback').catch(() => {});
    throw err;
  }

  // Postgres writes jsonb back out the same way on any server, so equal text means equal data.
  const sums = async db => new Map((await db.query('select key, md5(value::text) as sum from app_state')).rows.map(r => [r.key, r.sum]));
  const [before, after] = await Promise.all([sums(source), sums(target)]);
  const wrong = [...before].filter(([key, sum]) => after.get(key) !== sum).map(([key]) => key);
  if (wrong.length || after.size !== before.size) {
    return { error: `The copy doesn't match the old database (${wrong.length} rows differ, ${after.size} of ${before.size} rows). Nothing was switched; try again.` };
  }
  if (files.length) {
    const fileSums = async db => new Map((await db.query('select key, md5(data) as sum from app_files')).rows.map(r => [r.key, r.sum]));
    const [fb, fa] = await Promise.all([fileSums(source), fileSums(target)]);
    const wrongFiles = [...fb].filter(([key, sum]) => fa.get(key) !== sum).length;
    if (wrongFiles || fa.size !== fb.size) {
      return { error: `The files didn't copy over correctly (${wrongFiles} differ, ${fa.size} of ${fb.size}). Nothing was switched; try again.` };
    }
  }
  log.log(`Copied and checked ${rows.length} rows${files.length ? ` and ${files.length} files` : ''}: ${summarize(rows.map(r => r.key))}.`);
  return { copied: rows.length, files: files.length };
}

// "3 trackers, 3 Gmail sign-ins, 2 Groq keys, 4 other": what the copy held, without data.
export function summarize(keys) {
  const kinds = { trackers: /^db_(?!before_)/, 'Gmail sign-ins': /^gmail_token_/, 'Groq keys': /^groq_key_/, backups: /^db_before_/ };
  const counts = Object.fromEntries(Object.keys(kinds).map(k => [k, 0]));
  let other = 0;
  for (const key of keys) {
    const kind = Object.keys(kinds).find(k => kinds[k].test(key));
    if (kind) counts[kind]++; else other++;
  }
  return [...Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`), ...(other ? [`${other} other`] : [])].join(', ');
}
