import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The dashboard's scripts are plain scripts sharing one global scope, so two files that
// declare the same top-level function don't fail: the one loaded last quietly replaces the
// other everywhere. (The resume page's reviewHtml once replaced the drawer's, and opening
// any application threw "resume is null".) Two top-level let/const would instead stop the
// second script from loading at all. Either way, every top-level name has to be unique.
test('dashboard scripts never declare the same top-level name twice', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const files = [...html.matchAll(/<script src="(js\/[^"]+\.js)"><\/script>/g)].map(m => path.join('public', m[1]));
  assert.ok(files.length > 5, 'found the dashboard scripts in index.html');
  const seen = new Map();
  const clashes = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const line of src.split('\n')) {
      const decl = line.match(/^(?:async\s+)?function\*?\s+([\w$]+)|^((?:const|let|var)\s+.+|class\s+.+)/);
      if (!decl) continue;
      const names = decl[1] ? [decl[1]] : topLevelNames(decl[2].replace(/^(?:const|let|var)\s+/, ''));
      for (const name of names) {
        if (seen.has(name) && seen.get(name) !== file) clashes.push(`${name}: ${seen.get(name)} and ${file}`);
        seen.set(name, file);
      }
    }
  }
  assert.deepEqual(clashes, []);
});

// The names a `const|let|var|class` line declares: `let a = 1, b = null;` declares two.
// Split at commas outside brackets, strings and templates, up to the end of the statement.
function topLevelNames(rest) {
  if (rest.startsWith('class ')) return [rest.slice(6).match(/^[\w$]+/)?.[0]].filter(Boolean);
  const parts = [];
  let depth = 0, quote = null, start = 0, i = 0;
  for (; i < rest.length; i++) {
    const c = rest[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && (c === ',' || c === ';')) { parts.push(rest.slice(start, i)); start = i + 1; if (c === ';') break; }
  }
  if (i === rest.length) parts.push(rest.slice(start));
  return parts.map(p => p.trim().match(/^([\w$]+)\s*(?:=|$)/)?.[1]).filter(Boolean);
}
