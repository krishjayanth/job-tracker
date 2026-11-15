// Resumes as LaTeX, in Jake's Resume format (Jake Gutierrez, MIT licence:
// https://github.com/jakegut/resume). A version can keep its LaTeX: nuj writes it from a
// resume read into sections (see structureResume in ai.js, or resumeFromLines below), the
// person can edit it, and an accepted rewrite changes the matching \resumeItem. The text the
// AI reads and the preview shows is worked out from the LaTeX (latexToText), so the two
// never drift apart. Compiling to a PDF happens elsewhere (compile.js).

export const MAX_LATEX = 60_000;

// Jake's preamble and commands, as in his template.
const PREAMBLE = String.raw`%-------------------------
% Resume in LaTeX, in Jake's Resume format
% Template: Jake Gutierrez, https://github.com/jakegut/resume (MIT licence)
% Made with nuj
%-------------------------

\documentclass[letterpaper,11pt]{article}

\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{verbatim}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage[english]{babel}
\usepackage{tabularx}
\input{glyphtounicode}

\pagestyle{fancy}
\fancyhf{}
\fancyfoot{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0pt}

% Adjust margins
\addtolength{\oddsidemargin}{-0.5in}
\addtolength{\evensidemargin}{-0.5in}
\addtolength{\textwidth}{1in}
\addtolength{\topmargin}{-.5in}
\addtolength{\textheight}{1.0in}

\urlstyle{same}

\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}

% Sections formatting
\titleformat{\section}{
  \vspace{-4pt}\scshape\raggedright\large
}{}{0em}{}[\color{black}\titlerule \vspace{-5pt}]

% Ensure that the PDF is machine readable (ATS parsable)
\pdfgentounicode=1

%-------------------------
% Custom commands
\newcommand{\resumeItem}[1]{
  \item\small{
    {#1 \vspace{-2pt}}
  }
}

\newcommand{\resumeSubheading}[4]{
  \vspace{-2pt}\item
    \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
      \textbf{#1} & #2 \\
      \textit{\small#3} & \textit{\small #4} \\
    \end{tabular*}\vspace{-7pt}
}

\newcommand{\resumeSubSubheading}[2]{
    \item
    \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
      \textit{\small#1} & \textit{\small #2} \\
    \end{tabular*}\vspace{-7pt}
}

\newcommand{\resumeProjectHeading}[2]{
    \item
    \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
      \small#1 & #2 \\
    \end{tabular*}\vspace{-7pt}
}

\newcommand{\resumeSubItem}[1]{\resumeItem{#1}\vspace{-4pt}}

\renewcommand\labelitemii{$\vcenter{\hbox{\tiny$\bullet$}}$}

\newcommand{\resumeSubHeadingListStart}{\begin{itemize}[leftmargin=0.15in, label={}]}
\newcommand{\resumeSubHeadingListEnd}{\end{itemize}}
\newcommand{\resumeItemListStart}{\begin{itemize}}
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{-5pt}}

%-------------------------------------------
`;

