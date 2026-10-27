// Is an email about a job application at all? Cheap checks that run before the rules
// or any AI. "Thank you for your application" also comes from landlords, utilities,
// banks and schools; those must never become applications in the tracker.

// Hiring software: everything it sends is about a job. Entries are domains (any
// subdomain counts) or exact addresses for senders that also send unrelated mail.
// Platforms that also run payroll or HR (Rippling, BambooHR, ADP, Paylocity...) aren't
// here: their emails have to show they're about a job like anyone else's.
export const HIRING_SENDERS = [
  'greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'myworkday.com', 'myworkdayjobs.com', 'ashbyhq.com',
  'smartrecruiters.com', 'icims.com', 'jobvite.com', 'workablemail.com', 'workable.com', 'successfactors.com',
  'taleo.net', 'hackerrank.com', 'hackerrankforwork.com', 'codesignal.com', 'hirevue.com', 'modernhire.com',
  'applytojob.com', 'breezy.hr', 'recruitee.com', 'teamtailor.com', 'pinpointhq.com', 'avature.net',
  'paradox.ai', 'eightfold.ai', 'shl.com', 'sparkhire.com', 'codility.com', 'hiringplatform.com',
  'jobs-noreply@linkedin.com', 'indeedapply@indeed.com',
];

// Free email providers and big platforms: never the employer, and never something
// to block wholesale (a recruiter may write from Gmail).
const SHARED_DOMAINS = /(^|\.)(gmail|googlemail|outlook|hotmail|live|msn|yahoo|icloud|me|aol|proton|protonmail|linkedin|indeed|google|microsoft|apple|amazon)\.[a-z.]+$/i;

export function senderAddress(from = '') {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

export function senderDomain(from = '') {
  return senderAddress(from).split('@')[1] || '';
}

export function fromHiringSoftware(from) {
  const address = senderAddress(from);
  const domain = address.split('@')[1] || '';
  return HIRING_SENDERS.some(s => s.includes('@') ? address === s : domain === s || domain.endsWith(`.${s}`));
}

// A sender domain someone can choose to ignore everything from.
export const canBlockDomain = domain =>
  /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) && !SHARED_DOMAINS.test(domain) &&
  !HIRING_SENDERS.some(s => !s.includes('@') && (domain === s || domain.endsWith(`.${s}`)));

// Words that say this is about work...
const JOB_WORDS = /\b(position|positions|role|job|jobs|candidate|candidacy|recruit(er|ers|ing|ment)|hiring|hire|resume|résumé|cv|careers?|requisition|req id|interview(s|ing)?|internship|intern|co-?op|employment|employer|talent acquisition|opening|vacancy|applicant tracking|job id|hiring manager|onsite|phone screen|offer letter|engineer(ing)?|developer|analyst|scientist|associate|designer|consultant|specialist)\b/gi;
// ...and words that say it's another kind of application: housing, utilities, money,
// school, government, memberships, student clubs (which recruit with job words like
// "interview" and "position", so a club email lands on "unsure"). Phrases rather than single words where a word could
// be an employer's name or sit in every footer ("Visa", "State Farm Insurance", "Privacy Policy").
const NON_JOB_WORDS = /\b(lease|leasing|apartments?|tenants?|rental|renters?|landlord|property management|move-in date|utilit(y|ies)|electricity|electric service|water service|gas service|internet service|your bill|bills|billing|autopay|payment method|(loan|mortgage|credit|card|refinance|account|insurance|visa|passport|permit|membership|adoption|housing|admissions?|scholarship|financial aid) application|credit card|credit check|account opening|checking account|savings account|insurance (policy|quote|coverage)|admissions office|enrollment|tuition|financial aid|fafsa|scholarship|(student|investment|finance|financial|consulting|business|economics|trading|quant|entrepreneurship|engineering|robotics|coding|programming|data science|ai|machine learning|tech|technology|marketing|pre-?law|pre-?med|debate|honors?) (club|guild|society|association|organization)|student (org|chapter|government)|executive board|general (body|member(ship)?) meeting|fraternity|sorority|rush week|club (members?|membership|officers?))\b/gi;

const count = (re, text) => (text.match(re) || []).length;

// verdict: 'job' (clearly about a job), 'not_job' (clearly another kind of
// application), or 'unsure'. `why` says which words decided it, for the review note.
export function jobSignal({ from = '', subject = '', body = '' }) {
  if (fromHiringSoftware(from)) return { verdict: 'job', why: 'sent by hiring software' };
  const text = `${subject}\n${body.slice(0, 2500)}`;
  const job = count(JOB_WORDS, text);
  const notJob = count(NON_JOB_WORDS, text);
  const nonJobWord = text.match(NON_JOB_WORDS)?.[0]?.toLowerCase();
  if (!job && !notJob) return { verdict: 'unsure', why: 'never says what the application is for' };
  if (notJob && !job) return { verdict: 'not_job', why: `mentions "${nonJobWord}" and nothing about a job` };
  if (job && !notJob) return { verdict: 'job', why: 'mentions a job' };
  // Both: whichever is clearly stronger wins; close calls stay unsure.
  if (job >= notJob * 3) return { verdict: 'job', why: 'mostly about a job' };
  if (notJob >= job * 3) return { verdict: 'not_job', why: `mostly about "${nonJobWord}"` };
  return { verdict: 'unsure', why: job ? `mentions a job but also "${nonJobWord}"` : 'never says what the application is for' };
}
