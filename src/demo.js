// Sample data for `npm run demo`: a made-up job search, so the dashboard can be tried
// (and screenshotted) without a Google account. Every company here is fictional, and
// dates are relative to now so the chart, "no response" and deadlines always look current.
import crypto from 'node:crypto';

const DAY = 86_400_000;
// Deadlines land at the end of their day (11:59 PM), as a date-only deadline in an email does.
const endOfDay = d => { d.setHours(23, 59, 0, 0); return d.toISOString(); };

// Each entry: company, role, job ID, then the emails as [days ago, stage] pairs.
// A third element on an "oa" email is its deadline, in days after that email.
const SEARCH = [
  // Heard nothing back for 3+ weeks
  ['Contoso', 'Software Engineer Intern', 'R-574294', [[120, 'applied']]],
  ['Fabrikam', 'Backend Engineer, New Grad', '', [[110, 'applied']]],
  ['Northwind Traders', 'Data Engineering Intern', 'JR2026958', [[95, 'applied']]],
  ['Wingtip Toys', 'Full Stack Developer', '', [[88, 'applied']]],
  ['Lucerne Publishing', 'Software Developer Co-op', '200046156', [[80, 'applied']]],
  ['Coho Winery', 'Platform Engineer Intern', '', [[70, 'applied']]],
  ['Kestrel Systems', 'Embedded Software Intern', 'R-118204', [[60, 'applied']]],
  ['Halcyon Health', 'Machine Learning Intern', '', [[52, 'applied']]],
  ['Meridian Freight', 'Software Engineer I', 'REQ-40213', [[45, 'applied']]],
  ['Tasmanian Traders', 'Quantitative Developer Intern', '', [[33, 'applied']]],
  // Recently applied
  ['Orbitline', 'Site Reliability Engineer Intern', '', [[2, 'applied']]],
  ['Quillstone', 'Frontend Engineer Intern', 'R-302918', [[5, 'applied']]],
  ['Relecloud', 'Cloud Infrastructure Intern', '', [[9, 'applied']]],
  ['Southridge Video', 'Software Engineer, Streaming', '2026-126228', [[14, 'applied']]],
  ['Fourth Coffee', 'Mobile Developer Intern', '', [[18, 'applied']]],
  // Rejected after applying
  ['Woodgrove Bank', 'Technology Analyst Intern', 'R-0120133', [[100, 'applied'], [85, 'rejected']]],
  ['Humongous Insurance', 'Software Engineer Intern', '', [[90, 'applied'], [70, 'rejected']]],
  ['Adventure Works', 'Developer Intern', '', [[75, 'applied'], [60, 'rejected']]],
  ['Litware', 'Software Engineer, Early Career', 'JR1029384', [[64, 'applied'], [40, 'rejected']]],
  ['Pinecrest Capital', 'Engineering Intern', '', [[50, 'applied'], [46, 'rejected']]],
  ['Nod Publishers', 'Web Developer Intern', '', [[30, 'applied'], [12, 'rejected']]],
  // Took an assessment, then rejected
  ['Proseware', 'Software Engineer Intern', 'R-2026-73270', [[98, 'applied'], [92, 'oa', 7], [80, 'rejected']]],
  ['Trey Research', 'Research Engineer Intern', '', [[72, 'applied'], [66, 'oa', 7], [50, 'rejected']]],
  ['Consolidated Messenger', 'Backend Engineer Intern', '', [[40, 'applied'], [35, 'oa', 5], [20, 'rejected']]],
  // Assessments still to do
  ['Alpine Ski House', 'Software Engineer Intern', 'R-447120', [[12, 'applied'], [2, 'oa', 7]]],
  ['VanArsdel', 'Data Science Intern', '', [[8, 'applied'], [1, 'oa', 3]]],
  ['Lamna Healthcare', 'Software Developer Intern', '364696', [[6, 'applied'], [0.6, 'oa', 1.5]]],
  // Interviewing now
  ['Wide World Importers', 'Software Engineer Intern', 'R-889013', [[45, 'applied'], [38, 'oa', 7], [6, 'interview']]],
  ['Datum Corporation', 'Software Engineer, New Grad', '', [[35, 'applied'], [28, 'oa', 7], [3, 'interview']]],
  ['Margie\'s Travel', 'Full Stack Engineer Intern', '', [[25, 'applied'], [10, 'interview']]],
  // Interviewed, then rejected
  ['Tailspin Toys', 'Game Systems Engineer Intern', '', [[80, 'applied'], [70, 'interview'], [55, 'rejected']]],
  ['Brightpath Studios', 'Frontend Developer Intern', '', [[60, 'applied'], [50, 'interview'], [38, 'rejected']]],
  ['Larkspur Software', 'Software Engineer Intern', 'R-55102', [[92, 'applied'], [85, 'oa', 7], [74, 'interview'], [60, 'rejected']]],
  // Offers
  ['Munson\'s Pickles', 'Software Engineer Intern', 'R-610034', [[115, 'applied'], [105, 'oa', 7], [90, 'interview'], [62, 'offer']]],
  ['Fernbrook Labs', 'Platform Engineer Intern', '', [[70, 'applied'], [58, 'interview'], [30, 'offer']]],
  // Withdrew
  ['Silverline Robotics', 'Robotics Software Intern', '', [[65, 'applied'], [55, 'oa', 7], [40, 'withdrawn']]],
  // Applied twice, months apart, filed as one application: split it from the drawer
  ['Graphic Design Institute', 'Software Engineer Intern', '', [[160, 'applied'], [140, 'rejected'], [10, 'applied'], [4, 'interview']]],
];

