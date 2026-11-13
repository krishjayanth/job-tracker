// Lines of resume text, as nuj reads them out of a file. A PDF keeps no paragraphs: a bullet
// that wraps onto a second printed line comes out as two lines of text, the second with no
// bullet. Everything that works on bullets (the preview, "Use this", the edited PDF) has to
// treat those as one bullet, so they all ask here.

export const BULLET = /^\s*(?:[•●▪◦‣■□*–-]|\d+[.)])\s+/;
export const bodyOf = line => line.replace(BULLET, '').trim();

// Words a wrapped line can break after: a sentence doesn't end on them.
const BREAKS_AFTER = /(?:[,(&/–-]|\b(?:and|or|to|of|with|for|by|in|on|at|the|a|an|using|via|across|from|into|as))$/i;
const DATE = /\b(19|20)\d{2}\b|\b(present|current)\b/i;

// Whether `line` carries on the line before it (`prev`, a bullet or its carrying-on line):
// it has no bullet of its own, and either starts with a small letter ("downloads by…") or
// follows a line that stops mid-sentence ("…partnering with" / "React and TypeScript").
// A capitalised line after a finished one is something new, like the next role
// ("Project Manager  September 2026 – Present").
export function carriesOn(prev, line) {
  const text = line.trim();
  if (!text || BULLET.test(line)) return false;
  if (/^\p{Ll}/u.test(text)) return true;
  return BREAKS_AFTER.test(prev.trim()) && !DATE.test(text);
}

// How many lines after line `i` (a bullet) carry it on.
export function carryOnCount(lines, i) {
  if (!BULLET.test(lines[i] ?? '')) return 0;
  let n = 0;
  while (i + n + 1 < lines.length && carriesOn(lines[i + n], lines[i + n + 1])) n++;
  return n;
}
