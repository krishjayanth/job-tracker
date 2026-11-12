// AI for Resume insights: a strict review and grade of your resume, and tailoring it to
// one job description (Check fit on an application, Check a job on the Resume page). nuj
// doesn't judge the resume itself; reading it, its skills and the postings is all the AI's.
// It runs on the server's own OpenAI key (OPENAI_API_KEY), separate from email sorting, so
// it costs the owner money: everyone but the owner gets a few runs a day, and the server as
// a whole has a daily cap. A run that fails, or one that would
// give the same answer as last time, doesn't count.
//
// What the model says is checked before anyone sees it, the same way email sorting
// treats Groq: a keyword it calls missing has to be in the posting, a line it grades or
// rewrites has to be in your resume, a skill it calls unproven has to be listed in it, a rewrite can't add numbers the line didn't have (it would be
// inventing a result), and anything else is dropped. Your name and contact details are
// taken out of the resume before it's sent.
import crypto from 'node:crypto';
import { getKv, setKv } from './store.js';
import { recordError } from './errors.js';
import { withoutContact, MIN_GROUP } from './insights.js';

export const AI_KEY = process.env.OPENAI_API_KEY || '';
export const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
// Only sent when set: not every model takes it.
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || '';
export const DAILY_LIMIT = Number(process.env.INSIGHTS_DAILY_LIMIT || 3);
export const SERVER_DAILY_LIMIT = Number(process.env.INSIGHTS_SERVER_DAILY_LIMIT || 100);
// Which list of what's sent you agreed to. Raised when more is sent, so you're asked again:
// 2 added the company name (Check fit) and your pasted job descriptions (the review).
export const CONSENT_VERSION = 2;
const SERVER_KEY = 'insights_usage'; // { day, runs, limited: [user ids that hit their limit today] }

let client = null;
async function openai() {
  if (!client) {
    const { default: OpenAI } = await import('openai');
    client = new OpenAI({ apiKey: AI_KEY, maxRetries: 1, timeout: 90_000 });
  }
  return client;
}

// ---- the daily limit --------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10); // a UTC day
const tomorrow = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.toISOString(); };

