import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeLatex, resumeToLatex, latexToText, replaceItem, resumeFromLines, inlineText, STARTER } from '../src/latex.js';
import { compileLatex, firstError, CompileError } from '../src/compile.js';
import { layoutLines } from '../src/insights.js';

const resume = {
  name: 'Sam Example',
  contact: [{ text: 'sam@example.com', url: 'mailto:sam@example.com' }, { text: 'github.com/sam', url: 'https://github.com/sam' }],
  sections: [
    { title: 'Experience', kind: 'entries', entries: [{ title: 'Full Stack & Technical Lead', date: 'Feb 2026 – Present', subtitle: 'MaroonLife', location: 'College Station, TX', bullets: ['Cut API calls 40%+ with Redis & caching', 'Shipped an app to 1,000+ users'] }] },
    { title: 'Projects', kind: 'projects', entries: [{ title: 'nuj', tech: 'Node.js, D3', date: '2026', bullets: ['Built a job tracker for 15 users'] }] },
    { title: 'Technical Skills', kind: 'skills', skills: [{ label: 'Languages', value: 'JavaScript, C++, C#' }] },
  ],
};

test("special characters are escaped so LaTeX prints them, and read back as they were", () => {
  assert.equal(escapeLatex('40% & $5 #1 a_b {x} ~ ^'), '40\\% \\& \\$5 \\#1 a\\_b \\{x\\} \\textasciitilde{} \\textasciicircum{}');
  assert.equal(escapeLatex('2024 – 2026 “quoted” | x 🚀'), '2024 -- 2026 ``quoted\'\' $|$ x '); // pdflatex has no emoji
  assert.equal(inlineText(escapeLatex('Cut 40% & more | C# — fast')), 'Cut 40% & more | C# — fast');
});

test("a resume written in Jake's format reads back as the same text", () => {
  const tex = resumeToLatex(resume);
  assert.match(tex, /\\resumeSubheading\s*\{Full Stack \\& Technical Lead\}\{Feb 2026 -- Present\}/);
  assert.match(tex, /\\resumeProjectHeading\s*\{\\textbf\{nuj\} \$\|\$ \\emph\{Node\.js, D3\}\}\{2026\}/);
  assert.equal(latexToText(tex), [
    'Sam Example',
    'sam@example.com | github.com/sam',
    '',
    'Experience',
    'Full Stack & Technical Lead Feb 2026 – Present',
    'MaroonLife College Station, TX',
    '• Cut API calls 40%+ with Redis & caching',
    '• Shipped an app to 1,000+ users',
    '',
    'Projects',
    'nuj | Node.js, D3 2026',
    '• Built a job tracker for 15 users',
    '',
    'Technical Skills',
    'Languages: JavaScript, C++, C#',
  ].join('\n'));
  assert.match(latexToText(STARTER), /^Jake Ryan\n/);
});

test('an accepted rewrite changes only the matching \\resumeItem, escaped', () => {
  const tex = resumeToLatex(resume);
  const out = replaceItem(tex, 'Cut API calls 40%+ with Redis & caching', 'Cut API calls by 40%+ & latency by [X%] with Redis');
  assert.ok(out.includes('\\resumeItem{Cut API calls by 40\\%+ \\& latency by [X\\%] with Redis}'));
  assert.ok(out.includes('\\resumeItem{Shipped an app to 1,000+ users}'), 'the other bullets stay');
  assert.equal(replaceItem(tex, 'A bullet that is not on this resume at all', 'x'), null);
});

