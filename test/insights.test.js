import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSkills, roleFunction, roleLevel } from '../src/skills.js';
import { outcomeOf, computeInsights, quickChecks, MIN_GROUP } from '../src/insights.js';
import { versionFor } from '../src/resume.js';
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
  assert.equal(ins.best.function, null); // only one group is rated: nothing to compare
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

test('the best version is the one with the higher rate, once both are rated', () => {
  const old = Array.from({ length: 6 }, (_, i) => app(i < 1 ? ['applied', 'oa'] : ['applied', 'rejected'], { first: 120 }));
  const rewrite = Array.from({ length: 6 }, (_, i) => app(i < 4 ? ['applied', 'interview'] : ['applied', 'rejected'], { first: 40 }));
  const versions = [version('old', daysAgo(200).slice(0, 10)), version('rewrite', daysAgo(50).slice(0, 10))];
  const ins = computeInsights([...old, ...rewrite], versions, { ghostDays });
  assert.deepEqual(ins.byVersion.map(g => [g.key, g.total, g.forward]), [['rewrite', 6, 4], ['old', 6, 1]]);
  assert.equal(ins.best.version, 'rewrite');
  assert.equal(ins.currentId, 'rewrite');
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

test('quick checks flag weak bullets, few numbers and missing headings', () => {
  const weak = quickChecks(`Experience\n${'• Responsible for the website and other things\n'.repeat(5)}${'word '.repeat(300)}`);
  assert.equal(weak.find(c => c.id === 'numbers').ok, false);
  assert.equal(weak.find(c => c.id === 'verbs').ok, false);
  assert.match(weak.find(c => c.id === 'sections').title, /Education or Skills/);

  const strong = quickChecks(`Experience\n${'• Cut load time by 40% across 3 pages\n'.repeat(5)}Education\nSkills\n${'word '.repeat(300)}`);
  assert.ok(strong.every(c => c.ok), JSON.stringify(strong));
});