let chain = Promise.resolve();
// The server's count, read-modify-write one at a time like the other shared records.
function updateServer(fn) {
  const run = chain.then(async () => {
    let usage = await getKv(SERVER_KEY);
    if (usage?.day !== today()) usage = { day: today(), runs: 0, limited: [] };
    const result = fn(usage);
    await setKv(SERVER_KEY, usage);
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

export async function serverUsage() {
  await chain;
  const usage = await getKv(SERVER_KEY);
  return usage?.day === today() ? usage : { day: today(), runs: 0, limited: [] };
}

const userUsage = db => (db.insights?.usage?.day === today() ? db.insights.usage.count : 0);

// What the page shows about AI for this person. `demo` stands in for a key in demo mode.
export function aiStatus(user, { demo = false } = {}) {
  const db = user.store.db;
  const available = Boolean(AI_KEY) || demo;
  return {
    available,
    unlimited: user.owner,
    limit: DAILY_LIMIT,
    left: user.owner ? null : Math.max(0, DAILY_LIMIT - userUsage(db)),
    resetsAt: tomorrow(),
    consent: (db.insights?.consent?.version ?? 1) >= CONSENT_VERSION && Boolean(db.insights?.consent),
  };
}

// Take one run before calling the model, so two requests at once can't both slip under
// the limit. Returns { release } to give it back if the run fails, or { error, status }.
export async function reserveRun(user) {
  const db = user.store.db;
  db.insights ??= {};
  if (!user.owner && userUsage(db) >= DAILY_LIMIT) {
    await updateServer(u => { if (!u.limited.includes(user.id)) u.limited.push(user.id); });
    return { status: 429, error: `You've used today's ${DAILY_LIMIT} AI runs. You'll get more tomorrow` };
  }
  // Counted before anything is awaited: a second request arriving meanwhile sees this one.
  const giveBack = () => {
    if (db.insights.usage?.day === today()) db.insights.usage.count = Math.max(0, db.insights.usage.count - 1);
    user.store.save();
  };
  db.insights.usage = { day: today(), count: userUsage(db) + 1 };
  user.store.save();
  const ok = await updateServer(u => {
    if (u.runs >= SERVER_DAILY_LIMIT && !user.owner) return false;
    u.runs++;
    return true;
  }).catch(err => { giveBack(); throw err; });
  if (!ok) {
    giveBack();
    return { status: 503, error: "nuj's AI has done all it can for today. Try again tomorrow" };
  }
  return {
    release: async () => {
      giveBack();
      await updateServer(u => { u.runs = Math.max(0, u.runs - 1); });
    },
  };
}

export const hashOf = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

// ---- calling the model ------------------------------------------------------------

// One structured answer, or throws an error whose message can be shown to the person.
async function ask({ name, schema, system, user: content, client: given, maxTokens = 4096 }) {
  const c = given ?? await openai();
  let res;
  try {
    res = await c.chat.completions.create({
      model: AI_MODEL,
      ...(REASONING_EFFORT && { reasoning_effort: REASONING_EFFORT }),
      max_completion_tokens: maxTokens,
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
    });
  } catch (err) {
    recordError('insights', err, { level: err.status === 429 ? 'warning' : 'error', detail: name });
    throw new Error(err.status === 429 ? 'The AI is busy right now. Try again in a minute' : "The AI couldn't answer just now. Try again in a moment");
  }
  const choice = res.choices?.[0];
  if (choice?.finish_reason !== 'stop' || !choice.message?.content) {
    recordError('insights', `The model stopped early (${choice?.finish_reason ?? 'no answer'})`, { level: 'warning', detail: name });
    throw new Error("The AI couldn't finish its answer. Try again in a moment");
  }
  try {
    return JSON.parse(choice.message.content);
  } catch {
    recordError('insights', 'The model answered with something that isn\'t JSON', { level: 'warning', detail: name });
    throw new Error("The AI's answer came back garbled. Try again in a moment");
  }
}

const clip = (s, n) => String(s ?? '').trim().slice(0, n);
// Text compared loosely: case, punctuation and spacing don't matter.
const loose = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, ' ').trim();

// The numbers in some text ("40%", "3", "1.5"), to catch a rewrite that makes up a result.
const numbersIn = s => new Set(String(s ?? '').match(/\d+(?:[.,]\d+)*/g) ?? []);
export const addsNumbers = (from, to) => [...numbersIn(to)].some(n => !numbersIn(from).has(n));

// Which line of the resume a quote from it is (-1 when it isn't one), so the preview can
// highlight it. The model's copy may differ in case, punctuation or a cut-off end.
export function findLine(text, quote) {
  const q = loose(quote);
  if (q.length < 12) return -1;
  return String(text).split('\n').findIndex(line => {
    const l = loose(line.replace(/^\s*[•●▪◦‣■□*–-]\s*/, ''));
    return l.length >= 12 && (l.includes(q) || q.includes(l));
  });
}

// ---- the review: a strict grade of the resume -----------------------------------------
// A senior recruiter's read: a score and letter grade, what a 6-second skim catches, five
// rubric scores, every bullet that fails the XYZ test with a rewrite, skills listed but
// never shown in a bullet, and the biggest weakness. When there are applications, up to
// three points from how they went too.

export const RUBRIC = [
  ['xyz', 'XYZ formula', 'How consistently bullets follow "Accomplished [X] as measured by [Y], by doing [Z]".'],
  ['numbers', 'Hard numbers', 'Claims backed by concrete figures rather than "improved performance".'],
  ['skills', 'Skills shown', 'Skills listed that are proven in Experience and Projects bullets.'],
  ['ownership', 'Ownership', 'Strong, specific action verbs rather than "helped with" or "responsible for".'],
  ['clarity', 'Clarity', 'Short, high-impact bullets with no filler.'],
];
const XYZ = ['X', 'Y', 'Z'];

// The letter for a score, so the two never disagree.
export function letterGrade(score) {
  const steps = [[97, 'A+'], [93, 'A'], [90, 'A-'], [87, 'B+'], [83, 'B'], [80, 'B-'], [77, 'C+'], [73, 'C'], [70, 'C-'], [67, 'D+'], [63, 'D'], [60, 'D-']];
  return steps.find(([min]) => score >= min)?.[1] ?? 'F';
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['score', 'skim', 'rubric', 'bullets', 'unprovenSkills', 'biggestWeakness', 'fromApplications'],
  properties: {
    score: { type: 'integer', description: 'Overall score from 1 to 100, held to top-tier industry standards.' },
    skim: { type: 'string', description: '2 to 3 sentences: what catches the eye in a 6-second skim, and where the resume loses momentum.' },
    rubric: {
      type: 'array', description: 'One entry for each rubric item, in the order given.',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'score', 'note'],
        properties: {
          id: { type: 'string', enum: RUBRIC.map(([id]) => id) },
          score: { type: 'integer', description: '1 to 10.' },
          note: { type: 'string', description: 'One or two sentences on why, naming specific bullets or skills.' },
        },
      },
    },
    bullets: {
      type: 'array', description: 'Every bullet that fails the XYZ test or lacks metrics, in resume order.',
      items: {
        type: 'object', additionalProperties: false, required: ['line', 'missing', 'note', 'rewrite'],
        properties: {
          line: { type: 'string', description: 'The bullet copied exactly from the resume, without its bullet mark.' },
          missing: { type: 'array', items: { type: 'string', enum: XYZ }, description: 'Which parts of X (the accomplishment), Y (the measure) and Z (how) are missing.' },
          note: { type: 'string', description: 'What is missing, e.g. "Missing Y: no metric" or "Missing X: only lists the tech used, not the outcome".' },
          rewrite: { type: 'string', description: 'The bullet rewritten in strict XYZ form. Use [X%] or [N] placeholders where a real metric is needed; never invent numbers.' },
        },
      },
    },
    unprovenSkills: { type: 'array', items: { type: 'string' }, description: 'Skills or tools from the skills section with no evidence in any bullet, spelled as in the resume.' },
    biggestWeakness: { type: 'string', description: 'The single biggest thing holding the resume back from an A.' },
    fromApplications: {
      type: 'array', description: 'Up to 3 changes backed by how their applications went and the job descriptions given. Empty if there are no applications or nothing they show.',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'why', 'change'],
        properties: {
          title: { type: 'string', description: 'The change in a few words.' },
          why: { type: 'string', description: 'The numbers or job descriptions it rests on.' },
          change: { type: 'string', description: 'Exactly what to change.' },
        },
      },
    },
  },
};

