// Local LLM classifier via Ollama (https://ollama.com). Free, and emails never leave
// this machine. Used automatically when Ollama is running with a chat model installed.

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const DISABLED = process.env.USE_OLLAMA === '0';
const MAX_BODY_CHARS = 6_000; // keeps small models fast and focused

let model = null;

// Pick OLLAMA_MODEL if set, otherwise the first installed chat (non-embedding) model.
export async function detectOllama() {
  if (DISABLED) return null;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const { models = [] } = await res.json();
    const names = models.map(m => m.name);
    const wanted = process.env.OLLAMA_MODEL;
    if (wanted) {
      model = names.find(n => n === wanted || n === `${wanted}:latest`) ?? null;
      if (!model) console.warn(`[ollama] model "${wanted}" not installed (run: ollama pull ${wanted})`);
    } else {
      model = models.find(m => !/embed/i.test(m.name) && !(m.details?.family || '').includes('bert'))?.name ?? null;
    }
  } catch {
    model = null; // Ollama not running
  }
  return model;
}

export const ollamaModel = () => model;

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
};

const SYSTEM = `You extract facts from a job seeker's email about one of their job applications. Reply with JSON only.

Fields:
- is_job_application_email: true if the email is about the recipient's own job application (confirmation, assessment, interview, offer, rejection, withdrawal). false for job alerts, newsletters, marketing.
- stage: applied (application received/submitted), oa (online assessment, coding test, HireVue/video assessment), interview (invitation to or scheduling of an interview or phone screen), offer (a job offer), rejected, withdrawn.
  A rejection that thanks them for applying is "rejected".
- company: the hiring company's real, commonly used name as written in the email text, e.g. "Fidelity Investments", "Southwest Airlines", "AT&T".
  Sender addresses like fmr@myworkday.com or swa@myworkday.com use internal codes; ignore the code and find the company name in the email.
  Never answer with the hiring software (Workday, Greenhouse, iCIMS, Lever, HackerRank, LinkedIn).
- role: the job title only, without location, dates or ID. Empty string if not stated.
- job_id: the job/requisition/posting ID copied exactly from the email (e.g. "R-574294", "JR2026958", "200046156"). Empty string if none. Never a phone number, zip code or year.`;

// Returns {isJob, stage, company, role, jobId}, or undefined if the call fails.
export async function classifyWithOllama({ from, subject, date, body }) {
  if (!model) return undefined;
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: SCHEMA,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `From: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${body.slice(0, MAX_BODY_CHARS)}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = JSON.parse((await res.json()).message.content);
  return {
    isJob: Boolean(out.is_job_application_email),
    stage: out.stage,
    company: (out.company || '').trim(),
    role: (out.role || '').trim(),
    jobId: (out.job_id || '').trim(),
  };
}
