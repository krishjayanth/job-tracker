// Writing the rewrites you accepted into a copy of your resume's PDF, so you get your own
// layout back with the new wording instead of a plain text view.
//
// Covering an old line with a white box isn't enough: its text would still be in the file,
// and applicant tracking software reads that text, so the resume would say both. So each
// page's drawing instructions are read, every piece of text is followed to where it lands
// on the page, and the pieces on a changed line are taken out. The new wording is then
// written in Helvetica (a PDF usually carries only the letters it uses of its own fonts, so
// they can't spell new words), in the very place the old line's instructions were, so the
// file reads in the same order as before (some tracking software reads text in that order,
// and a rewritten bullet must not end up after Skills). Finally the copy is read back like
// an upload: if the old wording is still there, or the new isn't, no copy is given.
//
// Where each changed line sits comes from the page, which already worked it out to draw
// the preview: per line, boxes as shares of the page ({ page, l, t, w, h }, t from the top).
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFRef, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { extractText } from './resume.js';

// An error whose message can be shown to the person as it is.
export class PdfEditError extends Error {}

// ---- reading a page's drawing instructions --------------------------------------------
// The content stream is text: operands, then the operator that uses them ("72 700 Td").
// Strings can hold any byte, so it's read as latin1 (one character per byte) and written
// back the same way, untouched except for what's taken out.
const WHITE = new Set([' ', '\n', '\r', '\t', '\f', '\0']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

function* tokens(src) {
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (WHITE.has(c)) { i++; continue; }
    if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    const start = i;
    if (c === '(') {
      let depth = 0;
      for (; i < n; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '(') depth++;
        else if (src[i] === ')' && --depth === 0) { i++; break; }
      }
      yield { kind: 'value', start, end: i };
    } else if (c === '<' && src[i + 1] === '<') {
      i += 2;
      yield { kind: 'open', start, end: i };
    } else if (c === '>' && src[i + 1] === '>') {
      i += 2;
      yield { kind: 'close', start, end: i };
    } else if (c === '<') {
      i = src.indexOf('>', i) + 1 || n;
      yield { kind: 'value', start, end: i };
    } else if (c === '[' || c === '{') {
      i++;
      yield { kind: 'open', start, end: i };
    } else if (c === ']' || c === '}') {
      i++;
      yield { kind: 'close', start, end: i };
    } else {
      if (c === '/') i++;
      while (i < n && !WHITE.has(src[i]) && !DELIM.has(src[i])) i++;
      if (i === start) i++; // a stray delimiter: step over it
      const word = src.slice(start, i);
      if (c === '/' || /^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
        yield { kind: 'value', start, end: i, num: Number(word) };
      } else if (word === 'BI') {
        // An inline image: its data is raw bytes up to "EI", which must be skipped whole.
        const at = src.slice(i).search(/\sID[\s]/);
        const data = at < 0 ? n : i + at + 4;
        const ei = src.slice(data).search(/\sEI(?=[\s]|$)/);
        i = ei < 0 ? n : data + ei + 3;
        yield { kind: 'op', op: 'BI', start, end: i };
      } else {
        yield { kind: 'op', op: word, start, end: i };
      }
    }
  }
}

// [a b c d e f] matrices, multiplied the way PDF does (a point times the matrix).
const times = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const IDENTITY = [1, 0, 0, 1, 0, 0];
const invert = ([a, b, c, d, e, f]) => {
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};
const num = n => (Math.abs(n) < 1e-9 ? '0' : String(Math.round(n * 10000) / 10000));

// Every piece of text the page shows: where it starts (in the page's own units), where its
// instruction sits in the stream (so it can be cut out), and the text state at that point
// (so new text can be written there and the state put back after it).
export function textRuns(src) {
  const runs = [];
  let ctm = IDENTITY, tm = IDENTITY, tlm = IDENTITY, leading = 0;
  // Text state the new wording must not disturb: the font, and spacing and scaling.
  let font = null;
  const spacing = { Tc: 0, Tw: 0, Tz: 100, Ts: 0 };
  const saved = [];
  let operands = [];
  let depth = 0;
  let opStart = null;
  const nums = () => operands.filter(o => o.num !== undefined && !Number.isNaN(o.num)).map(o => o.num);
  const moveTo = (tx, ty) => { tlm = times([1, 0, 0, 1, tx, ty], tlm); tm = tlm; };
  for (const t of tokens(src)) {
    if (opStart == null) opStart = t.start;
    if (t.kind === 'open') { depth++; operands.push(t); continue; }
    if (t.kind === 'close') { depth = Math.max(0, depth - 1); operands.push(t); continue; }
    if (t.kind === 'value' || depth > 0) { operands.push(t); continue; }
    const v = nums();
    switch (t.op) {
      case 'q': saved.push(ctm); break;
      case 'Q': ctm = saved.pop() ?? IDENTITY; break;
      case 'cm': if (v.length >= 6) ctm = times(v.slice(-6), ctm); break;
      case 'BT': tm = tlm = IDENTITY; break;
      case 'Tm': if (v.length >= 6) tm = tlm = v.slice(-6); break;
      case 'Td': if (v.length >= 2) moveTo(v.at(-2), v.at(-1)); break;
      case 'TD': if (v.length >= 2) { leading = -v.at(-1); moveTo(v.at(-2), v.at(-1)); } break;
      case 'TL': if (v.length) leading = v.at(-1); break;
      case 'Tf': font = src.slice(opStart, t.start).trim(); break;
      case 'Tc': case 'Tw': case 'Tz': case 'Ts': if (v.length) spacing[t.op] = v.at(-1); break;
      case 'T*': moveTo(0, -leading); break;
      case "'": case '"': moveTo(0, -leading); // and shows text, like Tj
      // falls through
      case 'Tj': case 'TJ': {
        const at = times(tm, ctm);
        runs.push({ x: at[4], y: at[5], start: opStart, end: t.end, ctm, tlm, font, spacing: { ...spacing } });
        break;
      }
      default: break;
    }
    operands = [];
    opStart = null;
  }
  return runs;
}