const REVIEW_SYSTEM = `Act as a strict senior technical recruiter and hiring manager. Grade the resume objectively on its own merits. Do not soften your feedback: hold every bullet point to top-tier industry standards. The person's name and contact details are replaced by placeholders; don't mark them down for that.

1. Overall score (1 to 100), and in 2 to 3 sentences what catches your eye during a 6-second skim and where the resume loses momentum.
2. Score each rubric item from 1 to 10:
${RUBRIC.map(([, name, about], i) => `   ${i + 1}. ${name}: ${about}`).join('\n')}
   For Hard numbers, flag vague claims like "improved performance" or "worked on scalability". For Skills shown, cross-check the skills section against Experience and Projects.
3. List every bullet that fails the Google XYZ test ("Accomplished [X] as measured by [Y], by doing [Z]") or lacks metrics. Say what is missing and rewrite it in strict XYZ form, using [X%] or [N] placeholders where real metrics need to be added. Never invent numbers, employers, tools or results.
4. List skills or tools in the skills section with no evidence in the bullets, and name the single biggest weakness holding the resume back from an A.

You also get how their applications went (which reached an assessment or interview, which were rejected or got no reply), grouped by resume version and kind of role, and some job descriptions they pasted. If there are applications, give up to 3 changes these support. Read the numbers carefully: movedForward counts online assessments, which some employers send to everyone, while reachedInterview is the stronger sign; a group marked tooFewToCompare is too small to say anything, and small differences between groups are luck. Otherwise leave fromApplications empty.

Write plainly, in the second person.`;

