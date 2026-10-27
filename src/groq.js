// LLM classifier via GroqCloud (https://console.groq.com). Each person brings their own
// API key (the server's GROQ_API_KEY covers only the owner). Without one, emails are
// sorted by the built-in rules. Default model: openai/gpt-oss-20b, with strict JSON-schema output.
import Groq from 'groq-sdk';
import { recordError } from './errors.js';

export const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
export const SERVER_KEY = process.env.GROQ_API_KEY || '';

// The free tier allows ~8K tokens/minute and ~200K/day for this model, so keep each
// request lean: an excerpt of the email (where the facts are). Medium reasoning reads
// tricky emails noticeably better; set GROQ_REASONING_EFFORT=low to spend fewer tokens.
const MAX_BODY_CHARS = 3_500;
const REASONING_EFFORT = process.env.GROQ_REASONING_EFFORT || 'medium';
const MAX_WAIT_SECONDS = 60; // longer than this and we use the rules for this email instead

// One client per key, reused across syncs.
const clients = new Map();
export function groqClient(apiKey) {
  if (!apiKey) return null;
  if (!clients.has(apiKey)) clients.set(apiKey, new Groq({ apiKey, maxRetries: 0, timeout: 60_000 }));
  return clients.get(apiKey);
}

export const forgetClient = apiKey => clients.delete(apiKey);

// Groq keys look like gsk_ followed by letters and digits.
export const looksLikeGroqKey = key => /^gsk_[A-Za-z0-9]{20,}$/.test(key);

// Does Groq accept this key? true, false (rejected), or throws when Groq can't be reached.
export async function checkGroqKey(apiKey) {
  try {
    await new Groq({ apiKey, maxRetries: 1, timeout: 15_000 }).models.list();
    return true;
  } catch (err) {
    if (err.status === 401 || err.status === 403) return false;
    throw err;
  }
}

// Properties are generated in this order, so the model works through the email
// ("reasoning") before it commits to the answers.
const SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    is_job_application_email: { type: 'boolean' },
    stage: { type: 'string', enum: ['applied', 'oa', 'interview', 'offer', 'rejected', 'withdrawn'] },
    company: { type: 'string' },
    role: { type: 'string' },
    job_id: { type: 'string' },
    deadline: { type: 'string' },
    summary: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['reasoning', 'is_job_application_email', 'stage', 'company', 'role', 'job_id', 'deadline', 'summary', 'confidence'],
  additionalProperties: false,
};

const SYSTEM = `You read one email from a job seeker's inbox and work out which of their job applications it is about and what it means for it.

Work through the email before answering, and write that thinking in "reasoning" (2-4 short sentences):
1. Who actually sent it and who is hiring? Hiring software (Workday, Greenhouse, iCIMS, Lever, Ashby, HackerRank, CodeSignal, HireVue, LinkedIn, Indeed) sends on an employer's behalf; find the employer in the subject, greeting, signature, links or body. A staffing agency or recruiter writing about a client counts as the client only if the client is named.
2. What is the email asking the candidate to do, or telling them? Judge by what it says, not by single words: "interview" in a subject can be an assessment, "thank you for applying" can open a rejection, "offer" can mean "offer you the chance to take a test".
3. Which job is it? Look for the title and any requisition/job ID anywhere in the email, including footers and links.

Then fill in:
- is_job_application_email: true only if the email is about the recipient's own application for a job (employment, an internship or a co-op): confirmation, assessment, interview, offer, rejection, withdrawal. false for any other kind of application, however it's worded: apartments and rentals, utilities and bill-splitting services, bank accounts, credit cards and loans, insurance, school or university admissions, scholarships, visas and permits, memberships, and student clubs, societies, fraternities and sororities or volunteer roles, even when they hold "interviews" for "positions" like analyst or treasurer. Also false for job alerts, newsletters, marketing, event invites and recruiter outreach for jobs they didn't apply to. If the email never says it's about a job, it isn't one.
- stage:
  - applied: application received/submitted, or a status update with no new step.
  - oa: anything the candidate completes on their own without a live person: online assessments, coding tests, take-homes, personality or game-based tests, and AI interviews or recorded one-way video interviews (HireVue, Modern Hire, Spark Hire and similar), even when the email calls them an "interview".
  - interview: a conversation with a real person: phone screen, recruiter call, live video, technical or onsite interview, or scheduling one.
  - offer: an actual job offer.
  - rejected: they will not move forward (even if it thanks them for applying or for completing an assessment).
  - withdrawn: the candidate withdrew.
- company: the hiring company's commonly used name as written in the email, e.g. "Fidelity Investments", "Southwest Airlines". Sender addresses like fmr@myworkday.com use internal codes; find the real name in the text. Never the hiring software. Empty string if the email never names the employer.
- role: the job title only, without location, dates or ID. Empty string if not stated.
- job_id: the job/requisition/posting ID copied exactly as written (e.g. "R-574294", "JR2026958", "200046156"). Empty string if none. Never a phone number, zip code, candidate ID or year.
- deadline: when the candidate must act by (complete the assessment, reply, pick a time), as YYYY-MM-DD, worked out from the email's date if it says "within 5 days". Empty string if there is none. Not a date the company promises to reply by.
- summary: one short line saying what the email means for the candidate, e.g. "HireVue video interview to complete by Oct 30", "Rejected after the online assessment", "Application received for Data Analyst Intern".
- confidence: high if the employer and the stage are both clear from the email; medium if you had to infer one of them; low if you are guessing which employer or job this is.`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- is this about a job at all? -------------------------------------------------
// Only asked when the free checks can't tell (see jobcheck.js). A small, fast model and
// a short excerpt, so it costs a fraction of the full read and saves that read entirely
// for the rental and utility emails it turns away.
export const GATE_MODEL = process.env.GROQ_GATE_MODEL || 'llama-3.1-8b-instant';
const GATE_SYSTEM = `You decide whether an email is about the recipient's own application for a JOB (employment, internship, co-op) with an employer.
Answer false for every other kind of application or account: apartments, rentals and housing; utilities and bill-splitting services; banks, credit cards, loans and insurance; schools, admissions and scholarships; visas and permits; memberships and subscriptions; student clubs, societies, fraternities and sororities, even when they "interview" for "positions". Also false for job alerts and newsletters.
Reply with JSON only: {"job": true or false, "why": "a few words"}`;

