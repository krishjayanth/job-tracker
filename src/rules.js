// Rule-based email classifier (always available, no API key needed).
// Tuned against real confirmation/assessment/interview/rejection emails from
// Workday, iCIMS, Greenhouse, Ashby, Workable, HackerRank, CodeSignal and direct senders.

// Checked in order; first match wins. Rejections often open with "thank you for
// applying", so they're checked before the plain confirmation rule. The offer rule
// needs an actual offer of a job; "excited to offer you the chance to take an
// assessment" isn't one.
const RULES = [
  ['offer', /\b(pleased|excited|happy|delighted|thrilled) to (extend|offer) (you )?(a |an |the |our )?(formal |verbal |official |conditional )?(offer|position|role|internship|job|employment)\b|\boffer letter\b|\boffer of employment\b|\bjob offer\b|\b(formal|verbal|conditional) offer\b/i],
  ['rejected', /\bunfortunately\b|\bnot (to )?(be )?mov(e|ing) forward\b|\b(decided|chosen) to (pursue|proceed|move forward) with other\b|\bother candidates\b|\bnot been selected\b|\bno longer (being )?considered\b|\bposition has been filled\b|\bwill not be (proceeding|progressing)\b|\bregret to inform\b|\bnot a match at this time\b/i],
  ['withdrawn', /\b(you|you've|you have) (have )?withdrawn your (job )?application\b|\bapplication (has been |was )?withdrawn\b|\bwithdrawal of your application\b|\bconfirm(ing)? (that )?you('ve| have)? withdr[ae]wn?\b/i],
  ['oa', /\b(online|technical|coding|skills?) (assessment|challenge|test)\b|\bhackerrank\b|\bcodesignal\b|\bcodility\b|\btake[- ]home\b|\bhirevue\b|\bmodern ?hire\b|\bspark ?hire\b|\bharqen\b|\b(ai|one-way|recorded|pre-recorded|asynchronous|async|on-demand|digital) (video )?interview\b|\bcomplete (the|an|your) assessment\b|\bassessment (link|invitation)\b|\b(pre-employment|cognitive) assessment\b|\binvited to (an? |the )?[\w -]{0,30}assessment\b/i],
  ['interview', /\b(schedule|invite you to|invitation to|availability for|book) (an? |your |a time for (an? |your )?)?(phone |video |virtual |onsite |on-site |technical |final |first )?(round )?(interview|screen|call|chat|conversation)\b|\binterview (invitation|request|confirmation|scheduled)\b|\bphone screen\b|\bnext round\b/i],
  ['applied', /\bthank(s| you) for (your )?(applying|application|interest|submitting)\b|\bapplication (has been |was )?(received|submitted|sent)\b|\bwe('ve| have) received your (job )?application\b|\bsuccessfully (applied|submitted)\b|\byour application (to|for|was sent)\b|\b(started|complete) your (job )?application\b|\breceived your [\w .&'-]{1,40} application\b/i],
];

// Interviews with no person on the other end (an AI, or a recorded one-way video on
// HireVue and the like) work like assessments: you complete them on your own by a deadline.
export const AI_INTERVIEW = /\b(ai|one-way|recorded|pre-recorded|asynchronous|async|on-demand|digital) (video )?interview\b|\bhirevue\b|\bmodern ?hire\b|\bspark ?hire\b|\bharqen\b/i;

// Where a captured company name ends inside a subject line.
const END = String.raw`(?=[!,|;?]|\.(?:\s|$)|:\s| [-–—] | for | with | and its |$)`;

