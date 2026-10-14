import { classifyWithRules, resolveCompanyName, stripJobId, extractDeadline } from './rules.js';
import { classifyWithGroq, groqModel } from './groq.js';

export { classifyWithRules };

export function classifierName() {
  return groqModel() ? `Groq · ${groqModel().replace(/^openai\//, '')}` : 'rules';
}

const squash = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Hiring software that sends on a company's behalf; never the employer itself here.
const VENDORS = /^(workday|greenhouse|icims|lever|ashby|ashbyhq|workable|hackerrank|codesignal|linkedin|indeed|hirevue|shl|modernhire|smartrecruiters|jobvite|taleo|successfactors)$/;

// Cross-check the model against the rules. The model reads the email as a whole;
// the rules are narrow but precise. A company or job ID is only accepted if it actually
// appears in the email, and the rules' rejection/offer checks act as guard rails.
function mergeWithRules(llm, rules, email) {
  if (!llm.isJob) return null;
  const raw = `${email.from}\n${email.subject}\n${email.body}`;
  const text = squash(raw);

  let stage = llm.stage;
  if (rules?.stage === 'rejected') stage = 'rejected';
  if (stage === 'offer' && rules?.stage !== 'offer' && !/\b(offer|congratulations)\b/i.test(email.subject)) {
    stage = rules?.stage ?? 'applied';
  }
  if (stage === 'withdrawn' && !/withdr[ae]w/i.test(raw)) stage = rules?.stage ?? 'applied';

  const companyOk = llm.company && !/^unknown/i.test(llm.company) && !VENDORS.test(squash(llm.company)) &&
    text.includes(squash(llm.company));
  // Only an ID-shaped token that appears whole in the email.
  const jobIdOk = /^[A-Z]{0,4}-?\d[\d-]{3,}$/i.test(llm.jobId) &&
    new RegExp(String.raw`(?<![\w-])${llm.jobId.replace(/-/g, '\\-')}(?![\w-])`).test(raw);
  const jobId = rules?.jobId || (jobIdOk ? llm.jobId : '');
  // Real titles start with a capital or digit; anything else is the model quoting a sentence.
  const llmRole = /^[A-Z0-9]/.test(llm.role) && llm.role.length <= 100 ? llm.role : '';
  return {
    stage,
    company: companyOk ? llm.company : rules?.company || llm.company || 'Unknown company',
    role: stripJobId(llmRole || rules?.role || '', jobId),
    jobId,
  };
}

// Returns {stage, company, role, jobId, deadline}, or null when the email isn't about an application.
export async function classify(email) {
  let result;
  if (groqModel()) {
    try {
      const llm = await classifyWithGroq(email);
      if (llm) result = mergeWithRules(llm, classifyWithRules(email), email);
    } catch (err) {
      console.warn(`[classify] Groq call failed, using rules: ${err.message}`);
    }
  }
  if (result === undefined) result = classifyWithRules(email);
  if (result) {
    result.company = resolveCompanyName(result.company);
    if (result.stage !== 'rejected' && result.stage !== 'withdrawn') {
      result.deadline = extractDeadline(`${email.subject}\n${email.body}`, email.date);
    }
  }
  return result;
}
