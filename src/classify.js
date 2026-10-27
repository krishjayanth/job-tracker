import { classifyWithRules, resolveCompanyName, stripJobId, extractDeadline, rejectionWords, AI_INTERVIEW } from './rules.js';
import { classifyWithGroq, isJobEmailWithGroq, MODEL } from './groq.js';
import { jobSignal, senderAddress } from './jobcheck.js';
import { recordError } from './errors.js';

export { classifyWithRules };

export function classifierName(groq) {
  return groq ? `Groq · ${MODEL.replace(/^openai\//, '')}` : 'rules';
}

const squash = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Hiring software that sends on a company's behalf; never the employer itself here.
const VENDORS = /^(workday|greenhouse|icims|lever|ashby|ashbyhq|workable|hackerrank|codesignal|linkedin|indeed|hirevue|shl|modernhire|sparkhire|smartrecruiters|jobvite|taleo|successfactors)$/;
const UNKNOWN = 'Unknown company';
const STAGE_WORDS = { applied: 'an application update', oa: 'an assessment', interview: 'an interview', offer: 'an offer', withdrawn: 'a withdrawal' };
const DAY = 86_400_000;

// The model's "YYYY-MM-DD" deadline, if it's a real date shortly after the email.
function llmDeadline(value, emailDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return '';
  const when = new Date(+m[1], +m[2] - 1, +m[3], 23, 59);
  const base = Date.parse(emailDate);
  return when >= base - DAY && when - base < 60 * DAY ? when.toISOString() : '';
}

// Cross-check the model against the rules. The model reads the email as a whole;
// the rules are narrow but precise. A company or job ID is only accepted if it actually
// appears in the email, and the rules' rejection/offer checks act as guard rails.
// Anything the two can't settle between them is flagged for you to confirm.
export function mergeWithRules(llm, rules, email) {
  if (!llm.isJob) return null;
  const raw = `${email.from}\n${email.subject}\n${email.body}`;
  const text = squash(raw);
  const review = [];

  let stage = llm.stage;
  // The rules' rejection check wins, but say so: if its words were a false alarm, you'll see them.
  if (rules?.stage === 'rejected' && stage !== 'rejected') {
    review.push({ about: 'stage', text: `Read as a rejection because the email says "${rejectionWords(email)}", though it otherwise reads as ${STAGE_WORDS[stage] || stage}.` });
    stage = 'rejected';
  }
  if (stage === 'offer' && rules?.stage !== 'offer' && !/\b(offer|congratulations)\b/i.test(email.subject)) {
    stage = rules?.stage ?? 'applied';
  }
  if (stage === 'withdrawn' && !/withdr[ae]w/i.test(raw)) stage = rules?.stage ?? 'applied';
  if (stage === 'interview' && AI_INTERVIEW.test(raw)) stage = 'oa';
  if (rules?.stage && rules.stage !== stage && llm.confidence !== 'high') {
    review.push({ about: 'stage', text: `Unclear what stage this is: read as ${stage}, but the wording also suggests ${rules.stage}.` });
  }

  const companyOk = llm.company && !/^unknown/i.test(llm.company) && !VENDORS.test(squash(llm.company)) &&
    text.includes(squash(llm.company));
  const company = companyOk ? llm.company : rules?.company || llm.company || UNKNOWN;
  if (llm.company && !companyOk && squash(llm.company) !== squash(company)) {
    review.push({ about: 'application', text: `Unclear which company this is: read as "${llm.company}", filed under "${company}".` });
  }
  // Only an ID-shaped token that appears whole in the email.
  const jobIdOk = /^[A-Z]{0,4}-?\d[\d-]{3,}$/i.test(llm.jobId) &&
    new RegExp(String.raw`(?<![\w-])${llm.jobId.replace(/-/g, '\-')}(?![\w-])`).test(raw);
  const jobId = rules?.jobId || (jobIdOk ? llm.jobId : '');
  // Real titles start with a capital or digit; anything else is the model quoting a sentence.
  const llmRole = /^[A-Z0-9]/.test(llm.role) && llm.role.length <= 100 ? llm.role : '';
  if (llm.confidence === 'low') review.push({ about: 'application', text: 'The model was guessing which application this is.' });
  return {
    stage,
    company,
    role: stripJobId(llmRole || rules?.role || '', jobId),
    jobId,
    deadline: llmDeadline(llm.deadline, email.date),
    summary: llm.summary.slice(0, 160),
    reasoning: llm.reasoning.slice(0, 600),
    review,
  };
}

// Classify with this person's Groq client, or the rules alone when they have none.
// onKeyRejected runs if Groq refuses the key, so they can be told to replace it.
// Returns {stage, company, role, jobId, deadline, summary?, reasoning?, review}, or null
// when the email isn't about an application. `review` lists reasons to double-check it: {about: 'application' | 'stage', text}.
//
// In steps, cheapest first:
//   1. free checks: is this about a job at all? (jobcheck.js) Clear non-jobs stop here.
//   2. if that's unclear and there's a key, a small model answers just that question.
//   3. the full read (Groq, cross-checked by the rules), or the rules alone.
// Which application it belongs to is settled afterwards, in gmail.js.
// `self` is your own address: an email you sent (a reply to a recruiter) is never filed.
export async function classify(email, { groq = null, self = null, onKeyRejected, userId = null } = {}) {
  if (self && senderAddress(email.from) === self.trim().toLowerCase()) return null;
  const signal = jobSignal(email);
  if (signal.verdict === 'not_job') return null;
  let result;
  let gateSaidJob = false;
  if (groq) {
    try {
      if (signal.verdict === 'unsure') {
        const isJob = await isJobEmailWithGroq(groq, email);
        if (isJob === false) return null;
        gateSaidJob = isJob === true;
      }
      const llm = await classifyWithGroq(groq, email);
      if (llm) result = mergeWithRules(llm, classifyWithRules(email), email);
    } catch (err) {
      if (err.status === 401 || err.status === 403) onKeyRejected?.();
      else {
        console.warn(`[classify] Groq call failed, using rules: ${err.message}`);
        recordError('groq', err, { userId, level: 'warning', detail: 'Read with the rules instead' });
      }
    }
  }
  if (result === undefined) {
    result = classifyWithRules(email);
    if (result) result.review = [];
  }
  if (result) {
    // Nothing (no hiring software, no job words, no AI) vouched for it being a job.
    if (signal.verdict === 'unsure' && !gateSaidJob && !result.reasoning) {
      result.review.push({ about: 'application', text: `Not sure this is about a job: the email ${signal.why}. If it's a rental, utility or other non-job application, choose "Not a job".` });
    }
    result.company = resolveCompanyName(result.company);
    if (result.company === UNKNOWN) result.review.push({ about: 'application', text: "Couldn't tell which company this email is from." });
    if (result.stage === 'rejected' || result.stage === 'withdrawn') {
      result.deadline = '';
    } else {
      // The rules find dates written out in the email; the model also works out "within 5 days".
      result.deadline = extractDeadline(`${email.subject}\n${email.body}`, email.date) || result.deadline || '';
    }
  }
  return result;
}
