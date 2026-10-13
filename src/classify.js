import Anthropic from '@anthropic-ai/sdk';
import { classifyWithRules, resolveCompanyName, stripJobId } from './rules.js';
import { classifyWithOllama, ollamaModel } from './ollama.js';

export { classifyWithRules };

// ---------------------------------------------------------------------------
// Claude classifier (used when ANTHROPIC_API_KEY is set — much more accurate)
// ---------------------------------------------------------------------------

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
export const usingClaude = Boolean(client);

const SCHEMA = {
  type: 'object',
  properties: {
    is_job_application_email: {
      type: 'boolean',
      description: 'True only if this email is about one of the recipient\'s own job applications (confirmation, assessment, interview, offer, rejection, withdrawal). False for job alerts, newsletters, recruiter cold outreach about jobs they never applied to, and marketing.',
    },
    stage: { type: 'string', enum: ['applied', 'oa', 'interview', 'offer', 'rejected', 'withdrawn'] },
    company: { type: 'string', description: 'The hiring company (not the ATS vendor such as Greenhouse, Workday or LinkedIn).' },
    role: { type: 'string', description: 'Job title if stated (without the job ID), otherwise empty string.' },
    job_id: { type: 'string', description: 'The job / requisition / posting ID exactly as written (e.g. "R-574294", "JR2026958", "200046156"), otherwise empty string. Never a phone number, zip code or year.' },
  },
  required: ['is_job_application_email', 'stage', 'company', 'role', 'job_id'],
  additionalProperties: false,
};

const SYSTEM = `You sort a job seeker's emails into stages of their application pipeline.
Stages: applied (application received/submitted confirmation), oa (online assessment, coding challenge, take-home), interview (any invitation to or scheduling of a screen or interview), offer, rejected, withdrawn (the candidate withdrew).
If an email mixes signals, pick the most advanced outcome it communicates (e.g. a rejection that thanks them for applying is "rejected").`;

// Email bodies are capped so one huge HTML newsletter can't blow up the request.
const MAX_BODY_CHARS = 12_000;

export async function classifyWithClaude({ from, subject, date, body }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `From: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${body.slice(0, MAX_BODY_CHARS)}`,
    }],
  });
  if (response.stop_reason === 'refusal') return undefined; // fall back to rules
  const text = response.content.find(b => b.type === 'text')?.text;
  if (!text) return undefined;
  const out = JSON.parse(text);
  if (!out.is_job_application_email) return null;
  return { stage: out.stage, company: out.company || 'Unknown company', role: out.role || '', jobId: out.job_id || '' };
}

export function classifierName() {
  if (client) return 'Claude';
  if (ollamaModel()) return `Ollama · ${ollamaModel()}`;
  return 'rules';
}

const squash = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Hiring software that sends on a company's behalf; never the employer itself here.
const VENDORS = /^(workday|greenhouse|icims|lever|ashby|ashbyhq|workable|hackerrank|codesignal|linkedin|indeed|hirevue|shl|modernhire|smartrecruiters|jobvite|taleo|successfactors)$/;

// Combine a small local model's answer with the rules. Tested on real inbox data, a
// 2B model is good at naming the company and role but unreliable at the stage (plain
// confirmations read as "withdrawn" or "rejected") and sometimes garbles IDs. So the
// rules decide the stage and job ID, and the model fills in what the rules can't.
function mergeLocal(llm, rules, email) {
  const raw = `${email.from}\n${email.subject}\n${email.body}`;
  const text = squash(raw);
  if (!llm.isJob && !rules) return null;

  let stage = rules?.stage ?? llm.stage;
  // Rules sometimes read "interview" from boilerplate in a confirmation body; when the
  // subject doesn't mention one and the model sees no interview, believe the model.
  if (rules?.stage === 'interview' && llm.isJob && ['applied', 'oa'].includes(llm.stage) &&
      !/\binterview\b/i.test(email.subject)) {
    stage = llm.stage;
  }
  if (!rules && (stage === 'offer' || stage === 'withdrawn')) stage = 'applied'; // too risky unconfirmed

  const companyOk = llm.company && !/^unknown/i.test(llm.company) && !VENDORS.test(squash(llm.company)) &&
    text.includes(squash(llm.company));
  // Only an ID-shaped token that appears whole in the email (not "Summer 2027-590403").
  const jobIdOk = /^[A-Z]{0,4}-?\d[\d-]{3,}$/i.test(llm.jobId) &&
    new RegExp(String.raw`(?<![\w-])${llm.jobId.replace(/-/g, '\\-')}(?![\w-])`).test(raw);
  const jobId = rules?.jobId || (jobIdOk ? llm.jobId : '');
  // Real titles start with a capital or digit; "additional internship opportunities
  // that..." is the model quoting a sentence.
  const llmRole = /^[A-Z0-9]/.test(llm.role) && llm.role.length <= 100 ? llm.role : '';
  return {
    stage,
    company: companyOk ? llm.company : rules?.company || llm.company || 'Unknown company',
    role: stripJobId(llmRole || rules?.role || '', jobId),
    jobId,
  };
}

// Returns {stage, company, role, jobId}, or null when the email isn't about an application.
export async function classify(email) {
  let result;
  if (client) {
    try {
      result = await classifyWithClaude(email);
    } catch (err) {
      console.warn(`[classify] Claude call failed, falling back: ${err.message}`);
    }
  }
  if (result === undefined && ollamaModel()) {
    try {
      const llm = await classifyWithOllama(email);
      if (llm) result = mergeLocal(llm, classifyWithRules(email), email);
    } catch (err) {
      console.warn(`[classify] Ollama call failed, using rules: ${err.message}`);
    }
  }
  if (result === undefined) result = classifyWithRules(email);
  if (result) result.company = resolveCompanyName(result.company);
  return result;
}
