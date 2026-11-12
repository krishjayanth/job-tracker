// What the AI is told about how a resume is doing (see suggestionsInput in ai.js): which
// applications moved forward, grouped by the resume they were sent with and by the kind of
// role, the skills postings ask for that the resume does or doesn't mention, and a few plain
// checks on the resume itself. None of it is shown on the page as it is; the AI's
// suggestions point at the numbers they rest on. Worked out on each request.
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

// The text nuj has about each posting: a job description you pasted, the title, and
// what the emails said.
const postingText = a => [a.posting, a.role, ...a.events.flatMap(e => [e.subject, e.snippet, e.summary])]
  .filter(Boolean).join('\n');

// Skills from the postings, split by whether the resume names them. Each says which kinds
// of role asked for it, so one iOS posting's Swift doesn't read like a gap for a data analyst.
export function keywords(apps, resumeText, outcomes) {
  const inResume = findSkills(resumeText);
  const counts = new Map();
  for (const a of apps) {
    const kind = roleFunction(a.role);
    for (const name of findSkills(postingText(a))) {
      const k = counts.get(name) ?? { name, postings: 0, forward: 0, ids: [], byKind: new Map() };
      k.postings++;
      k.ids.push(a.id);
      k.byKind.set(kind, (k.byKind.get(kind) ?? 0) + 1);
      if (outcomes.get(a.id) === 'forward') k.forward++;
      counts.set(name, k);
    }
  }
  const all = [...counts.values()]
    .map(({ byKind, ...k }) => ({ ...k, kinds: [...byKind].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([kind]) => kind) }))
    .sort((a, b) => b.postings - a.postings || b.forward - a.forward || a.name.localeCompare(b.name));
  return {
    matched: all.filter(k => inResume.has(k.name)),
    missing: all.filter(k => !inResume.has(k.name)),
    withPosting: apps.filter(a => a.posting?.trim()).length,
    resumeSkills: [...inResume].sort(),
  };
}

// ---- quick checks on the resume text ------------------------------------------------
const BULLET = /^\s*(?:[•●▪◦‣■□*–-]|\d+[.)])\s+/;
const WEAK_OPENER = /^(responsible for|was responsible|helped|assisted|worked on|tasked with|duties included|involved in|participated in|utili[sz]ed|in charge of|handled)\b/i;
const SECTIONS = [
  ['Experience', /^\s*(work |professional |relevant )?(experience|employment|work history)\b/im],
  ['Education', /^\s*education\b/im],
  ['Skills', /^\s*(technical )?(skills|technologies|tools)\b/im],
];
// Years and date ranges aren't results: "2023" in a bullet doesn't make it a measured one.
const YEARS = /\b(19|20)\d{2}\b/g;
const FIRST_PERSON = /\b(I|my|me|myself)\b/;
const CLICHES = /\b(team player|hard[- ]working|detail[- ]oriented|go[- ]getter|self[- ]starter|results[- ]driven|think outside the box|synergy|dynamic individual|passionate about)\b/i;
const LONG_BULLET_WORDS = 35;
// The ways people write the month of a date, to notice a resume that mixes them.
const DATE_STYLES = [
  ['Jan 2023', /\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.? (19|20)\d{2}\b/gi],
  ['January 2023', /\b(january|february|march|april|june|july|august|september|october|november|december) (19|20)\d{2}\b/gi],
  ['01/2023', /\b(0?[1-9]|1[0-2])\/(19|20)\d{2}\b/g],
  ['2023-01', /\b(19|20)\d{2}-(0[1-9]|1[0-2])\b/g],
];