// ---- writing LaTeX ----------------------------------------------------------------------
// Characters LaTeX treats as commands, and typography pdflatex is happier spelling out.
const ESCAPES = { '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
const TYPOGRAPHY = { '–': '--', '—': '---', '‘': '`', '’': "'", '“': '``', '”': "''", '…': '\\ldots{}', '•': '\\textbullet{}', '|': '$|$', '<': '\\textless{}', '>': '\\textgreater{}', ' ': '~' };
export const escapeLatex = s => String(s ?? '')
  .replace(/[\\&%$#_{}~^]/g, c => ESCAPES[c])
  .replace(/[–—‘’“”…•|<> ]/g, c => TYPOGRAPHY[c])
  // Anything pdflatex's fonts don't have (emoji, symbols) goes rather than stopping the build.
  .replace(/[^\x00-ɏ–-‟…]/gu, '');

const url = s => String(s).replace(/[\\{}%#]/g, '');

// `resume`: { name, contact: [{ text, url? }], sections: [{ title, kind, entries, skills, items }] }
//   kind 'entries': entries [{ title, date, subtitle, location, bullets }] (jobs, schools)
//   kind 'projects': entries [{ title, tech, date, bullets }]
//   kind 'skills': skills [{ label, value }]
//   kind 'list': items [string]
export function resumeToLatex(resume) {
  const out = [PREAMBLE, '\\begin{document}', '', '\\begin{center}'];
  out.push(`    \\textbf{\\Huge \\scshape ${escapeLatex(resume.name || 'Your Name')}} \\\\ \\vspace{1pt}`);
  const contact = (resume.contact || []).filter(c => c?.text).map(c => (c.url
    ? `\\href{${url(c.url)}}{\\underline{${escapeLatex(c.text)}}}`
    : escapeLatex(c.text)));
  if (contact.length) out.push(`    \\small ${contact.join(' $|$ ')}`);
  out.push('\\end{center}', '');
  const items = bullets => (bullets?.length
    ? ['      \\resumeItemListStart', ...bullets.map(b => `        \\resumeItem{${escapeLatex(b)}}`), '      \\resumeItemListEnd']
    : []);
  for (const s of resume.sections || []) {
    out.push(`\\section{${escapeLatex(s.title)}}`);
    if (s.kind === 'skills') {
      out.push(' \\begin{itemize}[leftmargin=0.15in, label={}]', '    \\small{\\item{');
      (s.skills || []).forEach((k, i, all) => out.push(`     ${k.label ? `\\textbf{${escapeLatex(k.label)}}{: ${escapeLatex(k.value)}}` : escapeLatex(k.value)}${i < all.length - 1 ? ' \\\\' : ''}`));
      out.push('    }}', ' \\end{itemize}', '');
      continue;
    }
    // Bullets with no heading over them get a list of their own: inside Jake's heading list
    // every line has to start with a heading's \item.
    const bulletList = list => (list.length ? ['  \\resumeItemListStart', ...list.map(b => `    \\resumeItem{${escapeLatex(b)}}`), '  \\resumeItemListEnd'] : []);
    if (s.kind === 'list') {
      out.push(...bulletList(s.items || []), '');
      continue;
    }
    // A line on its own (no dates, no second line, no bullets) would sit in a heading row,
    // which doesn't wrap: it's written as a bullet instead.
    const lone = e => !e.date && !e.subtitle && !e.location && !e.tech && !e.bullets?.length;
    out.push(...bulletList((s.entries || []).filter(lone).map(e => e.title)));
    const headed = (s.entries || []).filter(x => !lone(x));
    if (!headed.length) { out.push(''); continue; }
    out.push('  \\resumeSubHeadingListStart');
    for (const e of headed) {
      if (s.kind === 'projects' || (!e.subtitle && !e.location)) {
        // One line: Jake's project heading (a job with no second line looks the same, without
        // a blank row under it).
        const head = `\\textbf{${escapeLatex(e.title)}}${e.tech ? ` $|$ \\emph{${escapeLatex(e.tech)}}` : ''}`;
        out.push('    \\resumeProjectHeading', `      {${head}}{${escapeLatex(e.date)}}`);
      } else {
        out.push('    \\resumeSubheading', `      {${escapeLatex(e.title)}}{${escapeLatex(e.date)}}`, `      {${escapeLatex(e.subtitle)}}{${escapeLatex(e.location)}}`);
      }
      out.push(...items(e.bullets));
    }
    out.push('  \\resumeSubHeadingListEnd', '');
  }
  out.push('\\end{document}', '');
  return out.join('\n');
}

// The template to start from, filled with Jake's own example, for someone with no resume yet.
export const STARTER = resumeToLatex({
  name: 'Jake Ryan',
  contact: [{ text: '123-456-7890' }, { text: 'jake@su.edu', url: 'mailto:jake@su.edu' }, { text: 'linkedin.com/in/jake', url: 'https://linkedin.com/in/jake' }, { text: 'github.com/jake', url: 'https://github.com/jake' }],
  sections: [
    { title: 'Education', kind: 'entries', entries: [{ title: 'Southwestern University', date: 'Georgetown, TX', subtitle: 'Bachelor of Arts in Computer Science, Minor in Business', location: 'Aug. 2018 – May 2021' }] },
    { title: 'Experience', kind: 'entries', entries: [{
      title: 'Undergraduate Research Assistant', date: 'June 2020 – Present', subtitle: 'Texas A&M University', location: 'College Station, TX',
      bullets: ['Developed a REST API using FastAPI and PostgreSQL to store data from learning management systems', 'Developed a full-stack web application using Flask, React, PostgreSQL and Docker to analyze GitHub data', 'Explored ways to visualize GitHub collaboration in a classroom setting'],
    }] },
    { title: 'Projects', kind: 'projects', entries: [{
      title: 'Gitlytics', tech: 'Python, Flask, React, PostgreSQL, Docker', date: 'June 2020 – Present',
      bullets: ['Developed a full-stack web application using with Flask serving a REST API with React as the frontend', 'Implemented GitHub OAuth to get data from user’s repositories', 'Visualized GitHub data to show collaboration'],
    }] },
    { title: 'Technical Skills', kind: 'skills', skills: [
      { label: 'Languages', value: 'Java, Python, C/C++, SQL (Postgres), JavaScript, HTML/CSS, R' },
      { label: 'Frameworks', value: 'React, Node.js, Flask, JUnit, WordPress, Material-UI, FastAPI' },
      { label: 'Developer Tools', value: 'Git, Docker, TravisCI, Google Cloud Platform, VS Code, Visual Studio, PyCharm, IntelliJ, Eclipse' },
      { label: 'Libraries', value: 'pandas, NumPy, Matplotlib' },
    ] },
  ],
});

// ---- reading LaTeX back -----------------------------------------------------------------
// A small reader for what nuj writes and what people usually change in Jake's format:
// commands and their {braced} arguments. Anything else is read as plain text.

// The argument starting at `src[i]` (an opening brace), and where it ends.
function braced(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return { text: src.slice(i + 1, j), end: j + 1 };
  }
  return { text: src.slice(i + 1), end: src.length };
}

// `count` braced arguments after position `i`, skipping spaces and newlines between them.
function args(src, i, count) {
  const out = [];
  let at = i;
  for (let n = 0; n < count; n++) {
    while (/\s/.test(src[at] ?? '')) at++;
    if (src[at] !== '{') break;
    const a = braced(src, at);
    out.push(a.text);
    at = a.end;
  }
  return { args: out, end: at };
}

const UNESCAPE = [
  [/\\textbackslash\{\}/g, '\\'], [/\\textasciitilde\{\}/g, '~'], [/\\textasciicircum\{\}/g, '^'], [/\\ldots\{\}/g, '…'],
  [/\\textbullet\{\}/g, '•'], [/\\textless\{\}/g, '<'], [/\\textgreater\{\}/g, '>'], [/\$\|\$/g, '|'],
  [/\\([&%$#_{}])/g, '$1'], [/---/g, '—'], [/--/g, '–'], [/``/g, '“'], [/''/g, '”'], [/~/g, ' '],
];

// LaTeX inline markup as the words a reader sees: commands dropped, their arguments kept.
export function inlineText(tex) {
  let s = String(tex ?? '');
  s = s.replace(/%[^\n]*/g, (m, off) => (s[off - 1] === '\\' ? m : '')); // comments, not \%
  s = s.replace(/\\href\s*\{[^}]*\}/g, ''); // a link's address; its text follows in braces
  s = s.replace(/\\(?:vspace|hspace)\*?\s*\{[^}]*\}/g, '');
  s = s.replace(/\\\\/g, ' ');
  for (const [re, to] of UNESCAPE) s = s.replace(re, to);
  s = s.replace(/\\[a-zA-Z]+\*?/g, ''); // \textbf, \small, \underline…
  s = s.replace(/[{}]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

// Commands that shape the page rather than say anything.
const LAYOUT = /^\\(?:documentclass|usepackage|input|pagestyle|fancyhf|fancyfoot|renewcommand|newcommand|addtolength|urlstyle|raggedbottom|raggedright|setlength|titleformat|pdfgentounicode|begin|end|resumeSubHeadingListStart|resumeSubHeadingListEnd|resumeItemListStart|resumeItemListEnd|vspace|hspace)\b/;

// The resume's text, line by line, as nuj's other parts expect it (a name first, headings,
// "• " bullets), worked out from the LaTeX between \begin{document} and \end{document}.
export function latexToText(tex) {
  const start = tex.indexOf('\\begin{document}');
  const end = tex.lastIndexOf('\\end{document}');
  const body = tex.slice(start < 0 ? 0 : start + '\\begin{document}'.length, end < 0 ? tex.length : end);
  const lines = [];
  let i = 0;
  while (i < body.length) {
    const rest = body.slice(i);
    const cmd = rest.match(/^\\([a-zA-Z]+)\*?/);
    if (cmd) {
      const name = cmd[1];
      const at = i + cmd[0].length;
      if (name === 'section') {
        const a = args(body, at, 1);
        lines.push('', inlineText(a.args[0]));
        i = a.end;
        continue;
      }
      if (name === 'resumeSubheading') {
        const a = args(body, at, 4);
        const [t, d, sub, loc] = a.args.map(inlineText);
        lines.push([t, d].filter(Boolean).join(' '), [sub, loc].filter(Boolean).join(' '));
        i = a.end;
        continue;
      }
      if (name === 'resumeSubSubheading' || name === 'resumeProjectHeading') {
        const a = args(body, at, 2);
        lines.push(a.args.map(inlineText).filter(Boolean).join(' '));
        i = a.end;
        continue;
      }
      if (name === 'resumeItem' || name === 'resumeSubItem') {
        const a = args(body, at, 1);
        lines.push(`• ${inlineText(a.args[0])}`);
        i = a.end;
        continue;
      }
      if (name === 'item') {
        // A plain \item, as in the skills list: up to the next \item or the list's end.
        const next = body.slice(at).search(/\\item\b|\\end\{itemize\}|\\resume/);
        const chunk = body.slice(at, next < 0 ? body.length : at + next);
        for (const part of chunk.split(/\\\\/)) {
          const text = inlineText(part);
          if (text) lines.push(text);
        }
        i = next < 0 ? body.length : at + next;
        continue;
      }
      if (LAYOUT.test(rest)) {
        const a = args(body, at, name === 'begin' && /^\\begin\{tabular/.test(rest) ? 2 : 1);
        i = a.end > at ? a.end : at;
        // An environment's [options], like the skills list's [leftmargin=0.15in, label={}].
        if (name === 'begin' && body[i] === '[') i = body.indexOf(']', i) + 1 || body.length;
        continue;
      }
    }
    // Plain text up to the next command that starts a new piece (the header, mostly).
    const next = body.slice(i + 1).search(/\\(?:section|resume[A-Za-z]*|item|begin|end)\b/);
    const chunk = body.slice(i, next < 0 ? body.length : i + 1 + next);
    for (const part of chunk.split(/\\\\/)) {
      const text = inlineText(part);
      if (text) lines.push(text);
    }
    i = next < 0 ? body.length : i + 1 + next;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- changing one bullet ------------------------------------------------------------------
const loose = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}+#%]+/gu, ' ').trim();

// The LaTeX with the \resumeItem whose words are `from` changed to say `to` (escaped), or
// null when no bullet says that.
export function replaceItem(tex, from, to) {
  const want = loose(from);
  if (want.length < 8) return null;
  // Only in the document itself: the preamble uses \resumeItem{#1} to define other commands.
  const re = /\\resume(?:Sub)?Item\s*\{/g;
  re.lastIndex = Math.max(0, tex.indexOf('\\begin{document}'));
  let m;
  while ((m = re.exec(tex))) {
    const open = m.index + m[0].length - 1;
    const a = braced(tex, open);
    const have = loose(inlineText(a.text));
    if (have === want || (have.length >= 12 && (have.includes(want) || want.includes(have)))) {
      return `${tex.slice(0, open + 1)}${escapeLatex(to)}${tex.slice(a.end - 1)}`;
    }
  }
  return null;
}

// ---- a resume read from its own lines, when there's no AI ----------------------------------
// A rough reading of the resume's lines (see layoutLines in insights.js): headings start
// sections, a line with a date range starts an entry, bullets belong to the entry above,
// "Label: things" lines under a skills heading become skills. The AI does this far better;
// this is what's used without it (and in the demo).
const DATE_AT_END = /\s+((?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(?:19|20)\d{2}\s*[–—-]+\s*(?:(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(?:19|20)\d{2}|present|current)|(?:expected\s+)?(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)(?:19|20)\d{2})\s*$/i;
// A city of one or two words and a state ("College Station, TX"), or Remote.
const PLACE_AT_END = /\s+((?:[A-Z][a-z]+\.?\s)?[A-Z][a-z]+\.?,\s*[A-Z]{2}|Remote)\s*$/;

export function resumeFromLines(lines) {
  const resume = { name: '', contact: [], sections: [] };
  let section = null;
  let entry = null;
  for (const l of lines) {
    const text = l.text.trim();
    if (!text) continue;
    if (l.kind === 'name') { resume.name = text; continue; }
    if (l.kind === 'contact') {
      for (const part of text.split(/\s*[|·]\s*/)) if (part) resume.contact.push({ text: part, url: /@/.test(part) ? `mailto:${part}` : /\.(com|io|dev|org|me)\b/.test(part) ? `https://${part.replace(/^https?:\/\//, '')}` : undefined });
      continue;
    }
    if (l.kind === 'heading') {
      const title = text.replace(/\s+/g, ' ');
      const kind = /skill|technolog|tools/i.test(title) ? 'skills' : /project/i.test(title) ? 'projects' : 'entries';
      section = { title: title.charAt(0) + title.slice(1).toLowerCase().replace(/\b(\w)/g, (m, c, off) => (off ? c.toUpperCase() : c)), kind, entries: [], skills: [], items: [] };
      resume.sections.push(section);
      entry = null;
      continue;
    }
    if (!section) { section = { title: 'Experience', kind: 'entries', entries: [], skills: [], items: [] }; resume.sections.push(section); }
    if (l.kind === 'bullet') {
      if (!entry) { section.items.push(l.text.slice(l.at).trim()); continue; }
      entry.bullets.push(l.text.slice(l.at).trim());
      continue;
    }
    if (l.kind === 'cont') {
      const list = entry ? entry.bullets : section.items;
      if (list.length) list[list.length - 1] += ` ${text}`;
      continue;
    }
    if (section.kind === 'skills') {
      const [label, ...value] = text.split(':');
      section.skills.push(value.length ? { label: label.trim(), value: value.join(':').trim() } : { label: '', value: text });
      continue;
    }
    if (!entry || entry.subtitle || entry.bullets.length || section.kind === 'projects') {
      // A new entry. In Jake's format its first line is the title with, at the right, the
      // dates (a job) or the place (a school).
      const end = text.match(DATE_AT_END) || text.match(PLACE_AT_END);
      entry = { title: end ? text.slice(0, end.index).trim() : text, date: end ? end[1] : '', subtitle: '', location: '', tech: '', bullets: [] };
      if (section.kind === 'projects') {
        const [name, ...tech] = entry.title.split(/\s+\|\s+/);
        entry.title = name;
        entry.tech = tech.join(', ');
      }
      section.entries.push(entry);
      continue;
    }
    // The entry's second line: where, and when or where.
    const place = text.match(PLACE_AT_END) || text.match(DATE_AT_END);
    entry.subtitle = place ? text.slice(0, place.index).trim() : text;
    entry.location = place ? place[1] : '';
  }
  for (const s of resume.sections) if (s.kind !== 'skills' && !s.entries.length && s.items.length) s.kind = 'list';
  return resume;
}