// Pasted job descriptions, most recent first, cut short: enough for the AI to see what the
// roles ask for without sending pages of text.
const MAX_POSTINGS = 12;
const POSTING_CHARS = 1500;

// What the model is told: the resume (without who you are), how applications went, and the
// job descriptions you pasted. Never your emails.
export function reviewInput({ resumeText, versionName, insights, apps }) {
  const rate = g => ({
    applications: g.total, finished: g.counted, movedForward: g.forward, reachedInterview: g.interviews,
    ...(g.counted < MIN_GROUP && { tooFewToCompare: true }),
  });
  return {
    currentVersion: versionName,
    resume: withoutContact(resumeText),
    overall: { applications: insights.total, finished: insights.counted, movedForward: insights.forward, reachedInterview: insights.interviews },
    mainKindsOfRole: insights.mainKinds,
    byVersion: insights.byVersion.map(g => ({ version: g.name, ...rate(g) })),
    byKindOfRole: insights.byFunction.filter(g => g.counted).map(g => ({ kind: g.key, ...rate(g) })),
    byLevel: insights.byLevel.filter(g => g.counted).map(g => ({ level: g.key, ...rate(g) })),
    // The most recent applications: title, how it went, and which version was sent.
    applications: apps.slice(0, 60).map(({ role, outcome, version }) => ({ role, outcome, version })),
    jobDescriptions: apps.filter(a => a.posting).slice(0, MAX_POSTINGS)
      .map(a => ({ role: a.role, outcome: a.outcome, text: clip(a.posting, POSTING_CHARS) })),
  };
}

const clamp = (n, lo, hi, fallback) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : fallback);

// Only what holds up: rubric items it knows, bullets that are really in the resume,
// rewrites that don't make up numbers, skills that the resume really lists.
export function checkReview(out, input) {
  const resume = input.resume ?? '';
  const resumeLoose = loose(resume);
  const score = clamp(out?.score, 1, 100, null);
  if (score == null) return null;
  const given = new Map((Array.isArray(out.rubric) ? out.rubric : []).map(r => [r?.id, r]));
  const rubric = RUBRIC.map(([id, name]) => {
    const r = given.get(id);
    return { id, name, score: clamp(r?.score, 1, 10, null), note: clip(r?.note, 300) };
  }).filter(r => r.score != null);
  const seen = new Set();
  const bullets = (Array.isArray(out.bullets) ? out.bullets : [])
    .map(b => ({ line: clip(b?.line, 400), missing: XYZ.filter(p => (b?.missing || []).includes(p)), note: clip(b?.note, 200), rewrite: clip(b?.rewrite, 400) }))
    .filter(b => {
      const at = findLine(resume, b.line);
      if (at < 0 || seen.has(at)) return false;
      seen.add(at);
      if (!b.rewrite || loose(b.rewrite) === loose(b.line) || addsNumbers(b.line, b.rewrite)) b.rewrite = '';
      return true;
    })
    .slice(0, 25)
    .map(b => ({ id: crypto.randomUUID(), ...b, state: 'open' }));
  return {
    score,
    grade: letterGrade(score),
    skim: clip(out.skim, 500),
    rubric,
    bullets,
    unprovenSkills: [...new Set((Array.isArray(out.unprovenSkills) ? out.unprovenSkills : [])
      .map(s => clip(s, 40)).filter(s => s && resumeLoose.includes(loose(s))))].slice(0, 12),
    biggestWeakness: clip(out.biggestWeakness, 400),
    fromApplications: input.overall?.applications
      ? (Array.isArray(out.fromApplications) ? out.fromApplications : [])
        .map(s => ({ id: crypto.randomUUID(), title: clip(s?.title, 90), why: clip(s?.why, 400), change: clip(s?.change, 600), state: 'open' }))
        .filter(s => s.title && s.change).slice(0, 3)
      : [],
  };
}