const SUBJECTS = {
  applied: (c, r) => `Thank you for applying to ${c}: ${r}`,
  oa: c => `${c} Online Assessment Invitation`,
  interview: (c, r) => `Interview invitation: ${r} at ${c}`,
  offer: c => `Congratulations! Your offer from ${c}`,
  rejected: c => `Update on your ${c} application`,
  withdrawn: c => `Your ${c} application has been withdrawn`,
};
const SNIPPETS = {
  applied: 'We have received your application and our team will review it shortly.',
  oa: 'As a next step, please complete the online coding assessment before the link expires.',
  interview: 'We would like to schedule a 45-minute technical interview. Please share your availability.',
  offer: 'We are delighted to extend you an offer to join our team this summer.',
  rejected: 'Unfortunately, we have decided to move forward with other candidates at this time.',
  withdrawn: 'As requested, your application has been withdrawn from consideration.',
};

const slug = s => s.toLowerCase().replace(/[^a-z]/g, '');
// Rotate between the kinds of senders real application emails come from.
const SENDERS = [
  c => `${c} HR <${slug(c)}@myworkday.com>`,
  c => `${c} Recruiting <no-reply@us.greenhouse-mail.io>`,
  c => `${c} Talent Team <no-reply@ashbyhq.com>`,
  c => `${c} Careers <careers@${slug(c)}.example>`,
];

