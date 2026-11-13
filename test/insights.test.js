import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleFunction, roleLevel } from '../src/roles.js';
import { outcomeOf, reachedInterview, computeInsights, layoutLines, withoutContact, MIN_GROUP } from '../src/insights.js';
import { versionFor, currentVersion, dayIn } from '../src/resume.js';
import { refresh, newId } from '../src/store.js';

const ghostDays = 21;
const daysAgo = n => new Date(Date.now() - n * 86_400_000).toISOString();

// An application whose emails went through these stages, `ago` days apart from the first.
function app(stages, { first = 60, role = 'Software Engineer Intern', ...extra } = {}) {
  const a = {
    id: newId(), company: 'Contoso', role, source: 'gmail', createdAt: daysAgo(first),
    events: stages.map((stage, i) => ({ id: newId(), date: daysAgo(first - i * 5), stage, subject: '', snippet: '' })),
    ...extra,
  };
  return refresh(a);
}

const version = (id, usedFrom, text = 'Experience\nEducation\nSkills') => ({ id, name: id, usedFrom, text });

test('job titles sort into kinds of role and levels', () => {
  assert.equal(roleFunction('Data Engineering Intern'), 'Data');
  assert.equal(roleFunction('Site Reliability Engineer Intern'), 'Infrastructure');
  assert.equal(roleFunction('Software Engineer'), 'General software');
  assert.equal(roleFunction(''), 'Not known');
  assert.equal(roleLevel('Software Engineer Intern'), 'Internship');
  assert.equal(roleLevel('Backend Engineer, New Grad'), 'Early career');
  assert.equal(roleLevel('Senior Frontend Engineer'), 'Senior');
});

test('job titles that only look technical sort where they belong', () => {
  assert.equal(roleLevel('Product Manager'), 'Mid-level');
  assert.equal(roleLevel('Engineering Manager'), 'Senior');
  assert.equal(roleFunction('Data Center Technician'), 'Infrastructure');
  assert.equal(roleFunction('Quantitative Trader Intern'), 'Quant and trading');
  assert.equal(roleFunction('Restaurant Server'), 'General software');
  assert.equal(roleFunction('Server-side Engineer'), 'Backend');
});

test('reaching an interview is told apart from an assessment', () => {
  assert.equal(reachedInterview(app(['applied', 'oa', 'rejected']), { ghostDays }), false);
  assert.equal(reachedInterview(app(['applied', 'oa', 'interview']), { ghostDays }), true);
  const ins = computeInsights([app(['applied', 'oa']), app(['applied', 'interview'])], [], { ghostDays });
  assert.equal(ins.forward, 2);
  assert.equal(ins.interviews, 1);
  assert.equal(ins.byFunction[0].interviews, 1);
});

test('outcomes: an assessment or interview is forward; rejection or silence is not; the rest wait', () => {
  assert.equal(outcomeOf(app(['applied', 'oa', 'rejected']), { ghostDays }), 'forward');
  assert.equal(outcomeOf(app(['applied', 'interview']), { ghostDays }), 'forward');
  assert.equal(outcomeOf(app(['applied', 'rejected']), { ghostDays }), 'stalled');
  assert.equal(outcomeOf(app(['applied'], { first: 40 }), { ghostDays }), 'stalled'); // no reply in 40 days
  assert.equal(outcomeOf(app(['applied'], { first: 3 }), { ghostDays }), 'pending');
  assert.equal(outcomeOf(app(['applied', 'withdrawn']), { ghostDays }), 'pending');
});

test('a group is only rated once it has enough finished applications', () => {
  const apps = [
    ...Array.from({ length: MIN_GROUP }, (_, i) => app(i < 3 ? ['applied', 'interview'] : ['applied', 'rejected'], { role: 'Data Analyst Intern' })),
    ...Array.from({ length: MIN_GROUP - 1 }, () => app(['applied', 'oa'], { role: 'Frontend Engineer Intern' })),
    app(['applied'], { first: 2, role: 'Frontend Engineer Intern' }),
  ];
  const ins = computeInsights(apps, [], { ghostDays });
  const data = ins.byFunction.find(g => g.key === 'Data');
  const front = ins.byFunction.find(g => g.key === 'Frontend');
  assert.equal(data.rate, 3 / 5);
  assert.equal(front.rate, null); // 4 finished, one still waiting
  assert.equal(front.total, 5);
  assert.equal(ins.pending, 1);
});

