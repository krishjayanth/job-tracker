// Turning a resume's LaTeX into a PDF, on an online LaTeX compiler: LaTeX-on-HTTP
// (https://github.com/YtoTech/latex-on-http). Its public server is free and an open beta, so
// it can be slow, change or be down; every failure becomes a plain message and nothing is
// changed. LATEX_COMPILE_URL points nuj at another copy of it (one you run yourself, say).
// The LaTeX is only sent after the person allows it (see latexConsent in server.js).
import { recordError } from './errors.js';

export const COMPILE_URL = process.env.LATEX_COMPILE_URL || 'https://latex.ytotech.com/builds/sync';
export const COMPILE_SERVICE = new URL(COMPILE_URL).host;
const TIMEOUT_MS = 60_000;
const MAX_PDF = 5 * 1024 * 1024;

// An error whose message can be shown to the person as it is. `line`: where in the LaTeX it
// went wrong, when LaTeX said.
export class CompileError extends Error {
  constructor(message, line = null) {
    super(message);
    this.line = line;
  }
}

// LaTeX's first complaint, from its log, in its own words but trimmed: "! Undefined control
// sequence." or "main.tex:42: Missing } inserted."
export function firstError(log) {
  const lines = String(log ?? '').split('\n');
  const fileLine = lines.find(l => /^[^\s:]+\.tex:\d+: /.test(l));
  if (fileLine) {
    const [, line, message] = fileLine.match(/\.tex:(\d+): (.*)$/);
    return { message: message.trim().slice(0, 200), line: Number(line) };
  }
  const bang = lines.findIndex(l => l.startsWith('! '));
  if (bang >= 0) {
    const at = lines.slice(bang, bang + 8).find(l => /^l\.\d+/.test(l));
    return { message: lines[bang].slice(2).trim().slice(0, 200), line: at ? Number(at.match(/^l\.(\d+)/)[1]) : null };
  }
  return null;
}

// The PDF as a Buffer, or throws a CompileError. `fetchImpl` is for tests.
export async function compileLatex(tex, { fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(COMPILE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Stop at the first error: otherwise LaTeX skips past most mistakes and still makes a
      // PDF, quietly missing whatever went wrong.
      body: JSON.stringify({ compiler: 'pdflatex', resources: [{ main: true, content: tex }], options: { compiler: { halt_on_error: true } } }),
      signal: ctrl.signal,
    });
  } catch (err) {
    recordError('server', err, { level: 'warning', detail: `LaTeX compiler (${COMPILE_SERVICE}) unreachable` });
    throw new CompileError(err.name === 'AbortError'
      ? 'Building the PDF took too long. Try again in a minute'
      : "The LaTeX service isn't answering just now. Try again in a minute");
  } finally {
    clearTimeout(timer);
  }
  const type = res.headers.get('content-type') || '';
  if (res.ok && type.includes('pdf')) {
    const pdf = Buffer.from(await res.arrayBuffer());
    if (pdf.length > MAX_PDF) throw new CompileError('The PDF came out bigger than nuj keeps (5 MB)');
    return pdf;
  }
  if (type.includes('json')) {
    const body = await res.json().catch(() => ({}));
    if (body.error === 'COMPILATION_ERROR') {
      const log = Object.values(body.log_files || {}).join('\n');
      const found = firstError(log);
      throw new CompileError(found
        ? `LaTeX couldn't build it${found.line ? ` (line ${found.line})` : ''}: ${found.message}`
        : "LaTeX couldn't build it. Check the LaTeX for a typo", found?.line ?? null);
    }
  }
  recordError('server', `LaTeX compiler answered ${res.status} ${type}`, { level: 'warning', detail: COMPILE_SERVICE });
  throw new CompileError(res.status === 429
    ? 'The LaTeX service is busy. Try again in a minute'
    : "The LaTeX service couldn't build the PDF just now. Try again in a minute");
}
