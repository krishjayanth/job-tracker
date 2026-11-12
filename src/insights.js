// What the AI is told about how your applications went (see reviewInput in ai.js): which
// moved forward, grouped by the resume they were sent with, the kind of role and level.
// nuj doesn't judge the resume itself: reading it, its skills and the job descriptions is
// all left to the AI. Also the preview's line layout. Worked out on each request.
import { stagePath } from './stages.js';
import { roleFunction, roleLevel } from './roles.js';
import { versionFor, currentVersion } from './resume.js';

// Below this many finished applications, a group's rate says more about luck than the resume.
export const MIN_GROUP = 5;

// forward: reached an assessment or interview (or an offer)
// stalled: rejected before that, or no reply for weeks
// pending: still waiting, or withdrawn before hearing anything; left out of the rates
export function outcomeOf(app, { ghostDays }) {
  const path = app.path ?? stagePath(app, { ghostDays });
  if (path.includes('oa') || path.includes('interview') || app.status === 'offer') return 'forward';
  if (app.status === 'rejected' || path.at(-1) === 'no_response') return 'stalled';
  return 'pending';
}

// Reaching an interview is the stronger sign: for internships an online assessment often
// goes to everyone who applies.
export function reachedInterview(app, { ghostDays }) {
  const path = app.path ?? stagePath(app, { ghostDays });
  return path.includes('interview') || app.status === 'offer';
}

function groupBy(apps, keyOf, outcomes, interviews) {
  const groups = new Map();
  for (const a of apps) {
    const key = keyOf(a);
    if (key == null) continue;
    const g = groups.get(key) ?? { key, total: 0, counted: 0, forward: 0, interviews: 0, ids: [] };
    g.total++;
    g.ids.push(a.id);
    const o = outcomes.get(a.id);
    if (o !== 'pending') g.counted++;
    if (o === 'forward') g.forward++;
    if (interviews.has(a.id)) g.interviews++;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(g => ({ ...g, rate: g.counted >= MIN_GROUP ? g.forward / g.counted : null }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.total - a.total);
}

// ---- the resume preview ---------------------------------------------------------------
const BULLET = /^\s*(?:[•●▪◦‣■□*–-]|\d+[.)])\s+/;
const HEADING = /^\s*(summary|profile|objective|about( me)?|(work |professional |relevant )?experience|employment( history)?|work history|education|(technical )?skills|technologies|tools|projects?|personal projects|activities|leadership|volunteer(ing)?|awards?|honou?rs|certifications?|publications|interests|languages|coursework|achievements|extracurriculars?)\s*:?\s*$/i;
const CONTACT = /@|https?:|www\.|linkedin|github|\+?\d[\d ()-]{7,}|·|\|/i;

// What kind of line each is, for laying the preview out like a resume.
function lineKind(line, i, firstText) {
  if (!line.trim()) return 'blank';
  if (i === firstText) return 'name';
  if (BULLET.test(line)) return 'bullet';
  if (HEADING.test(line) || (/^[^a-z]{3,40}$/.test(line.trim()) && /[A-Z]/.test(line))) return 'heading';
  if (i <= firstText + 3 && CONTACT.test(line)) return 'contact';
  return 'text';
}

// Every line of a resume with what kind of line it is, for laying the preview out like a
// resume (and the demo's PDFs). `at` is where a bullet's own text starts. The page marks
// only the bullets the AI's review is about; it doesn't judge lines itself.
export function layoutLines(text) {
  const lines = text.split('\n');
  const firstText = lines.findIndex(l => l.trim());
  return lines.map((line, i) => {
    const kind = lineKind(line, i, firstText);
    return { kind, text: line, at: kind === 'bullet' ? line.match(BULLET)[0].length : 0 };
  });
}

// The resume without the name and contact lines at the top, for sending to OpenAI: the
// review doesn't need to know who you are or how to reach you.
export function withoutContact(text) {
  return layoutLines(text)
    .map(l => (l.kind === 'name' ? '[Name]' : l.kind === 'contact' ? '[Contact details]' : l.text))
    .join('\n');
}

// ---- everything the AI is told ------------------------------------------------------
// `apps` are the person's applications, `versions` their resume versions (with text).
// `timeZone` is theirs: start dates are days on their own calendar.
export function computeInsights(apps, versions, { ghostDays, timeZone }) {
  const outcomes = new Map(apps.map(a => [a.id, outcomeOf(a, { ghostDays })]));
  const interviews = new Set(apps.filter(a => reachedInterview(a, { ghostDays })).map(a => a.id));
  const counted = apps.filter(a => outcomes.get(a.id) !== 'pending');
  const forward = counted.filter(a => outcomes.get(a.id) === 'forward').length;
  const byVersion = versions.length
    ? groupBy(apps, a => versionFor(a, versions, timeZone)?.id, outcomes, interviews).map(g => ({ ...g, name: versions.find(v => v.id === g.key).name }))
    : [];
  const byFunction = groupBy(apps, a => roleFunction(a.role), outcomes, interviews);
  const byLevel = groupBy(apps, a => roleLevel(a.role), outcomes, interviews);
  const current = currentVersion(versions, { timeZone });
  return {
    total: apps.length,
    counted: counted.length,
    pending: apps.length - counted.length,
    forward,
    interviews: interviews.size,
    rate: counted.length ? forward / counted.length : null,
    byVersion,
    byFunction,
    byLevel,
    // The kinds of role most of the applications are for.
    mainKinds: byFunction.filter(g => g.key !== 'Not known').sort((a, b) => b.total - a.total).slice(0, 2).map(g => g.key),
    currentId: current?.id ?? null,
  };
}