export function buildDemoDb(now = Date.now()) {
  const applications = SEARCH.map(([company, role, jobId, emails], i) => {
    const from = SENDERS[i % SENDERS.length](company);
    const events = emails.map(([daysAgo, stage, dueInDays]) => {
      // Spread emails over the working day so timelines don't all read "9:00 AM".
      const date = new Date(now - daysAgo * DAY - ((i * 37) % 360) * 60_000);
      const event = {
        id: crypto.randomUUID(), date: date.toISOString(), stage,
        subject: SUBJECTS[stage](company, role),
        from: stage === 'oa' ? 'HackerRank <noreply@hackerrankforwork.com>' : from,
        snippet: SNIPPETS[stage], jobId,
      };
      if (dueInDays) event.deadline = endOfDay(new Date(date.getTime() + dueInDays * DAY));
      return event;
    });
    return {
      id: crypto.randomUUID(), company, role, jobId, url: '', notes: '', source: 'gmail',
      createdAt: events[0].date, events,
    };
  });

  // One added by hand, the way you'd log a referral or a career-fair application.
  const added = new Date(now - 20 * DAY).toISOString();
  applications.push({
    id: crypto.randomUUID(), company: 'Blue Harbor Analytics', role: 'Data Engineer Intern', jobId: '',
    url: 'https://example.com/careers/data-engineer-intern',
    notes: 'Met their recruiter at the fall career fair. Referral submitted by a former teammate.',
    source: 'manual', createdAt: added,
    events: [{ id: crypto.randomUUID(), date: added, stage: 'applied', manual: true, subject: 'Added manually' }],
  });

  // A recorded HireVue interview counts as an assessment.
  const at = daysAgo => new Date(now - daysAgo * DAY).toISOString();
  applications.find(a => a.company === 'Relecloud').events.push({
    id: crypto.randomUUID(), date: at(1), stage: 'oa', subject: 'Relecloud: complete your video interview',
    from: 'Relecloud <noreply@hirevue.com>', snippet: 'Record your answers on HireVue at any time in the next 5 days.',
    summary: 'HireVue video interview to complete within 5 days', deadline: endOfDay(new Date(now + 4 * DAY)),
  });
  // Interview times typed in by hand, so the calendar has something on it: two coming up,
  // one soon after an assessment, and one that's already happened.
  const interview = (company, inDays, hour, minute = 0) => {
    const d = new Date(now + inDays * DAY);
    d.setHours(hour, minute, 0, 0);
    applications.find(a => a.company === company).interviewAt = d.toISOString();
  };
  interview('Wide World Importers', 2, 14);
  interview('Datum Corporation', 5, 10, 30);
  interview('Graphic Design Institute', 9, 11);
  interview('Margie\'s Travel', -4, 15, 30);
  // A second application at one company, and an email that doesn't say which job it's about.
  applications.push({
    id: crypto.randomUUID(), company: 'Datum Corporation', role: 'Data Analyst Intern', jobId: '', url: '', notes: '',
    source: 'gmail', createdAt: at(20),
    events: [
      { id: crypto.randomUUID(), date: at(20), stage: 'applied', subject: 'Thank you for applying to Datum Corporation: Data Analyst Intern', from: SENDERS[1]('Datum Corporation'), snippet: SNIPPETS.applied },
      {
        id: crypto.randomUUID(), date: at(0.3), stage: 'applied', subject: 'An update on your Datum Corporation application',
        from: SENDERS[1]('Datum Corporation'), snippet: 'Your application is still under review. We appreciate your patience.',
        summary: 'Still under review; the email doesn’t name the job',
        reasoning: 'Sent through Greenhouse on behalf of Datum Corporation, named in the subject and signature. It only says the application is still being reviewed, with no title or requisition ID, so it is a status update on an existing application.',
        review: [{ about: 'application', text: "You have several applications at Datum Corporation, and this email doesn't say which job it's about." }],
      },
    ],
  });

  return { applications, processed: {}, ignored: {}, lastSync: new Date(now).toISOString(), lastSyncError: null };
}

// For the Developer page in demo mode: a few made-up accounts beside the demo's own, in
// the shape accountSummary() returns, so every state shows (working, syncing, an expired
// Gmail sign-in, a rejected Groq key, someone still setting up, someone taken off the list).
export function buildDemoAccounts(now = Date.now()) {
  const at = daysAgo => new Date(now - daysAgo * DAY).toISOString();
  const groq = { by: 'groq', key: 'own', problem: null };
  const rules = { by: 'rules', key: null, problem: null };
  const base = { owner: false, allowed: true, gmail: 'connected', setupDone: true, toCheck: 0, lastSyncError: null, busy: null, errors: 0, reports: 0 };
  return [
    { ...base, id: 'demo-ava', email: 'ava.lindqvist@example.com', joinedAt: at(41), lastSeenAt: at(0.02), sorting: groq, applications: 52, emails: 131, toCheck: 2, lastSync: at(0.003) },
    { ...base, id: 'demo-noah', email: 'noah.okafor@example.com', joinedAt: at(33), lastSeenAt: at(0.4), sorting: groq, applications: 18, emails: 44, lastSync: at(0.01), busy: { mode: 'rescan', done: 27, total: 44 } },
    { ...base, id: 'demo-mei', email: 'mei.tanaka@example.com', joinedAt: at(29), lastSeenAt: at(9), gmail: 'expired', sorting: rules, applications: 23, emails: 61, lastSync: at(9), lastSyncError: 'Google sign-in for Gmail expired or was revoked', errors: 1 },
    { ...base, id: 'demo-sam', email: 'sam.reyes@example.com', joinedAt: at(20), lastSeenAt: at(1.5), sorting: { ...groq, problem: 'rejected' }, applications: 9, emails: 20, lastSync: at(0.004), errors: 1, reports: 1 },
    { ...base, id: 'demo-jo', email: 'jo.martins@example.com', joinedAt: at(2), lastSeenAt: at(2), setupDone: false, sorting: rules, applications: 0, emails: 0, lastSync: null },
    { ...base, id: 'demo-lee', email: 'lee.harper@example.com', joinedAt: at(64), lastSeenAt: at(38), allowed: false, gmail: 'off', sorting: rules, applications: 14, emails: 30, lastSync: at(38) },
  ];
}