// ---- writing the new wording ----------------------------------------------------------
// Helvetica can only write the characters of its own set; anything else becomes a close
// stand-in, or a "?" as a last resort.
const STAND_IN = { '→': '-', '←': '-', '≈': '~', '×': 'x', '−': '-', '‑': '-', ' ': ' ' };
function writable(text, font) {
  const known = new Set(font.getCharacterSet());
  return [...text].map(c => (known.has(c.codePointAt(0)) ? c : STAND_IN[c] ?? '?')).join('');
}

// Words into rows no wider than `width`. `widthOf(text, size)` measures in the same units.
function wrapWith(text, size, width, widthOf) {
  const rows = [];
  let row = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = row ? `${row} ${word}` : word;
    if (row && widthOf(next, size) > width) { rows.push(row); row = word; } else row = next;
  }
  if (row) rows.push(row);
  return rows;
}

// The instructions for one changed line, written where its old text was: inside the page's
// own text block, so they place the words with an absolute text matrix (undoing whatever
// scaling the page set up around it), then put the page's font, spacing and position back
// for the instructions that follow. The new wording starts where the old words did, on the
// old line's baselines, wrapping at the right edge of the page's text. It may shrink to 70%
// to fit in the rows the old line had; it never takes a row more, which would print over the
// next line, so a rewrite too long for that is refused with a plain reason.
export const MIN_SHRINK = 0.7;
export function fitWording(text, width, rowCount, base, widthOf) {
  for (let size = base; size >= base * MIN_SHRINK - 1e-9; size *= 0.97) {
    const lines = wrapWith(text, size, width, widthOf);
    if (lines.length <= rowCount) return { size, lines };
  }
  return null;
}

function newWording(edit, rows, right, anchor, bullet, font, fontName) {
  const first = rows[0];
  const width = Math.max(right, ...rows.map(r => r.x1)) - first.x0;
  const base = (first.top - first.bottom) * 0.8;
  const text = writable(edit.to, font);
  const fit = fitWording(text, width, rows.length, base, (s, size) => font.widthOfTextAtSize(s, size));
  if (!fit) throw new PdfEditError(`“${edit.to.slice(0, 60)}${edit.to.length > 60 ? '…' : ''}” is too long to fit where the old line was. Shorten it, or upload the new PDF`);
  const { size, lines } = fit;
  const back = invert(anchor.ctm);
  const place = (x, y) => `${times([1, 0, 0, 1, x, y], back).map(num).join(' ')} Tm`;
  const parts = [` 0 Tc 0 Tw 100 Tz 0 Ts /${fontName} ${num(size)} Tf`];
  if (bullet) parts.push(`${place(bullet.x, bullet.y)} ${font.encodeText('•').toString()} Tj`);
  lines.forEach((line, i) => {
    const y = rows[i].top - base * 0.95; // the old line's baseline
    parts.push(`${place(first.x0, y)} ${font.encodeText(line).toString()} Tj`);
  });
  // The page's own state again. The colour is left alone, so the new words come out in
  // the old line's colour.
  const sp = anchor.spacing;
  parts.push(`${num(sp.Tc)} Tc ${num(sp.Tw)} Tw ${num(sp.Tz)} Tz ${num(sp.Ts)} Ts`);
  if (anchor.font) parts.push(`${anchor.font} Tf`);
  parts.push(`${anchor.tlm.map(num).join(' ')} Tm `);
  return parts.join('\n');
}

