// How well does sorting do on a labeled set of emails (test/fixtures/emails.json)?
//   npm run eval            the built-in rules
//   npm run eval -- --groq  Groq too (needs GROQ_API_KEY; spends tokens)
// Reports, for job vs. not-a-job, stage and company: how many were right, and each miss.
// Add an email to the set whenever sorting gets one wrong, so the fix stays fixed.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classify } from '../src/classify.js';
import { groqClient } from '../src/groq.js';
import { normalizeCompany } from '../src/store.js';

const FIXTURES = new URL('../test/fixtures/emails.json', import.meta.url);

export function loadFixtures() {
  return JSON.parse(fs.readFileSync(FIXTURES, 'utf8'))
    .map(f => ({ ...f, date: f.date || '2026-10-01T12:00:00.000Z' }));
}

// Runs every fixture through classify() and scores it.
export async function evaluate({ groq = null } = {}) {
  const misses = [];
  const score = { job: [0, 0], notJob: [0, 0], stage: [0, 0], company: [0, 0] };
  for (const f of loadFixtures()) {
    const r = await classify(f, { groq });
    const filed = Boolean(r);
    const bucket = f.job ? score.job : score.notJob;
    bucket[1]++;
    if (filed === f.job) bucket[0]++;
    else misses.push({ note: f.note, problem: f.job ? 'missed a job email' : `filed a non-job email as ${r.stage} at ${r.company}` });
    if (!f.job || !filed) continue;
    score.stage[1]++;
    if (r.stage === f.stage) score.stage[0]++;
    else misses.push({ note: f.note, problem: `stage ${r.stage}, expected ${f.stage}` });
    if (f.company) {
      score.company[1]++;
      if (normalizeCompany(r.company) === normalizeCompany(f.company)) score.company[0]++;
      else misses.push({ note: f.note, problem: `company "${r.company}", expected "${f.company}"` });
    }
  }
  return { score, misses };
}

const pct = ([right, of]) => `${right}/${of} (${of ? Math.round((right / of) * 100) : 100}%)`;

// Run directly: print a report.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const useGroq = process.argv.includes('--groq');
  if (useGroq && !process.env.GROQ_API_KEY) {
    console.error('Set GROQ_API_KEY to evaluate with Groq.');
    process.exit(1);
  }
  const groq = useGroq ? groqClient(process.env.GROQ_API_KEY) : null;
  const { score, misses } = await evaluate({ groq });
  console.log(`Sorting with ${useGroq ? 'Groq' : 'the built-in rules'}\n`);
  console.log(`  Job emails filed          ${pct(score.job)}`);
  console.log(`  Non-job emails left out   ${pct(score.notJob)}`);
  console.log(`  Stage right               ${pct(score.stage)}`);
  console.log(`  Company right             ${pct(score.company)}`);
  console.log(misses.length ? `\nMisses:\n${misses.map(m => `  - ${m.note}: ${m.problem}`).join('\n')}` : '\nNo misses.');
}
