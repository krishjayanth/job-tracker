// A plain PDF of a resume's text, for the demo: its made-up resumes need a real PDF so the
// preview shows what an upload looks like. Built by hand (Helvetica, one column) rather than
// with a library, since nothing else in nuj makes PDFs.
import { reviewLines } from './insights.js';

const PAGE = { w: 612, h: 792, margin: 56 };
// Helvetica's built-in encoding has these at its own codes, not their Unicode ones.
const WIN_ANSI = { '•': 0x95, '·': 0xb7, '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94 };
const encode = s => [...s].map(c => String.fromCharCode(WIN_ANSI[c] ?? (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f))).join('')
  .replace(/[\\()]/g, '\\$&');
// Close enough to Helvetica's widths to wrap lines; the PDF viewer measures for itself.
const width = (s, size, bold) => s.length * size * (bold ? 0.54 : 0.5);

function wrap(text, size, bold, max) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && width(next, size, bold) > max) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

const STYLE = {
  name: { size: 20, bold: true, after: 4 },
  contact: { size: 9.5, gray: 0.4, after: 6 },
  heading: { size: 10, bold: true, upper: true, before: 10, after: 6, rule: true },
  text: { size: 10.5, bold: true, before: 4, after: 1 },
  bullet: { size: 10, indent: 14, after: 1 },
  plain: { size: 10, before: 2, after: 1 },
  blank: null,
};

export function textPdf(text) {
  const { w, h, margin } = PAGE;
  const ops = [];
  let y = h - margin;
  const lines = reviewLines(text);
  lines.forEach((line, n) => {
    // A title is bold when bullets follow it (a job or a project); a skills list isn't.
    const titled = line.kind === 'text' && lines.slice(n + 1).find(l => l.kind !== 'blank')?.kind === 'bullet';
    const style = line.kind === 'text' && !titled ? STYLE.plain : STYLE[line.kind];
    if (!style) return;
    const body = line.text.slice(line.at).trim();
    y -= style.before ?? 0;
    const x = margin + (style.indent ?? 0);
    const lead = style.size * 1.35;
    wrap(style.upper ? body.toUpperCase() : body, style.size, style.bold, w - margin - x).forEach((seg, i) => {
      y -= lead;
      if (line.kind === 'bullet' && i === 0) ops.push(`BT /F1 ${style.size} Tf ${margin + 3} ${y.toFixed(1)} Td (${encode('•')}) Tj ET`);
      ops.push(`${style.gray ?? 0} g BT /F${style.bold ? 2 : 1} ${style.size} Tf ${x} ${y.toFixed(1)} Td (${encode(seg)}) Tj ET 0 g`);
    });
    if (style.rule) ops.push(`0.75 G 0.6 w ${margin} ${(y - 4).toFixed(1)} m ${w - margin} ${(y - 4).toFixed(1)} l S 0 G`);
    y -= style.after ?? 0;
  });
  const content = ops.join('\n');
  const font = base => `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    font('Helvetica'),
    font('Helvetica-Bold'),
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const at = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
