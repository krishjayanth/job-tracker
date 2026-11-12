import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSkills, roleFunction, roleLevel } from '../src/skills.js';
import { outcomeOf, reachedInterview, computeInsights, quickChecks, layoutLines, withoutContact, MIN_GROUP } from '../src/insights.js';
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

test('skills are found by any of their spellings, never inside another word', () => {
  assert.deepEqual([...findSkills('Experience with node.js, Postgres and k8s')].sort(), ['Kubernetes', 'Node.js', 'PostgreSQL']);
  assert.deepEqual([...findSkills('JavaScript only')], ['JavaScript']); // not Java
  assert.deepEqual([...findSkills('C++ and C#, plus .NET')].sort(), ['.NET', 'C#', 'C++']);
});

test('links and email addresses are not skills', () => {
  assert.equal(findSkills('sam@example.com · github.com/sam · https://gitlab.com/sam · www.react.dev').size, 0);
  assert.deepEqual([...findSkills('Git, GitHub Actions and Node.js')].sort(), ['Git', 'GitHub Actions', 'Node.js']);
});

test('skill names that are everyday words only count where a skill would be', () => {
  for (const text of ['a swift response', 'Swift response times', 'unity across teams', 'Security clearance required',
    'monitoring of social media', 'guard rails', 'spark joy', 'transformers in power plants', 'at the helm of the club', 'said in jest']) {
    assert.equal(findSkills(text).size, 0, text);
  }
  assert.deepEqual([...findSkills('Languages: Swift, Rust. Built games in Unity')].sort(), ['Rust', 'Swift', 'Unity']);
  assert.deepEqual([...findSkills('Swift developer; Spark and Kafka; Security Engineer')].sort(), ['Apache Spark', 'Kafka', 'Security', 'Swift']);
});

test('a skill inside a longer one only counts as the longer one', () => {
  assert.deepEqual([...findSkills('React Native and Ruby on Rails')].sort(), ['React Native', 'Ruby on Rails']);
  assert.deepEqual([...findSkills('React Native apps, and React for the web')].sort(), ['React', 'React Native']);
});

test('everyday words that are also skills only count in their unambiguous forms', () => {
  assert.equal(findSkills('You will excel at the rest of the work and go far').size, 0);
  assert.deepEqual([...findSkills('Golang and Microsoft Excel, REST APIs')].sort(), ['Excel', 'Go', 'REST APIs']);
});

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

test('keywords: skills from postings, split by whether the current resume names them', () => {
  const apps = [
    app(['applied', 'interview'], { posting: 'React, TypeScript and Docker' }),
    app(['applied', 'rejected'], { posting: 'Docker and Kubernetes' }),
    app(['applied'], { first: 2, role: 'Python Developer' }),
  ];
  const ins = computeInsights(apps, [version('v1', '2025-01-01', 'Skills: React, Python')], { ghostDays });
  const { matched, missing, withPosting } = ins.keywords;
  assert.deepEqual(matched.map(k => k.name), ['React', 'Python']); // React's posting moved forward
  assert.deepEqual(missing.map(k => [k.name, k.postings, k.forward]), [['Docker', 2, 1], ['TypeScript', 1, 1], ['Kubernetes', 1, 0]]);
  assert.equal(withPosting, 2);
  assert.equal(missing[0].ids.length, 2);
});

test('each skill says which kinds of role asked for it', () => {
  const apps = [
    app(['applied'], { role: 'Data Analyst Intern', posting: 'SQL and Tableau' }),
    app(['applied'], { role: 'Data Engineer Intern', posting: 'SQL and Airflow' }),
    app(['applied'], { role: 'iOS Engineer Intern', posting: 'Swift, SwiftUI and SQL' }),
  ];
  const ins = computeInsights(apps, [version('v1', '2025-01-01', 'Skills: Python')], { ghostDays });
  const kinds = name => ins.keywords.missing.find(k => k.name === name).kinds;
  assert.deepEqual(kinds('SQL'), ['Data', 'Mobile']);
  assert.deepEqual(kinds('Swift'), ['Mobile']);
  assert.deepEqual(ins.mainKinds, ['Data', 'Mobile']);
});

test('quick checks flag weak bullets, few numbers and missing headings', () => {
  const weak = quickChecks(`Experience\n${'• Responsible for the website and other things\n'.repeat(5)}${'word '.repeat(300)}`);
  assert.equal(weak.find(c => c.id === 'numbers').ok, false);
  assert.equal(weak.find(c => c.id === 'verbs').ok, false);
  assert.match(weak.find(c => c.id === 'sections').title, /Education or Skills/);

  const strong = quickChecks(`sam@example.com · linkedin.com/in/sam\nExperience\n${['Cut', 'Built', 'Led', 'Raised', 'Shipped'].map(v => `• ${v} load time by 40% across 3 pages\n`).join('')}Education\nSkills\n${'word '.repeat(300)}`);
  assert.ok(strong.every(c => c.ok), JSON.stringify(strong.filter(c => !c.ok)));
});

test('quick checks also catch repeats, long bullets, "I", stock phrases, mixed dates and missing contact details', () => {
  const failed = text => quickChecks(text).filter(c => !c.ok).map(c => c.id);
  const bullets = list => `Experience\nEducation\nSkills\n${list.map(b => `• ${b}`).join('\n')}\n${'word '.repeat(300)}`;
  assert.ok(failed(bullets(Array(5).fill('Developed 3 features'))).includes('repeats'));
  assert.ok(failed(bullets(['Built 3 things', 'Led 2 teams', 'Shipped 4 apps', `Ran ${'a very long list of things '.repeat(8)}`])).includes('long'));
  assert.ok(failed(bullets(['I built 3 things', 'Led 2 teams', 'Shipped 4 apps', 'Ran 5 events'])).includes('first-person'));
  assert.ok(failed(`A team player. ${'word '.repeat(300)}`).includes('cliches'));
  assert.ok(failed(`Jan 2023 - Mar 2024\n06/2022 - 12/2022\n${'word '.repeat(300)}`).includes('dates'));
  assert.ok(failed(`${'word '.repeat(300)}`).includes('contact'));
  assert.ok(failed(bullets(['Utilized Python in 2023', 'Was responsible for the site', 'Led 2 teams', 'Shipped 4 apps'])).includes('verbs'));
});

test('years in a bullet are not counted as results', () => {
  const text = `Experience\n${['Built the site in 2023', 'Ran events 2021 - 2022', 'Led the club (2020)', 'Wrote docs'].map(b => `• ${b}`).join('\n')}`;
  assert.equal(quickChecks(text).find(c => c.id === 'numbers').ok, false);
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