export function quickChecks(text) {
  const words = countWords(text);
  const pages = Math.max(1, Math.round(words / 450));
  const bullets = text.split('\n').filter(l => BULLET.test(l)).map(l => l.replace(BULLET, '').trim());
  const withNumber = bullets.filter(b => /\d/.test(b.replace(YEARS, ''))).length;
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
      ? { id: 'numbers', ok: false, title: 'Few results with numbers', detail: `${withNumber} of ${bullets.length} bullet points have a number in them (years don't count). Results like “cut load time by 40%” stand out.` }
      : { id: 'numbers', ok: true, title: 'Results with numbers', detail: `${withNumber} of ${bullets.length} bullet points have a number in them.` });
    checks.push(weak.length
      ? { id: 'verbs', ok: false, title: 'Some bullets start weakly', detail: `${weak.length} start with phrases like “${weak[0].match(WEAK_OPENER)[0]}”. Starting with what you did (“Built”, “Led”, “Reduced”) reads stronger.` }
      : { id: 'verbs', ok: true, title: 'Bullets start with what you did', detail: 'None start with “Responsible for” or “Helped”.' });
    // The same opening verb again and again ("Developed" six times) reads as a list of chores.
    const openers = new Map();
    for (const b of bullets) {
      const verb = b.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
      if (verb) openers.set(verb, (openers.get(verb) ?? 0) + 1);
    }
    const [repeated, times] = [...openers].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    checks.push(times >= 4 && times / bullets.length >= 0.25
      ? { id: 'repeats', ok: false, title: 'The same opening word again and again', detail: `${times} bullets start with “${repeated[0].toUpperCase()}${repeated.slice(1)}”. Varying it shows the range of what you did.` }
      : { id: 'repeats', ok: true, title: 'Bullets start in different ways', detail: 'No opening word is used over and over.' });
    const long = bullets.filter(b => countWords(b) > LONG_BULLET_WORDS).length;
    checks.push(long
      ? { id: 'long', ok: false, title: 'Some bullets are long', detail: `${long} ${long === 1 ? 'bullet runs' : 'bullets run'} past ${LONG_BULLET_WORDS} words. One or two lines each is easier to skim.` }
      : { id: 'long', ok: true, title: 'Bullets are easy to skim', detail: `None run past ${LONG_BULLET_WORDS} words.` });
    const personal = bullets.filter(b => FIRST_PERSON.test(b)).length;
    checks.push(personal
      ? { id: 'first-person', ok: false, title: '“I” and “my” in bullets', detail: `${personal} ${personal === 1 ? 'bullet uses' : 'bullets use'} “I” or “my”. Resumes usually leave them out (“Built…”, not “I built…”).` }
      : { id: 'first-person', ok: true, title: 'No “I” or “my” in bullets', detail: 'Bullets start with what was done.' });
  }
  checks.push(missing.length
    ? { id: 'sections', ok: false, title: `No ${missing.join(' or ')} section found`, detail: 'Hiring software looks for these headings. If you have the section, a plain heading helps it get read.' }
    : { id: 'sections', ok: true, title: 'The usual sections are there', detail: 'Experience, Education and Skills.' });
  const noEmail = !/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text);
  const noLinkedIn = !/linkedin/i.test(text);
  checks.push(noEmail || noLinkedIn
    ? { id: 'contact', ok: false, title: noEmail ? 'No email address found' : 'No LinkedIn link', detail: noEmail ? 'Recruiters need a way to reach you. Put your email at the top.' : 'Most recruiters look for a LinkedIn profile. Add yours next to your email if you have one.' }
    : { id: 'contact', ok: true, title: 'Contact details are there', detail: 'An email address and a LinkedIn link.' });
  const cliche = text.match(CLICHES);
  checks.push(cliche
    ? { id: 'cliches', ok: false, title: 'Phrases recruiters skip over', detail: `“${cliche[0]}” says little on its own. Show it with something you did instead.` }
    : { id: 'cliches', ok: true, title: 'No stock phrases', detail: 'Nothing like “team player” or “detail-oriented”.' });
  const styles = DATE_STYLES.filter(([, re]) => (text.match(re) ?? []).length).map(([example]) => example);
  checks.push(styles.length > 1
    ? { id: 'dates', ok: false, title: 'Dates are written in different ways', detail: `Some look like “${styles[0]}” and some like “${styles[1]}”. One style throughout looks tidier.` }
    : { id: 'dates', ok: true, title: 'Dates are written one way', detail: 'Every date uses the same style.' });
  return checks;
}

// ---- the resume preview ---------------------------------------------------------------
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
// only the lines AI suggestions are about; it doesn't judge lines itself.
export function layoutLines(text) {
  const lines = text.split('\n');
  const firstText = lines.findIndex(l => l.trim());
  return lines.map((line, i) => {
    const kind = lineKind(line, i, firstText);
    return { kind, text: line, at: kind === 'bullet' ? line.match(BULLET)[0].length : 0 };
  });
}

// The resume without the name and contact lines at the top, for sending to OpenAI: the
// suggestions don't need to know who you are or how to reach you.
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
    // The kinds of role most of the applications are for, so skills asked for elsewhere
    // can be weighed less.
    mainKinds: byFunction.filter(g => g.key !== 'Not known').sort((a, b) => b.total - a.total).slice(0, 2).map(g => g.key),
    keywords: keywords(apps, current?.text ?? '', outcomes),
    checks: current ? quickChecks(current.text) : [],
    currentId: current?.id ?? null,
  };
}