// true / false, or undefined when Groq can't answer now (the full read then decides).
export async function isJobEmailWithGroq(client, { from, subject, body }) {
  try {
    const res = await client.chat.completions.create({
      model: GATE_MODEL,
      temperature: 0,
      max_completion_tokens: 60,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: GATE_SYSTEM },
        { role: 'user', content: `From: ${from}\nSubject: ${subject}\n\n${body.slice(0, 700)}` },
      ],
    });
    const out = JSON.parse(res.choices[0]?.message?.content || '{}');
    return typeof out.job === 'boolean' ? out.job : undefined;
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err; // the key itself is bad
    if (err.status !== 429) {
      console.warn(`[groq] job check failed: ${err.message}`);
      recordError('groq', err, { level: 'warning', detail: 'The job check; the full read decided instead' });
    }
    return undefined;
  }
}

// ---- which of your applications is it? ----------------------------------------------
// When you have several applications at one company and the email names no role or ID,
// show the model those applications and let it pick, instead of guessing the latest.
const PICK_SCHEMA = {
  type: 'object',
  properties: { reasoning: { type: 'string' }, choice: { type: 'integer' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } },
  required: ['reasoning', 'choice', 'confidence'],
  additionalProperties: false,
};

// Returns the index into `candidates`, or -1 when it can't tell (or Groq can't answer now).
export async function pickApplicationWithGroq(client, { from, subject, body }, candidates) {
  const list = candidates.map((a, i) =>
    `${i}. ${a.role || 'role unknown'}${a.jobId ? ` (job ID ${a.jobId})` : ''}, status ${a.status}, applied ${a.appliedAt.slice(0, 10)}; emails: ${a.subjects.join(' | ') || 'none'}`).join('\n');
  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      reasoning_effort: 'low',
      max_completion_tokens: 600,
      response_format: { type: 'json_schema', json_schema: { name: 'pick_application', strict: true, schema: PICK_SCHEMA } },
      messages: [
        { role: 'system', content: 'A job seeker has several applications at the same company. Decide which one this email is about, using the role, job ID, dates and the subjects of earlier emails. Reply with the number of the application, or -1 if the email could be about more than one of them.' },
        { role: 'user', content: `Applications:\n${list}\n\nEmail:\nFrom: ${from}\nSubject: ${subject}\n\n${body.slice(0, 1500)}` },
      ],
    });
    const out = JSON.parse(res.choices[0]?.message?.content || '{}');
    const i = Number.isInteger(out.choice) ? out.choice : -1;
    return i >= 0 && i < candidates.length && out.confidence !== 'low' ? i : -1;
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err;
    if (err.status !== 429) {
      console.warn(`[groq] picking an application failed: ${err.message}`);
      recordError('groq', err, { level: 'warning', detail: 'Picking between applications; left for the person to check' });
    }
    return -1;
  }
}

// ---- read the email ---------------------------------------------------------------

// Returns {isJob, stage, company, role, jobId, deadline, summary, confidence, reasoning},
// or undefined when Groq can't answer now.
export async function classifyWithGroq(client, { from, subject, date, body }, attempt = 0) {
  if (!client) return undefined;
  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      reasoning_effort: REASONING_EFFORT,
      max_completion_tokens: 2048,
      response_format: { type: 'json_schema', json_schema: { name: 'application_email', strict: true, schema: SCHEMA } },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `From: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${body.slice(0, MAX_BODY_CHARS)}` },
      ],
    });
    const choice = res.choices[0];
    if (choice.finish_reason !== 'stop' || !choice.message.content) return undefined;
    const out = JSON.parse(choice.message.content);
    return {
      isJob: out.is_job_application_email,
      stage: out.stage,
      company: out.company.trim(),
      role: out.role.trim(),
      jobId: out.job_id.trim(),
      deadline: out.deadline.trim(),
      summary: out.summary.trim(),
      confidence: out.confidence,
      reasoning: out.reasoning.trim(),
    };
  } catch (err) {
    if (err.status === 429 && attempt === 0) {
      const wait = Number(err.headers?.['retry-after'] ?? 10);
      if (wait <= MAX_WAIT_SECONDS) {
        await sleep(wait * 1000 + 500);
        return classifyWithGroq(client, { from, subject, date, body }, 1);
      }
      console.warn(`[groq] rate limited for ${wait}s; using rules for this email`);
      recordError('groq', `Rate limited for ${wait}s; read with the rules instead`, { level: 'warning' });
      return undefined;
    }
    throw err;
  }
}