export async function writeReview(input, { client: given } = {}) {
  const out = await ask({
    name: 'resume_review', schema: REVIEW_SCHEMA, system: REVIEW_SYSTEM,
    user: JSON.stringify(input), client: given, maxTokens: 12_000,
  });
  const review = checkReview(out, input);
  if (!review || review.rubric.length < RUBRIC.length) throw new Error("The AI's review didn't come back complete. Try again later");
  return review;
}

// ---- tailoring: the resume against one job description ---------------------------------

const FIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['score', 'summary', 'matched', 'missingKeywords', 'redFlags', 'rewrites', 'skipped'],
  properties: {
    score: { type: 'integer', description: 'How well the resume matches this job, 0 to 100.' },
    summary: { type: 'string', description: 'Two sentences at most on the match.' },
    matched: { type: 'array', items: { type: 'string' }, description: "Requirements from the posting the resume shows, in the posting's own words." },
    missingKeywords: { type: 'array', items: { type: 'string' }, description: "The top 5 keywords from the posting missing from the resume, in the posting's own words, most important first." },
    redFlags: { type: 'array', items: { type: 'string' }, description: 'The 3 red flags a hiring manager would spot in under 10 seconds.' },
    rewrites: {
      type: 'array', description: 'Experience and project bullets rewritten to include the keywords naturally and remove the red flags, in XYZ form.',
      items: {
        type: 'object', additionalProperties: false, required: ['from', 'to', 'why'],
        properties: {
          from: { type: 'string', description: 'A bullet copied exactly from the resume.' },
          to: { type: 'string', description: 'The rewrite, "Accomplished X as measured by Y by doing Z". Use [X%] or [N] where a real metric is needed; never invent numbers.' },
          why: { type: 'string', description: 'Which keyword or red flag it handles.' },
        },
      },
    },
    skipped: {
      type: 'array', description: 'Sections an ATS filter or a hiring manager reading 200 resumes would skip, with a rewrite that stops the scroll.',
      items: {
        type: 'object', additionalProperties: false, required: ['section', 'why', 'rewrite'],
        properties: {
          section: { type: 'string', description: 'The section heading as it appears in the resume.' },
          why: { type: 'string', description: 'Why it gets skipped.' },
          rewrite: { type: 'string', description: 'The section rewritten, lines separated by newlines. Placeholders for metrics; no invented facts.' },
        },
      },
    },
  },
};

const FIT_SYSTEM = `Act as a senior recruiter for the company hiring for this job. The person's name and contact details are replaced by placeholders.

1. Analyse the resume against the job description: give a match score out of 100, the requirements it shows, the top 5 missing keywords and the 3 red flags a hiring manager would spot in under 10 seconds.
2. Rewrite the experience (and project) bullets to naturally include those keywords and remove the red flags, using the Google XYZ formula: "Accomplished X as measured by Y by doing Z". Copy each original bullet exactly. Keep every rewrite true to what the bullet says: reword and reorder, use [X%] or [N] placeholders where a metric is needed, and never invent numbers, tools or results the person didn't mention.
3. Act as an ATS filter and a hiring manager reading 200 resumes in one sitting. Name the sections that would get skipped and rewrite them so they stop the scroll, with the same rules.

Quote keywords and requirements in the posting's own words. Write plainly, in the second person.`;

// The label for a match score.
export const matchOf = score => (score >= 75 ? 'strong' : score >= 50 ? 'partial' : 'weak');