test("without the AI, a resume's lines are sorted into Jake's sections by simple rules", () => {
  const text = 'Sam Example\nsam@example.com | github.com/sam\n\nEDUCATION\nTexas A&M University College Station, TX\nBSc Computer Science Expected May 2028\nEXPERIENCE\nFull Stack Lead February 2026 – September 2026\nMaroonLife College Station, TX\n• Shipped a campus app to 1,000+\ndownloads by leading 5+ engineers\nPROJECTS\nnuj | Node.js, D3 October 2026 – Present\n• Built a tracker\nTECHNICAL SKILLS\nLanguages: JavaScript, Python';
  const r = resumeFromLines(layoutLines(text));
  assert.equal(r.name, 'Sam Example');
  assert.deepEqual(r.contact.map(c => c.text), ['sam@example.com', 'github.com/sam']);
  assert.deepEqual(r.sections.map(s => [s.title, s.kind]), [['Education', 'entries'], ['Experience', 'entries'], ['Projects', 'projects'], ['Technical Skills', 'skills']]);
  assert.deepEqual(r.sections[0].entries[0], { title: 'Texas A&M University', date: 'College Station, TX', subtitle: 'BSc Computer Science', location: 'Expected May 2028', tech: '', bullets: [] });
  assert.deepEqual(r.sections[1].entries[0].bullets, ['Shipped a campus app to 1,000+ downloads by leading 5+ engineers']);
  assert.deepEqual([r.sections[2].entries[0].title, r.sections[2].entries[0].tech], ['nuj', 'Node.js, D3']);
  assert.deepEqual(r.sections[3].skills, [{ label: 'Languages', value: 'JavaScript, Python' }]);
});

test("LaTeX's first error is told in its own words, with the line", () => {
  assert.deepEqual(firstError('This is pdfTeX\n./main.tex:42: Undefined control sequence.\nl.42 \\foo'), { message: 'Undefined control sequence.', line: 42 });
  assert.deepEqual(firstError('blah\n! Missing } inserted.\n<inserted text>\nl.7 x'), { message: 'Missing } inserted.', line: 7 });
  assert.equal(firstError('all fine'), null);
});

// A stand-in for the compile service.
const respond = (status, type, body) => async () => new Response(body, { status, headers: { 'content-type': type } });

test('compiling gives the PDF, a plain reason for a LaTeX mistake, and a plain one when the service fails', async () => {
  const pdf = await compileLatex('x', { fetchImpl: respond(201, 'application/pdf', '%PDF-1.7 fake') });
  assert.equal(pdf.toString(), '%PDF-1.7 fake');
  const log = JSON.stringify({ error: 'COMPILATION_ERROR', log_files: { 'main.log': '! Undefined control sequence.\nl.12 \\oops' } });
  await assert.rejects(compileLatex('x', { fetchImpl: respond(400, 'application/json', log) }),
    err => err instanceof CompileError && err.line === 12 && /line 12.*Undefined control sequence/.test(err.message));
  await assert.rejects(compileLatex('x', { fetchImpl: respond(502, 'text/html', 'Bad gateway') }), /couldn't build the PDF just now/);
  await assert.rejects(compileLatex('x', { fetchImpl: respond(429, 'text/plain', 'slow down') }), /busy/);
  await assert.rejects(compileLatex('x', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), /isn't answering/);
});

test('sections that are only bullets, and lines on their own, compile as bullet lists', async () => {
  const tex = resumeToLatex({ name: 'Sam', contact: [], sections: [
    { title: 'Awards', kind: 'list', items: ["Dean's List", 'Hackathon winner'] },
    { title: 'Activities', kind: 'entries', entries: [{ title: 'Hackathon lead: organised a 24-hour hackathon for 150 students', date: '', subtitle: '', location: '', bullets: [] }] },
  ] });
  // Every \resumeItem is in Jake's item list, never straight inside his heading list.
  assert.ok(!/\\resumeSubHeadingListStart\s*\\resumeItem/.test(tex));
  assert.match(tex, /\\resumeItemListStart\s*\\resumeItem\{Hackathon lead/);
  assert.equal(latexToText(tex), "Sam\n\nAwards\n• Dean's List\n• Hackathon winner\n\nActivities\n• Hackathon lead: organised a 24-hour hackathon for 150 students");
});