const SUBJECT_COMPANY = [
  new RegExp(String.raw`application was sent to (.+?)${END}`, 'i'),
  /^(.+?) (?:invites|has invited) you\b/i,
  new RegExp(String.raw`\b(?:applying|applied|application|interest|interviewing|apply) (?:to|at|with|in)(?: joining)? (.+?)${END}`, 'i'),
  new RegExp(String.raw`\bthank you from (.+?)${END}`, 'i'),
  /:\s*(.+?) (?:(?:beginner|coding|online|technical) )*assessment\b/i,
  /\b(?:hackerrank|codesignal) (.+?) (?:(?:beginner|coding|online|technical) )*assessment\b/i,
  /\byour (?:recent )?(.+?) (?:job )?application\b/i,
  new RegExp(String.raw`\bat (.+?)${END}`, 'i'),
  /^(.+?) (?:(?:online|coding|technical|skills?|video|phone) )?(?:application|interview|assessment)\b/i,
  /^([^:–|]{2,40}?)\s*(?::|–|\||\s-)\s*/,
  new RegExp(String.raw`(?:interview|assessment|offer) (?:with|from|at) (.+?)${END}`, 'i'),
];
const BODY_COMPANY = [
  new RegExp(String.raw`\b(?:applying|applied|application|interest) (?:to|at|with|in)(?: joining)? (.+?)${END}`, 'i'),
];

// Words that mean a capture is a phrase, a job title or a sender label rather than a company.
const NOT_COMPANY = /(?<![\w&])(your|you|we|our|on|have|has|to|at|in|is|are|complete|completed|update|the|for|received|thank|thanks|regarding|re|fwd|action|required|assessment|application|job|jobs|intern|internship|engineer|engineering|software|developer|program|position|role|early|global|technology|summer|recent|careers?|opportunit(y|ies)|coding|next|steps|invit(e|ation)|company|hello|hi|reminder)(?![\w&])/i; // "AT&T" isn't the word "at"

