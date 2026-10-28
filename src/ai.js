// AI for Resume insights: written suggestions for your resume, and "Check fit" for one
// application. It runs on the server's own OpenAI key (OPENAI_API_KEY), separate from
// email sorting, so it costs the owner money: everyone but the owner gets a few runs a
// day, and the server as a whole has a daily cap. A run that fails, or one that would
// give the same answer as last time, doesn't count.
//
// What the model says is checked before anyone sees it, the same way email sorting
// treats Groq: a skill it calls missing has to be in the posting, a line it rewrites has
// to be in your resume, and anything else is dropped.
import crypto from 'node:crypto';
import { getKv, setKv } from './store.js';
import { recordError } from './errors.js';
import { findSkills } from './skills.js';

export const AI_KEY = process.env.OPENAI_API_KEY || '';
export const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
// Only sent when set: not every model takes it.
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || '';
export const DAILY_LIMIT = Number(process.env.INSIGHTS_DAILY_LIMIT || 3);
export const SERVER_DAILY_LIMIT = Number(process.env.INSIGHTS_SERVER_DAILY_LIMIT || 100);
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
    consent: Boolean(db.insights?.consent),
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
  const ok = await updateServer(u => {
    if (u.runs >= SERVER_DAILY_LIMIT && !user.owner) return false;
    u.runs++;
    return true;
  });
  if (!ok) return { status: 503, error: "nuj's AI has done all it can for today. Try again tomorrow" };
  const count = userUsage(db) + 1;
  db.insights.usage = { day: today(), count };
  user.store.save();
  return {
    release: async () => {
      if (db.insights.usage?.day === today()) db.insights.usage.count = Math.max(0, db.insights.usage.count - 1);
      user.store.save();
      await updateServer(u => { u.runs = Math.max(0, u.runs - 1); });
    },
  };
}

export const hashOf = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

// ---- calling the model ------------------------------------------------------------

// One structured answer, or throws an error whose message can be shown to the person.
async function ask({ name, schema, system, user: content, client: given }) {
  const c = given ?? await openai();
  let res;
  try {
    res = await c.chat.completions.create({
      model: AI_MODEL,
      ...(REASONING_EFFORT && { reasoning_effort: REASONING_EFFORT }),
      max_completion_tokens: 4096,
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

// ---- suggestions for the resume -------------------------------------------------------

export const SECTIONS = ['Summary', 'Experience', 'Projects', 'Skills', 'Education', 'Layout', 'Overall'];
const SUGGESTIONS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'why', 'change', 'section', 'keywords'],
        properties: {
          title: { type: 'string', description: 'The change in a few words, like "Lead with your projects".' },
          why: { type: 'string', description: 'One or two sentences on why, pointing at a number or skill from the data given.' },
          change: { type: 'string', description: 'Exactly what to change in the resume, concrete enough to do in ten minutes.' },
          section: { type: 'string', enum: SECTIONS },
          keywords: { type: 'array', items: { type: 'string' }, description: 'Skills from the given lists this suggestion is about, spelled as given. Empty if none.' },
        },
      },
    },
  },
};
const SUGGESTIONS_SYSTEM = `You help a job seeker improve their resume. You get their current resume, how their applications went (which reached an assessment or interview, which were rejected or got no reply), grouped by resume version and kind of role, and the skills named in the postings they applied to, with whether their resume mentions each one.

Give 3 to 6 suggestions, most useful first. Each must be specific to this person's resume and backed by the data given: name the number or skill it rests on. Prefer changes with evidence behind them (a skill many postings ask for that the resume never mentions, a version or kind of role that does better). Don't suggest adding skills the person may not have; suggest showing skills they plausibly have but don't mention, and say to add them only if true. Don't invent facts about the person. Write plainly, in the second person, without jargon.`;

