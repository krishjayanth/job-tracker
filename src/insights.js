// Resume insights without AI: which applications moved forward, grouped by the resume
// they were sent with and by the kind of role, the skills postings ask for that your
// resume does or doesn't mention, and a few plain checks on the resume itself.
// Everything here is worked out from data the person already has, on each request.
import { stagePath } from './stages.js';
import { findSkills, roleFunction, roleLevel } from './skills.js';
import { versionFor, currentVersion, countWords } from './resume.js';

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

function groupBy(apps, keyOf, outcomes) {
  const groups = new Map();
  for (const a of apps) {
    const key = keyOf(a);
    if (key == null) continue;
    const g = groups.get(key) ?? { key, total: 0, counted: 0, forward: 0, ids: [] };
    g.total++;
    g.ids.push(a.id);
    const o = outcomes.get(a.id);
    if (o !== 'pending') g.counted++;
    if (o === 'forward') g.forward++;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(g => ({ ...g, rate: g.counted >= MIN_GROUP ? g.forward / g.counted : null }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.total - a.total);
}

// The group that does best, when there are at least two groups to compare.
function best(groups) {
  const rated = groups.filter(g => g.rate != null);
  return rated.length >= 2 && rated[0].rate > rated[1].rate ? rated[0].key : null;
}

// The text nuj has about each posting: a job description you pasted, the title, and
// what the emails said.
const postingText = a => [a.posting, a.role, ...a.events.flatMap(e => [e.subject, e.snippet, e.summary])]
  .filter(Boolean).join('\n');

export function keywords(apps, resumeText, outcomes) {
  const inResume = findSkills(resumeText);
  const counts = new Map();
  for (const a of apps) {
    for (const name of findSkills(postingText(a))) {
      const k = counts.get(name) ?? { name, postings: 0, forward: 0, ids: [] };
      k.postings++;
      k.ids.push(a.id);
      if (outcomes.get(a.id) === 'forward') k.forward++;
      counts.set(name, k);
    }
  }
  const all = [...counts.values()].sort((a, b) => b.postings - a.postings || b.forward - a.forward || a.name.localeCompare(b.name));
  return {
    matched: all.filter(k => inResume.has(k.name)),
    missing: all.filter(k => !inResume.has(k.name)),
    withPosting: apps.filter(a => a.posting?.trim()).length,
    resumeSkills: [...inResume].sort(),
  };
}

// ---- quick checks on the resume text ------------------------------------------------
const BULLET = /^\s*(?:[•●▪◦‣■□*–-]|\d+[.)])\s+/;
const WEAK_OPENER = /^(responsible for|helped|assisted|worked on|tasked with|duties included|involved in|participated in)\b/i;
const SECTIONS = [
  ['Experience', /^\s*(work |professional |relevant )?(experience|employment|work history)\b/im],
  ['Education', /^\s*education\b/im],
  ['Skills', /^\s*(technical )?(skills|technologies|tools)\b/im],
];

export function quickChecks(text) {
  const words = countWords(text);
  const pages = Math.max(1, Math.round(words / 450));
  const bullets = text.split('\n').filter(l => BULLET.test(l)).map(l => l.replace(BULLET, '').trim());
  const withNumber = bullets.filter(b => /\d/.test(b)).length;
  const weak = bullets.filter(b => WEAK_OPENER.test(b));
  const missing = SECTIONS.filter(([, re]) => !re.test(text)).map(([name]) => name);
  const checks = [
    words < 200
      ? { id: 'length', ok: false, title: 'Short for a resume', detail: `About ${words} words. Most one-page resumes have 300 to 700.` }
      : words > 1100
        ? { id: 'length', ok: false, title: 'Long for a resume', detail: `About ${words} words, roughly ${pages} pages. Recruiters often skim; one or two pages is usual.` }
        : { id: 'length', ok: true, title: 'A good length', detail: `About ${words} words, roughly ${pages} ${pages === 1 ? 'page' : 'pages'}.` },
  ];
  if (bullets.length >= 4) {
    const share = withNumber / bullets.length;
    checks.push(share < 0.3
      ? { id: 'numbers', ok: false, title: 'Few results with numbers', detail: `${withNumber} of ${bullets.length} bullet points have a number in them. Results like “cut load time by 40%” stand out.` }
      : { id: 'numbers', ok: true, title: 'Results with numbers', detail: `${withNumber} of ${bullets.length} bullet points have a number in them.` });
    checks.push(weak.length
      ? { id: 'verbs', ok: false, title: 'Some bullets start weakly', detail: `${weak.length} start with phrases like “${weak[0].match(WEAK_OPENER)[0]}”. Starting with what you did (“Built”, “Led”, “Reduced”) reads stronger.` }
      : { id: 'verbs', ok: true, title: 'Bullets start with what you did', detail: 'None start with “Responsible for” or “Helped”.' });
  }
  checks.push(missing.length
    ? { id: 'sections', ok: false, title: `No ${missing.join(' or ')} section found`, detail: 'Hiring software looks for these headings. If you have the section, a plain heading helps it get read.' }
    : { id: 'sections', ok: true, title: 'The usual sections are there', detail: 'Experience, Education and Skills.' });
  return checks;
}

// ---- everything on the page ---------------------------------------------------------
// `apps` are the person's applications, `versions` their resume versions (with text).
export function computeInsights(apps, versions, { ghostDays }) {
  const outcomes = new Map(apps.map(a => [a.id, outcomeOf(a, { ghostDays })]));
  const counted = apps.filter(a => outcomes.get(a.id) !== 'pending');
  const forward = counted.filter(a => outcomes.get(a.id) === 'forward').length;
  const byVersion = versions.length
    ? groupBy(apps, a => versionFor(a, versions)?.id, outcomes).map(g => ({ ...g, name: versions.find(v => v.id === g.key).name }))
    : [];
  const byFunction = groupBy(apps, a => roleFunction(a.role), outcomes);
  const byLevel = groupBy(apps, a => roleLevel(a.role), outcomes);
  const current = currentVersion(versions);
  return {
    total: apps.length,
    counted: counted.length,
    pending: apps.length - counted.length,
    forward,
    rate: counted.length ? forward / counted.length : null,
    byVersion,
    byFunction,
    byLevel,
    best: {
      version: byVersion.length ? byVersion.find(g => g.key === best(byVersion))?.name ?? null : null,
      function: best(byFunction.filter(g => g.key !== 'Not known')),
    },
    keywords: keywords(apps, current?.text ?? '', outcomes),
    checks: current ? quickChecks(current.text) : [],
    currentId: current?.id ?? null,
  };
}