function looksLikeCompany(s) {
  return Boolean(s) && s.length <= 40 && s.split(/\s+/).length <= 5 && /^[\w(]/.test(s) && !/[|:]/.test(s) && !NOT_COMPANY.test(s);
}

// Strip sender labels like "Talent Acquisition", "@ icims", "HR Workday", "Do Not Reply".
function cleanCompany(s) {
  return s
    .replace(/_/g, ' ')
    .replace(/\s*@.*$/, '')
    .replace(/(HR|Workday)(?=[A-Z]|\b)/g, ' ')
    .replace(/\b(recruiting|recruitment|coordinator|careers?|talent( acquisition| team)?|hiring( team)?|people( team)?|early careers|human resources|hr|team|notifications?|notify|do ?not ?reply|donotreply|no-?reply|workday|icims|via \w+|action may be required)\b/gi, ' ')
    .replace(/[()"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–:,|.]+|[\s\-–:,|]+$/g, '')
    .trim();
}

const squash = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);

const ATS_DOMAINS = /(greenhouse(-mail)?\.io|lever\.co|myworkday(jobs)?\.com|ashbyhq\.com|smartrecruiters\.com|icims\.com|jobvite\.com|workablemail\.com|workable\.com|successfactors\.com|taleo\.net|linkedin\.com|indeed\.com|hackerrank(forwork)?\.com|codesignal\.com|newtonsoftware\.com|oracle\.com|obrajobs\.com|modernhire\.com|hirevue\.com|hiringplatform\.com|shl\.com|paycomonline\.(net|com)|vssend\.com|gmail\.com|outlook\.com)$/i;
// Relay services that put the company in a subdomain: careers@lockheedmartin.vssend.com
const SUBDOMAIN_RELAYS = /\.(vssend\.com)$/i;

// Hiring-software vendors that send on a company's behalf ("SHL", "CodeSignal").
const VENDOR = /^(greenhouse|lever|workday|icims|ashby|workable|hackerrank|codesignal|shl|hirevue|modernhire|linkedin|indeed)$/i;

function companyFromSender(fromHeader) {
  const m = fromHeader.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/) || [null, '', fromHeader];
  const display = cleanCompany(m[1] || '');
  const [local = '', domain = ''] = (m[2] || '').trim().toLowerCase().split('@');
  const localName = local.split('+')[0];

  // Workday sends from <company>@myworkday.com; the display name is often noise.
  if (/myworkday/.test(domain) && localName && !/^(workday|no-?reply)$/.test(localName)) {
    return squash(display).startsWith(localName) ? display : capitalize(localName);
  }
  if (looksLikeCompany(display) && !VENDOR.test(display)) return display;
  if (SUBDOMAIN_RELAYS.test(domain)) return capitalize(domain.split('.')[0]);
  if (domain && !ATS_DOMAINS.test(domain)) {
    const parts = domain.split('.');
    return capitalize(parts.length > 2 ? parts.at(-2) : parts[0]);
  }
  return '';
}

function firstCompany(text, patterns) {
  for (const re of patterns) {
    const raw = text.match(re)?.[1];
    if (!raw) continue;
    // A capture that is only a label word (e.g. "at Workday") keeps its raw form.
    const name = cleanCompany(raw) || raw.trim();
    if (looksLikeCompany(name)) return name;
  }
  return '';
}

// ---- role ---------------------------------------------------------------

const ROLE_WORD = /\b(intern|internship|engineer|engineering|developer|development|analyst|scientist|software|co-?op|associate|program|designer|researcher|technolog\w*|quant\w*|trader|consultant|manager|specialist|fellow(ship)?)\b/i;
const NOT_ROLE = /\b(your|thank|thanks|application|applying|apply|interest|completion|assessment|invitation|taking|time)\b/i;
// Wrapped in a lookahead so matches can overlap: in "for taking the time to submit
// your application for X", the second "for" must get its own chance.
const ROLE_PATTERN = /(?=\b(?:role of|position of|application for|applying for|applied for|apply for|for the|for our|for)\s+(?:the\s+)?(.+?)(?= at | with |[!|]|\.(?:\s|$)| - \d|$))/gi;

function cleanRole(s) {
  return s
    .replace(/^((our|this|the|an?|open|position:|role:|role of|position of)\s+)+/i, '')
    .replace(/^(R-?\d[\w-]*|\d{4,})\s*[-–:]?\s*/i, '')
    .replace(/\s+(role|position|opening)(\s+(at|with|has|is|was)\s.*)?$/i, '')
    .replace(/\s*[-–]\s*\d{4,}$/, '')
    .replace(/\s+invitation$/i, '')
    .trim();
}

function extractRole(subject, body, company, jobId) {
  const candidates = [
    ...[...subject.matchAll(ROLE_PATTERN)].map(m => m[1]),
    ...subject.split(/ [-–—|] |: /),
    ...[...body.slice(0, 600).matchAll(ROLE_PATTERN)].map(m => m[1]),
  ];
  for (const c of candidates) {
    const role = stripJobId(cleanRole(c), jobId);
    if (role.includes(' ') && role.length <= 80 && ROLE_WORD.test(role) && !NOT_ROLE.test(role) && squash(role) !== squash(company)) {
      return role;
    }
  }
  return '';
}

// ---- job / requisition ID ---------------------------------------------------

const JOB_ID_PATTERNS = [
  // "Job number: 200046156", "Requisition ID: R412939", "Ref: 128497", "the JobID for this job is 4521"
  /\b(?:job\s*(?:id|number|no\.?|#)|jobid|requisition(?:\s*(?:id|number|#))?|req\s*(?:id|#|no\.?)|ref(?:erence)?(?:\s*(?:id|number|#))?|posting\s*(?:id|number))(?:\s+for this job)?(?:\s+is)?\s*[:#]?\s*([A-Z]{0,3}-?\d[\d-]{3,})/i,
  // Workday-style: R-574294, R0120133, R-2026-73270, JR2026958, REQ-1234
  /(?<!\w)((?:JR|REQ|R)-?\d{4,}(?:-\d+)?)\b/,
  // Year-prefixed: 2026-126228 (but not "Summer 2027-590403", handled below)
  /(?<!(?:Summer|Fall|Spring|Winter|Autumn)\s)\b(20\d{2}-\d{4,})\b/,
];
// Bare 5-9 digit numbers next to a role title: "Co-op - 39908", "Intern (12150)",
// "AI Innovation, 364696", "position of 2134524 Summer", "Summer 2027-590403".
const BARE_JOB_ID = /(?:[-–,(#]\s*|\b(?:of|to)\s)(\d{5,9})\b/;

export function extractJobId(subject, body) {
  const head = body.slice(0, 1500);
  for (const re of JOB_ID_PATTERNS) {
    const id = subject.match(re)?.[1] || head.match(re)?.[1];
    if (id) return id.replace(/-+$/, '');
  }
  return subject.match(BARE_JOB_ID)?.[1] || body.slice(0, 500).match(BARE_JOB_ID)?.[1] || '';
}

// ---- deadlines ----------------------------------------------------------------

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fourteen: 14 };

// A sentence has to sound like an instruction to you ("complete by", "expires in"),
// not a promise from them ("we'll get back to you within 5 days").
const DEADLINE_CUE = /\b(expires?|expiring|expiration|deadline|due|complete|submit|finish|take (?:it|the|your)|respond|action|access|before|by|until|no later than|within)\b/i;
const THEIR_PROMISE = /\b(get back to you|hear from (?:us|you)|be in touch|reach out|we(?:'ll| will| aim| typically| usually)?\s+(?:review|respond|contact|follow up|get back|be in touch|reach out))\b/i;

const MONTH_DATE = /\b(?:by|before|until|no later than|due(?: on| by)?|deadline(?: is|:)?|expires?(?: on)?|expiration(?: date)?:?|on)\s+(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?(?:\s*(?:at|@|,)?\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?)?/i;
const NUMERIC_DATE = /\b(?:by|before|until|due(?: on| by)?|deadline:?|expires?(?: on)?)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i;
const RELATIVE = /\b(?:in|within|next)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|fourteen)\s+(?:business\s+|calendar\s+)?(hours?|days?|weeks?)\b/i;

function atEndOfDay(d) { d.setHours(23, 59, 0, 0); return d; }

// Returns an ISO date for "the thing you must do by", or '' if the email has none.
export function extractDeadline(text, emailDate) {
  const base = new Date(emailDate);
  const sentences = text.slice(0, 5000).split(/(?<=[.!?])\s+|\n+/);
  for (const s of sentences) {
    if (!DEADLINE_CUE.test(s) || THEIR_PROMISE.test(s)) continue;
    let when = null;
    let m;
    if ((m = s.match(MONTH_DATE))) {
      const year = m[3] ? Number(m[3]) : base.getFullYear();
      when = new Date(year, MONTHS[m[1].toLowerCase()], Number(m[2]));
      if (m[4]) {
        let h = Number(m[4]) % 12;
        if (m[6].toLowerCase() === 'p') h += 12;
        when.setHours(h, Number(m[5] || 0), 0, 0);
      } else {
        atEndOfDay(when);
      }
      if (!m[3] && when < base - 2 * 86_400_000) when.setFullYear(year + 1); // "Jan 5" seen in December
    } else if ((m = s.match(NUMERIC_DATE))) {
      const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : base.getFullYear();
      when = atEndOfDay(new Date(year, Number(m[1]) - 1, Number(m[2])));
    } else if ((m = s.match(RELATIVE)) && /\b(expire|due|deadline|complete|submit|finish|action|access|respond|take)\w*/i.test(s)) {
      const n = Number(m[1]) || NUMBER_WORDS[m[1].toLowerCase()];
      const unit = m[2].toLowerCase();
      when = new Date(base);
      if (unit.startsWith('hour')) when.setHours(when.getHours() + n);
      else {
        when.setDate(when.getDate() + n * (unit.startsWith('week') ? 7 : 1));
        atEndOfDay(when);
      }
    }
    // Ignore dates in the past relative to the email, or implausibly far out.
    if (when && !isNaN(when) && when > base - 12 * 3_600_000 && when - base < 60 * 86_400_000) {
      return when.toISOString();
    }
  }
  return '';
}

// ---- company name resolution ------------------------------------------------

// Short codes some companies send from (mostly Workday tenants: fmr@myworkday.com)
// mapped to the name people actually use. Rename an application in the UI to teach
// the tracker any others.
const KNOWN_CODES = {
  fmr: 'Fidelity Investments',
  swa: 'Southwest Airlines',
  msd: 'Merck (MSD)',
  att: 'AT&T',
  ncratleos: 'NCR Atleos',
  gmfinancial: 'GM Financial',
  q2ebanking: 'Q2',
  emcins: 'EMC Insurance',
  capitalone: 'Capital One',
  wellsfargo: 'Wells Fargo',
  nokiame: 'Nokia',
  jnj: 'Johnson & Johnson',
  bms: 'Bristol Myers Squibb',
  bankofamerica: 'Bank of America',
  bofa: 'Bank of America',
  jpmc: 'JPMorgan Chase',
  jpmorganchase: 'JPMorgan Chase',
  americanexpress: 'American Express',
  lockheedmartin: 'Lockheed Martin',
  lmco: 'Lockheed Martin',
  ngc: 'Northrop Grumman',
  hpe: 'Hewlett Packard Enterprise',
  charlesschwab: 'Charles Schwab',
  okcthunder: 'Oklahoma City Thunder',
  urbn: 'URBN (Urban Outfitters)',
  urbanoutfitters: 'URBN (Urban Outfitters)',
};

// "Charles Schwab & Co., Inc." -> "Charles Schwab", "Microsoft Corporation" -> "Microsoft"
const LEGAL_SUFFIX = /(,?\s+(&\s*co\.?|inc\.?|llc|l\.l\.c\.|ltd\.?|corp\.?|corporation|plc|co\.))+\s*$/i;

export function resolveCompanyName(name) {
  const plain = name.replace(LEGAL_SUFFIX, '').trim() || name;
  return KNOWN_CODES[squash(plain)] ?? plain;
}

// ---- entry point ----------------------------------------------------------

const OFFER_IN_SUBJECT = /\boffer\b|\bcongratulations\b/i;

export function classifyWithRules({ from, subject: rawSubject, body }) {
  // "REMINDER: ...", "Re: ...", "Action Required: ..." prefixes carry no company info.
  const subject = rawSubject.replace(/^\s*((re|fwd?|reminder|action required|update)\s*[:|–-]\s*)+/i, '');
  const text = `${subject}\n${body}`;
  let stage = RULES.find(([name, re]) =>
    re.test(text) &&
    // Real offers say so in the subject; offer wording buried in a body (FAQs,
    // assessment invites) is too unreliable on its own.
    (name !== 'offer' || OFFER_IN_SUBJECT.test(subject)))?.[0] ?? null;
  // "Interview with ..." in a subject is a strong signal on its own; an AI or recorded
  // interview is an assessment.
  if (stage !== 'rejected' && stage !== 'offer' && AI_INTERVIEW.test(`${from}\n${text}`)) stage = 'oa';
  else if ((stage === 'applied' || stage === null) && /\binterview\b/i.test(subject)) stage = 'interview';
  if (!stage) return null;

  const company =
    firstCompany(subject, SUBJECT_COMPANY) ||
    companyFromSender(from) ||
    firstCompany(body.slice(0, 500), BODY_COMPANY) ||
    'Unknown company';
  const jobId = extractJobId(subject, body);
  return { stage, company, role: extractRole(subject, body, company, jobId), jobId };
}

// "Software Developer Intern 2027 - 128497" -> "Software Developer Intern 2027"
// "AI Intern (Job number: 200049019)"      -> "AI Intern"
export function stripJobId(role, jobId) {
  if (!role || !jobId) return role;
  return role
    .replace(new RegExp(String.raw`\s*[-–,(]?\s*(?:(?:job\s*(?:number|id)|requisition\s*id|ref)\s*:?\s*)?${jobId.replace(/-/g, '\\-')}\)?`, 'i'), '')
    .replace(/[\s\-–,:]+$/, '')
    .trim();
}