// And what went wrong lately, in the shape src/errors.js keeps, grouped as it groups them.
export function buildDemoErrors(now = Date.now()) {
  const at = hoursAgo => new Date(now - hoursAgo * 3_600_000).toISOString();
  const group = (id, source, level, message, count, firstH, lastH, users, samples, extra = {}) => ({
    id, source, level, message, count, firstAt: at(firstH), lastAt: at(lastH), users, status: 'open',
    samples: samples.map(([h, userId, detail]) => ({ at: at(h), userId, detail, message })), ...extra,
  });
  return [
    group('demo-e1', 'groq', 'warning', 'Rate limited for 42s; read with the rules instead', 37, 70, 0.3, ['demo-ava', 'demo-noah'],
      [[0.3, null, ''], [1.1, null, ''], [3.4, null, '']]),
    group('demo-e2', 'sync', 'error', 'Request failed with status code 503', 4, 30, 2.2, ['demo-ava'],
      [[2.2, 'demo-ava', ''], [11, 'demo-ava', 'during a re-scan']]),
    group('demo-e3', 'browser', 'error', "Cannot read properties of undefined (reading 'events')", 3, 26, 5, ['demo-sam', 'demo-ava'],
      [[5, 'demo-sam', 'app.js:1488 · Calendar'], [19, 'demo-ava', 'app.js:1488 · Calendar']], { regressed: true }),
    group('demo-e4', 'groq', 'warning', "Groq rejected this person's key; using the rules until it's replaced", 1, 36, 36, ['demo-sam'],
      [[36, 'demo-sam', '']]),
    group('demo-e5', 'gmail', 'warning', 'Google sign-in for Gmail expired or was revoked', 1, 216, 216, ['demo-mei'],
      [[216, 'demo-mei', '']]),
    { ...group('demo-e6', 'server', 'error', 'connect ETIMEDOUT', 2, 400, 390, [], [[390, null, 'GET /api/state']]), status: 'resolved', resolvedAt: at(380) },
  ];
}

// And answers to an earlier "how's it going?", so the Feedback section has something in it.
// The demo's own account isn't asked here; "Ask everyone" in demo mode asks it too, to try.
export function buildDemoFeedback(now = Date.now()) {
  const at = daysAgo => new Date(now - daysAgo * DAY).toISOString();
  const answer = (userId, email, daysAgo, enjoying, rating, sorting, comment = '') => ({ userId, email, at: at(daysAgo), enjoying, rating, sorting, comment });
  return [{
    id: 'demo-ask-1', createdAt: at(6), everyone: true,
    userIds: ['demo-ava', 'demo-noah', 'demo-mei', 'demo-sam', 'demo-jo'],
    skipped: ['demo-jo'],
    answers: [
      answer('demo-ava', 'ava.lindqvist@example.com', 5.6, 'yes', 5, 'right', 'The deadline list saved me twice this week.'),
      answer('demo-noah', 'noah.okafor@example.com', 4.2, 'yes', 4, 'some', 'A recruiter newsletter got filed as an application.'),
      answer('demo-sam', 'sam.reyes@example.com', 2, 'okay', 3, 'wrong', ''),
    ],
  }];
}
