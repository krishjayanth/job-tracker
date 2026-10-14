// LLM classifier via GroqCloud (https://console.groq.com). Used when GROQ_API_KEY is set.
// Default model: openai/gpt-oss-20b, with strict JSON-schema output.
import Groq from 'groq-sdk';

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const client = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY, maxRetries: 0 }) : null;

// The free tier allows ~8K tokens/minute and ~200K/day for this model, so keep each
// request lean: an excerpt of the email (where the facts are), low reasoning effort.
const MAX_BODY_CHARS = 3_000;
const MAX_WAIT_SECONDS = 60; // longer than this and we use the rules for this email instead

export const groqModel = () => (client ? MODEL : null);

const SCHEMA = {
  type: 'object',
  properties: {
    is_job_application_email: { type: 'boolean' },
    stage: { type: 'string', enum: ['applied', 'oa', 'interview', 'offer', 'rejected', 'withdrawn'] },
    company: { type: 'string' },
    role: { type: 'string' },
    job_id: { type: 'string' },
  },
  required: ['is_job_application_email', 'stage', 'company', 'role', 'job_id'],
  additionalProperties: false,
};

const SYSTEM = `You extract facts from a job seeker's email about one of their own job applications.

- is_job_application_email: true if the email is about the recipient's own application (confirmation, assessment, interview, offer, rejection, withdrawal). false for job alerts, newsletters, marketing and recruiter outreach for jobs they didn't apply to.
- stage: applied (application received/submitted), oa (online assessment, coding test, HireVue or recorded video assessment), interview (invitation to or scheduling of an interview or phone screen), offer (an actual job offer), rejected, withdrawn (the candidate withdrew). A rejection that thanks them for applying is "rejected".
- company: the hiring company's commonly used name as written in the email, e.g. "Fidelity Investments", "Southwest Airlines". Sender addresses like fmr@myworkday.com use internal codes; find the real name in the text. Never the hiring software (Workday, Greenhouse, iCIMS, Lever, Ashby, HackerRank, LinkedIn).
- role: the job title only, without location, dates or ID. Empty string if not stated.
- job_id: the job/requisition/posting ID copied exactly as written (e.g. "R-574294", "JR2026958", "200046156"). Empty string if none. Never a phone number, zip code or year.`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Returns {isJob, stage, company, role, jobId}, or undefined when Groq can't answer now.
export async function classifyWithGroq({ from, subject, date, body }, attempt = 0) {
  if (!client) return undefined;
  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      reasoning_effort: 'low',
      max_completion_tokens: 1024,
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
    };
  } catch (err) {
    if (err.status === 429 && attempt === 0) {
      const wait = Number(err.headers?.['retry-after'] ?? 10);
      if (wait <= MAX_WAIT_SECONDS) {
        await sleep(wait * 1000 + 500);
        return classifyWithGroq({ from, subject, date, body }, 1);
      }
      console.warn(`[groq] rate limited for ${wait}s; using rules for this email`);
      return undefined;
    }
    throw err;
  }
}