// What the model is told: the resume and numbers, never company names or emails.
export function suggestionsInput({ resumeText, versionName, insights, apps }) {
  const rate = g => ({ applications: g.total, finished: g.counted, movedForward: g.forward });
  return {
    currentVersion: versionName,
    resume: resumeText,
    overall: { applications: insights.total, finished: insights.counted, movedForward: insights.forward },
    byVersion: insights.byVersion.map(g => ({ version: g.name, ...rate(g) })),
    byKindOfRole: insights.byFunction.filter(g => g.counted).map(g => ({ kind: g.key, ...rate(g) })),
    byLevel: insights.byLevel.filter(g => g.counted).map(g => ({ level: g.key, ...rate(g) })),
    skillsMissingFromResume: insights.keywords.missing.slice(0, 25).map(k => ({ skill: k.name, postings: k.postings, movedForward: k.forward })),
    skillsInResume: insights.keywords.matched.slice(0, 25).map(k => ({ skill: k.name, postings: k.postings, movedForward: k.forward })),
    checksThatFailed: insights.checks.filter(c => !c.ok).map(c => `${c.title}: ${c.detail}`),
    // The most recent applications: title, how it went, and which version was sent.
    applications: apps.slice(0, 60),
  };
}

// Only what holds up: known sections, keywords that were in the lists given, sane lengths.
export function checkSuggestions(out, input) {
  const known = new Map([...input.skillsMissingFromResume, ...input.skillsInResume].map(k => [k.skill.toLowerCase(), k.skill]));
  return (Array.isArray(out?.suggestions) ? out.suggestions : [])
    .map(s => ({
      id: crypto.randomUUID(),
      title: clip(s.title, 90),
      why: clip(s.why, 400),
      change: clip(s.change, 600),
      section: SECTIONS.includes(s.section) ? s.section : 'Overall',
      keywords: [...new Set((s.keywords || []).map(k => known.get(String(k).toLowerCase())).filter(Boolean))].slice(0, 6),
      state: 'open',
    }))
    .filter(s => s.title && s.change)
    .slice(0, 6);
}

export async function writeSuggestions(input, { client: given } = {}) {
  const out = await ask({
    name: 'resume_suggestions', schema: SUGGESTIONS_SCHEMA, system: SUGGESTIONS_SYSTEM,
    user: JSON.stringify(input), client: given,
  });
  const items = checkSuggestions(out, input);
  if (!items.length) throw new Error("The AI didn't come up with anything useful this time. Try again later");
  return items;
}

// ---- check one application's fit ------------------------------------------------------

const FIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['match', 'summary', 'matched', 'missing', 'rewrites'],
  properties: {
    match: { type: 'string', enum: ['strong', 'partial', 'weak'] },
    summary: { type: 'string', description: 'Two sentences at most on how well the resume fits this posting.' },
    matched: { type: 'array', items: { type: 'string' }, description: 'Requirements from the posting the resume shows, in the posting\'s own words.' },
    missing: { type: 'array', items: { type: 'string' }, description: 'Requirements from the posting the resume doesn\'t show, in the posting\'s own words.' },
    rewrites: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['from', 'to', 'why'],
        properties: {
          from: { type: 'string', description: 'A line copied exactly from the resume.' },
          to: { type: 'string', description: 'That line rewritten for this posting, keeping it true.' },
          why: { type: 'string', description: 'What the rewrite brings out for this posting.' },
        },
      },
    },
  },
};
const FIT_SYSTEM = `You compare a job seeker's resume with one job description. Say how well it matches (strong, partial or weak) and why in plain words. List requirements from the posting that the resume shows and ones it doesn't, quoting short phrases from the posting itself. Then suggest up to 3 rewrites of existing resume lines that would speak better to this posting: copy each original line exactly, and keep every rewrite true to what the line says (reword and reorder, don't invent). Write in the second person.`;

// Keep what can be checked: requirements quoted from the posting, rewrites of real lines.
export function checkFit(out, { resumeText, posting }) {
  const postingLoose = loose(posting);
  const resumeLines = new Set(resumeText.split('\n').map(l => loose(l.replace(/^\s*[•*–-]\s*/, ''))).filter(l => l.length >= 12));
  const fromPosting = list => [...new Set((Array.isArray(list) ? list : []).map(x => clip(x, 80)).filter(x => x && postingLoose.includes(loose(x))))].slice(0, 8);
  const resumeHasLine = from => { const l = loose(from); return l.length >= 12 && [...resumeLines].some(line => line.includes(l) || l.includes(line)); };
  return {
    match: ['strong', 'partial', 'weak'].includes(out?.match) ? out.match : 'partial',
    summary: clip(out?.summary, 400),
    matched: fromPosting(out?.matched),
    missing: fromPosting(out?.missing),
    rewrites: (Array.isArray(out?.rewrites) ? out.rewrites : [])
      .filter(r => resumeHasLine(r?.from) && clip(r?.to, 400) && loose(r.to) !== loose(r.from))
      .map(r => ({ from: clip(r.from, 400), to: clip(r.to, 400), why: clip(r.why, 200) }))
      .slice(0, 3),
  };
}