// Text compared loosely, as when checking the copy: case, punctuation and spacing don't matter.
const loose = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// `pdf`: the original file. `edits`: [{ from, to, boxes }]. Returns the new file as a Buffer,
// or throws a PdfEditError saying why there's no copy.
export async function writePdfEdits(pdf, edits) {
  let doc, pages;
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false });
    pages = doc.getPages();
  } catch {
    throw new PdfEditError("nuj couldn't open this PDF to change it. Upload the new PDF instead");
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontName = 'NujHelvetica';
  const byPage = new Map();
  for (const e of edits) {
    const page = e.boxes[0].page;
    if (!pages[page]) throw new PdfEditError("A changed line is on a page this PDF doesn't have. Upload the new PDF instead");
    byPage.set(page, [...(byPage.get(page) ?? []), e]);
  }

  for (const [n, pageEdits] of byPage) {
    const page = pages[n];
    if (page.getRotation().angle % 360) throw new PdfEditError("nuj can't change a turned page. Upload the new PDF instead");
    const crop = page.getCropBox();
    // A box as shares of the page, in the page's own units (y counts up from the bottom).
    const area = b => ({
      x0: crop.x + b.l * crop.width, x1: crop.x + (b.l + b.w) * crop.width,
      top: crop.y + crop.height - b.t * crop.height, bottom: crop.y + crop.height - (b.t + b.h) * crop.height,
    });

    // The page's text, all its content streams read as one.
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray
      ? contents.asArray().map(ref => doc.context.lookup(ref))
      : contents ? [contents] : [];
    const src = streams.map(s => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')).join('\n');
    const runs = textRuns(src);

    // Text that starts on a changed line goes, including a bullet drawn in the same run
    // just before it (it's put back with the new wording).
    const cut = new Set();
    const writes = new Map(); // run start -> instructions written in its place
    for (const e of pageEdits) {
      const rows = e.boxes.filter(x => x.page === n).map(area);
      const slack = 0.05 * crop.width; // a bullet or space before the words
      const onLine = rows.flatMap(a => runs.filter(r => r.y >= a.bottom - 1 && r.y <= a.top + 1 && r.x <= a.x1 && r.x >= a.x0 - slack));
      if (!onLine.length) continue; // checked when the copy is read back
      for (const r of onLine) cut.add(r);
      const first = rows[0];
      const anchor = onLine.reduce((a, b) => (b.start < a.start ? b : a));
      const bullet = onLine.find(r => r.x < first.x0 - 2 && r.y >= first.bottom - 1 && r.y <= first.top + 1);
      const right = crop.x + (e.right ?? 0) * crop.width;
      writes.set(anchor.start, newWording(e, rows, right, anchor, bullet, font, fontName));
    }
    if (cut.size) {
      let out = '';
      let from = 0;
      for (const r of [...cut].sort((a, b) => a.start - b.start)) {
        if (r.start < from) continue; // already cut
        out += src.slice(from, r.start) + (writes.get(r.start) ?? '');
        from = r.end;
      }
      out += src.slice(from);
      // The old instructions go from the file too, not just from the page: a careless reader
      // scanning the raw file shouldn't find the old wording either.
      const old = page.node.get(PDFName.of('Contents'));
      for (const ref of old instanceof PDFArray ? old.asArray() : [old]) if (ref instanceof PDFRef) doc.context.delete(ref);
      const stream = doc.context.flateStream(Buffer.from(out, 'latin1'));
      page.node.set(PDFName.of('Contents'), doc.context.register(stream));
      // Helvetica, under a name of nuj's own in the page's fonts.
      const resources = page.node.Resources() ?? doc.context.obj({});
      const fonts = resources.lookup(PDFName.of('Font'), PDFDict) ?? doc.context.obj({});
      fonts.set(PDFName.of(fontName), font.ref);
      resources.set(PDFName.of('Font'), fonts);
      page.node.set(PDFName.of('Resources'), resources);
    }
  }

  const bytes = Buffer.from(await doc.save());
  // Read back like an upload: only a copy that says the new wording and not the old.
  const { text, error } = await extractText(bytes);
  if (error) throw new PdfEditError("nuj couldn't check the edited PDF, so it didn't give you a copy. Upload the new PDF instead");
  const said = loose(text);
  // The old wording must be gone, not counting the new lines themselves: a rewrite often
  // keeps the old words and adds to them ("Deployed on AWS" -> "Deployed on AWS, raising…").
  let rest = said;
  for (const e of edits) rest = rest.replace(loose(writable(e.to, font)), ' ');
  const oldLeft = edits.find(e => loose(e.from).length >= 12 && rest.includes(loose(e.from)));
  if (oldLeft) throw new PdfEditError("nuj couldn't take the old wording out of this PDF, so it didn't make a copy that would say both. Upload the new PDF instead");
  const missing = edits.find(e => !said.includes(loose(writable(e.to, font))));
  if (missing) throw new PdfEditError("nuj couldn't write the new wording into this PDF. Upload the new PDF instead");
  return bytes;
}