// Keep what can be checked: keywords and requirements quoted from the posting, rewrites of
// real lines that don't make up numbers, sections the resume really has.
export function checkFit(out, { resumeText, posting }) {
  const postingLoose = loose(posting);
  const fromPosting = (list, n) => [...new Set((Array.isArray(list) ? list : []).map(x => clip(x, 80)).filter(x => x && postingLoose.includes(loose(x))))].slice(0, n);
  const lines = String(resumeText).split('\n');
  const isHeading = name => lines.some(l => loose(l) === loose(name));
  const score = clamp(out?.score, 0, 100, 50);
  return {
    score,
    match: matchOf(score),
    summary: clip(out?.summary, 400),
    matched: fromPosting(out?.matched, 8),
    missingKeywords: fromPosting(out?.missingKeywords, 5),
    redFlags: (Array.isArray(out?.redFlags) ? out.redFlags : []).map(x => clip(x, 200)).filter(Boolean).slice(0, 3),
    rewrites: (Array.isArray(out?.rewrites) ? out.rewrites : [])
      .filter(r => findLine(resumeText, r?.from) >= 0 && clip(r?.to, 400) && loose(r.to) !== loose(r.from) && !addsNumbers(r.from, r.to))
      .map(r => ({ from: clip(r.from, 400), to: clip(r.to, 400), why: clip(r.why, 200) }))
      .slice(0, 10),
    skipped: (Array.isArray(out?.skipped) ? out.skipped : [])
      .filter(s => clip(s?.section, 60) && isHeading(s.section) && clip(s?.rewrite, 3000) && !addsNumbers(sectionText(lines, s.section), s.rewrite))
      .map(s => ({ section: clip(s.section, 60), why: clip(s.why, 300), rewrite: clip(s.rewrite, 3000) }))
      .slice(0, 4),
  };
}