export async function checkApplicationFit({ resumeText, posting, role }, { client: given } = {}) {
  const out = await ask({
    name: 'resume_fit', schema: FIT_SCHEMA, system: FIT_SYSTEM, client: given,
    user: JSON.stringify({ role, jobDescription: posting, resume: resumeText }),
  });
  return checkFit(out, { resumeText, posting });
}

// ---- demo mode: no key, so answers are put together from the same data -----------------

export function demoSuggestions(input) {
  const missing = input.skillsMissingFromResume.filter(k => k.movedForward).slice(0, 3);
  // Only groups with enough finished applications to mean something, as on the page.
  const rate = g => g.movedForward / g.finished;
  const best = input.byKindOfRole.filter(g => g.finished >= 5 && g.kind !== 'Not known').sort((a, b) => rate(b) - rate(a))[0];
  const current = input.byVersion.find(g => g.version === input.currentVersion);
  const older = input.byVersion.filter(g => g !== current && g.finished >= 5);
  const items = [
    missing.length && {
      title: `Show ${missing.map(k => k.skill).join(', ')} if you've used ${missing.length > 1 ? 'them' : 'it'}`,
      why: `${missing[0].skill} is in ${missing[0].postings} of your postings, and ${missing[0].movedForward} of those moved forward, but your resume never names it.`,
      change: `If you've used ${missing.length > 1 ? 'these' : 'it'} in a project or job, name ${missing.length > 1 ? 'them' : 'it'} in that bullet and add ${missing.length > 1 ? 'them' : 'it'} to your Skills line. If not, leave ${missing.length > 1 ? 'them' : 'it'} out.`,
      section: 'Skills', keywords: missing.map(k => k.skill),
    },
    current?.finished >= 5 && older.length && rate(current) > rate(older[0]) && {
      title: `Keep the shape of ${current.version}`,
      why: `${current.version} moved forward ${current.movedForward} of ${current.finished} times, against ${older[0].movedForward} of ${older[0].finished} for ${older[0].version}.`,
      change: 'When you write your next version, start from this one: keep its order of sections and its bullets with numbers, and change one thing at a time so you can see what helps.',
      section: 'Overall', keywords: [],
    },
    best && {
      title: `Aim more applications at ${best.kind.toLowerCase()} roles`,
      why: `${best.kind} roles moved forward ${best.movedForward} of ${best.finished} times, your best kind of role so far.`,
      change: `Put the bullet most relevant to ${best.kind.toLowerCase()} work first under each job, so it's the first thing read.`,
      section: 'Experience', keywords: [],
    },
    {
      title: 'Open each bullet with a result',
      why: 'Bullets that start with the outcome ("Cut load time by 45%") are easier to skim than ones that end with it.',
      change: 'Take your three strongest bullets and move the number to the front.',
      section: 'Experience', keywords: [],
    },
  ].filter(Boolean);
  return checkSuggestions({ suggestions: items }, input);
}

export function demoFit({ resumeText, posting }) {
  const inPosting = [...findSkills(posting)];
  const inResume = findSkills(resumeText);
  const matched = inPosting.filter(s => inResume.has(s));
  const missing = inPosting.filter(s => !inResume.has(s));
  const share = inPosting.length ? matched.length / inPosting.length : 0;
  const line = resumeText.split('\n').find(l => /^\s*•/.test(l) && /\d/.test(l));
  // The posting's own spelling, so the result passes the same checks a real one does.
  const asWritten = name => posting.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))?.[0] ?? name;
  return checkFit({
    match: share >= 0.6 ? 'strong' : share >= 0.3 ? 'partial' : 'weak',
    summary: `Your resume shows ${matched.length} of the ${inPosting.length} skills this posting names.${missing.length ? ` The biggest gap is ${missing[0]}.` : ''}`,
    matched: matched.map(asWritten),
    missing: missing.map(asWritten),
    rewrites: line ? [{
      from: line.replace(/^\s*•\s*/, ''),
      to: `${line.replace(/^\s*•\s*/, '').replace(/\.$/, '')}${matched[0] ? `, using ${matched[0]}` : ''}`,
      why: matched[0] ? `Names ${matched[0]}, which this posting asks for.` : 'Puts the result first.',
    }] : [],
  }, { resumeText, posting });
}
