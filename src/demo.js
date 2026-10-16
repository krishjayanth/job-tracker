// Sample data for `npm run demo`: a made-up job search, so the dashboard can be tried
// (and screenshotted) without a Google account. Every company here is fictional, and
// dates are relative to now so the chart, "no response" and deadlines always look current.
import crypto from 'node:crypto';

const DAY = 86_400_000;

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
      if (dueInDays) event.deadline = new Date(date.getTime() + dueInDays * DAY).toISOString();
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

  return { applications, processed: {}, ignored: {}, lastSync: new Date(now).toISOString(), lastSyncError: null };
}