// The text under a heading, up to the next heading-looking line, to check a section rewrite
// against.
function sectionText(lines, heading) {
  const at = lines.findIndex(l => loose(l) === loose(heading));
  const rest = lines.slice(at + 1);
  const end = rest.findIndex(l => /^[^a-z]{3,40}$/.test(l.trim()) && /[A-Z]/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

export async function checkApplicationFit({ resumeText, posting, role, company }, { client: given } = {}) {
  const out = await ask({
    name: 'resume_fit', schema: FIT_SCHEMA, system: FIT_SYSTEM, client: given, maxTokens: 10_000,
    user: JSON.stringify({ company: company || undefined, role: role || undefined, jobDescription: posting, resume: withoutContact(resumeText) }),
  });
  return checkFit(out, { resumeText, posting });
}

// ---- demo mode: no key, so answers are put together from the same text ------------------
// Rough stand-ins so the page can be tried without an OpenAI key. Real answers come from the
// model; nothing here is used when there is one.

const demoBullets = resume => resume.split('\n').filter(l => /^\s*•/.test(l)).map(l => l.replace(/^\s*•\s*/, ''));
const WEAK_START = /^(responsible for|helped|assisted|worked on|participated in|involved in)\b/i;

export function demoReview(input) {
  const resume = input.resume ?? '';
  const bullets = demoBullets(resume);
  const noNumber = bullets.filter(b => !/\d/.test(b));
  const weak = bullets.filter(b => WEAK_START.test(b));
  const long = bullets.filter(b => b.split(/\s+/).length > 30);
  const share = bullets.length ? 1 - noNumber.length / bullets.length : 0;
  const lines = resume.split('\n');
  const skillsAt = lines.findIndex(l => /^\s*(technical )?skills\s*:?\s*$/i.test(l));
  const listed = skillsAt >= 0 ? (lines[skillsAt + 1] ?? '').split(/[,;|·]/).map(s => s.trim()).filter(Boolean) : [];
  const shown = bullets.join(' ').toLowerCase();
  const unproven = listed.filter(s => !shown.includes(s.toLowerCase()));
  const ten = n => Math.max(1, Math.min(10, Math.round(n)));
  const rubric = {
    xyz: ten(2 + share * 7), numbers: ten(1 + share * 9), skills: ten(10 - unproven.length * 1.5),
    ownership: ten(9 - weak.length * 2), clarity: ten(9 - long.length * 2),
  };
  const score = Math.round(Object.values(rubric).reduce((a, b) => a + b, 0) * 2);
  const xyz = b => `${b.replace(/\.$/, '')}, raising [X] by [Y%]`;
  return checkReview({
    score,
    skim: `The projects with named tools stand out first. ${noNumber.length} of ${bullets.length} bullets have no number, so the resume loses momentum in the middle.`,
    rubric: [
      { id: 'xyz', score: rubric.xyz, note: `${bullets.length - noNumber.length} of ${bullets.length} bullets give a result with a measure.` },
      { id: 'numbers', score: rubric.numbers, note: noNumber.length ? `"${noNumber[0]}" makes a claim with nothing to measure it by.` : 'Every bullet has a figure.' },
      { id: 'skills', score: rubric.skills, note: unproven.length ? `${unproven.slice(0, 3).join(', ')} ${unproven.length === 1 ? 'is' : 'are'} listed but never used in a bullet.` : 'Every listed skill shows up in a bullet.' },
      { id: 'ownership', score: rubric.ownership, note: weak.length ? `"${weak[0].match(WEAK_START)[0]}" hides what you did yourself.` : 'Bullets open with what you did.' },
      { id: 'clarity', score: rubric.clarity, note: long.length ? `${long.length} bullets run past two lines.` : 'Bullets are short enough to skim.' },
    ],
    bullets: [...new Set([...weak, ...noNumber])].map(b => ({
      line: b,
      missing: WEAK_START.test(b) ? ['X', 'Y'] : ['Y'],
      note: WEAK_START.test(b) ? 'Missing X: describes a duty, not an outcome' : 'Missing Y: no metric',
      rewrite: xyz(b.replace(WEAK_START, '').trim()),
    })),
    unprovenSkills: unproven,
    biggestWeakness: noNumber.length > unproven.length
      ? 'Too many bullets say what you did without how it turned out. Numbers on those would move this to the next grade.'
      : 'Your skills line claims more than your bullets show. Prove each skill in a bullet, or cut it.',
    fromApplications: input.overall?.applications ? [{
      title: 'Lead with your projects',
      why: `${input.overall.reachedInterview} of your ${input.overall.finished} finished applications reached an interview.`,
      change: 'Move Projects above Experience so the work with the most named tools is read first.',
    }] : [],
  }, input);
}

export function demoFit({ resumeText, posting }) {
  // Words the posting writes like tools (capitalised or with . + #) that the resume never names.
  const resume = loose(resumeText);
  const terms = [...new Set(posting.match(/\b[A-Z][\w.+#-]*[\w+#]|\b\w+\.js\b/g) ?? [])].filter(t => t.length > 1 && !/^(We|You|The|Our|This|In|An|And|To|With|For|A|I)$/.test(t));
  const have = terms.filter(t => resume.includes(loose(t)));
  const missing = terms.filter(t => !resume.includes(loose(t)));
  const score = terms.length ? Math.round(30 + (have.length / terms.length) * 60) : 50;
  const bullets = demoBullets(resumeText);
  return checkFit({
    score,
    summary: `Your resume names ${have.length} of the ${terms.length} tools this posting mentions.${missing.length ? ` The biggest gap is ${missing[0]}.` : ''}`,
    matched: have,
    missingKeywords: missing,
    redFlags: [
      bullets.some(b => !/\d/.test(b)) ? 'Several bullets have no result a reader can measure.' : 'Results are there but buried at the end of bullets.',
      missing.length ? `${missing[0]} is in the posting but nowhere in your resume.` : 'The summary is generic rather than written for this role.',
      'Skills are listed without showing where you used them.',
    ],
    rewrites: bullets.filter(b => /\d/.test(b)).slice(0, 2).map(b => ({
      from: b, to: `${b.replace(/\.$/, '')}${have[0] ? `, using ${have[0]}` : ''}`, why: have[0] ? `Names ${have[0]}, which this posting asks for.` : 'Puts the result first.',
    })),
    skipped: [],
  }, { resumeText, posting });
}