test('applications count toward the version sent by the day they applied, unless you picked one', () => {
  const versions = [version('v1', '2026-01-01'), version('v2', '2026-06-01')];
  const at = (appliedAt, extra = {}) => ({ appliedAt, ...extra });
  assert.equal(versionFor(at('2026-03-10T12:00:00Z'), versions).id, 'v1');
  assert.equal(versionFor(at('2026-06-01T12:00:00Z'), versions).id, 'v2');
  assert.equal(versionFor(at('2025-12-01T12:00:00Z'), versions).id, 'v1'); // before the first: the earliest
  assert.equal(versionFor(at('2026-08-01T12:00:00Z', { resumeId: 'v1' }), versions).id, 'v1');
  assert.equal(versionFor(at('2026-08-01T12:00:00Z', { resumeId: 'deleted' }), versions).id, 'v2');
  assert.equal(versionFor(at('2026-08-01T12:00:00Z'), []), null);
});

test('versions are listed best first, once they have enough finished applications', () => {
  const old = Array.from({ length: 6 }, (_, i) => app(i < 1 ? ['applied', 'oa'] : ['applied', 'rejected'], { first: 120 }));
  const rewrite = Array.from({ length: 6 }, (_, i) => app(i < 4 ? ['applied', 'interview'] : ['applied', 'rejected'], { first: 40 }));
  const versions = [version('old', daysAgo(200).slice(0, 10)), version('rewrite', daysAgo(50).slice(0, 10))];
  const ins = computeInsights([...old, ...rewrite], versions, { ghostDays });
  assert.deepEqual(ins.byVersion.map(g => [g.key, g.total, g.forward]), [['rewrite', 6, 4], ['old', 6, 1]]);
  assert.equal(ins.currentId, 'rewrite');
});

test('a version set to start on a later day is not current until then', () => {
  const now = Date.parse('2026-05-10T12:00:00Z');
  const versions = [version('v1', '2026-01-01'), version('v2', '2026-05-01'), version('next', '2026-06-01')];
  assert.equal(currentVersion(versions, { now }).id, 'v2');
  assert.equal(currentVersion([version('later', '2026-06-01')], { now }).id, 'later'); // nothing has started yet
  assert.equal(currentVersion([], { now }), null);
});

test('an application counts toward a version by the day it was sent where you are', () => {
  // 11:30pm on 31 May in Los Angeles is already 1 June in UTC.
  const lateEvening = { appliedAt: '2026-06-01T06:30:00Z' };
  const versions = [version('may', '2026-05-01'), version('june', '2026-06-01')];
  assert.equal(dayIn(lateEvening.appliedAt, 'America/Los_Angeles'), '2026-05-31');
  assert.equal(versionFor(lateEvening, versions, 'America/Los_Angeles').id, 'may');
  assert.equal(versionFor(lateEvening, versions).id, 'june'); // no time zone known: UTC
  assert.equal(dayIn(lateEvening.appliedAt, 'Not/AZone'), '2026-06-01');
});

test('the resume sent to the AI has no name or contact details', () => {
  const sent = withoutContact('Sam Example\nsam@example.com · 555-123-4567\n\nExperience\n• Built the React website');
  assert.equal(sent, '[Name]\n[Contact details]\n\nExperience\n• Built the React website');
});

test("the preview lays out each line, with where a bullet's own text starts", () => {
  const text = 'Sam Example\nsam@example.com · github.com/sam\n\nExperience\n• Responsible for the React website\nSkills\nReact, Redis';
  const lines = layoutLines(text);
  assert.deepEqual(lines.map(l => l.kind), ['name', 'contact', 'blank', 'heading', 'bullet', 'heading', 'text']);
  assert.equal(lines[4].text.slice(lines[4].at), 'Responsible for the React website');
  assert.ok(lines.every(l => !('marks' in l))); // nuj doesn't judge lines itself any more
});


test("a bullet's wrapped next line is laid out as part of it, and the next role isn't", () => {
  const lines = layoutLines([
    'Experience',
    'MaroonLife College Station, TX',
    '• Shipped a campus mobile app for events to 1,000+',
    'downloads by leading 5+ engineers',
    '• Ran tests on every pull request by setting up automated',
    'regression testing across FastAPI',
    '• Built it with React and',
    'TypeScript for 300 people',
    'Project Manager September 2026 – Present',
    '• Cut API calls 40% with Redis',
  ].join('\n'));
  assert.deepEqual(lines.map(l => l.kind), ['name', 'text', 'bullet', 'cont', 'bullet', 'cont', 'bullet', 'cont', 'text', 'bullet']);
});
