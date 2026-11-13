import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { writePdfEdits, textRuns, PdfEditError } from '../src/pdfedit.js';
import { extractText } from '../src/resume.js';
import { textPdf } from '../src/textpdf.js';

const resume = 'Sam Example\nsam@example.com\n\nExperience\n• Helped with the sign-up page for the student union\n• Cut load time by 40% across 3 pages\nSkills\nReact, Node.js';

// Where a line sits on the page, as shares of it, and the right edge of the page's text,
// found the way the page finds them for the preview (pdf.js's text positions), so the test
// feeds what the page would.
async function placeOf(pdf, words) {
  const { getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const boxes = [];
  let right = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    for (const item of (await page.getTextContent()).items) {
      right = Math.max(right, (item.transform[4] + item.width) / vp.width);
      const at = item.str.indexOf(words);
      if (at < 0) continue;
      const [, , , d, e, f] = item.transform;
      const size = Math.abs(d);
      const share = at / item.str.length;
      boxes.push({ page: n - 1, l: (e + item.width * share) / vp.width, t: (vp.height - f - size * 0.95) / vp.height, w: item.width * (1 - share) / vp.width, h: size * 1.25 / vp.height });
    }
  }
  return { boxes, right };
}

test('the text on a page is followed to where it lands', () => {
  const runs = textRuns('BT /F1 11 Tf 56 700 Td (First) Tj 0 -14 Td (Second) Tj ET q 1 0 0 1 10 20 cm BT 5 5 Td [(Third) -50 (part)] TJ ET Q');
  assert.deepEqual(runs.map(r => [r.x, r.y]), [[56, 700], [56, 686], [15, 25]]);
});

test('an accepted rewrite replaces the old line in a copy of the PDF, and the old words are gone', async () => {
  const pdf = textPdf(resume);
  const from = 'Helped with the sign-up page for the student union';
  const to = 'Raised student union sign-ups by [X%] by rebuilding the sign-up page';
  const place = await placeOf(pdf, from);
  assert.equal(place.boxes.length, 1);
  const out = await writePdfEdits(pdf, [{ from, to, ...place }]);
  const { text } = await extractText(out);
  assert.ok(!text.includes('Helped with'), text);
  assert.ok(text.includes('Raised student union sign-ups'), text);
  assert.ok(text.includes('Cut load time by 40% across 3 pages'), 'the other lines are untouched');
  assert.ok(text.includes('•'), 'the bullet is still there');
  // The new line reads where the old one was, not at the end of the page.
  assert.ok(text.indexOf('Raised student union') < text.indexOf('Cut load time'), text);
  // And the old wording isn't left anywhere in the file, even unused.
  assert.ok(!out.toString('latin1').includes('Helped with'));
});

test('a rewrite too long for the old line is refused, never printed over the next one', async () => {
  const pdf = textPdf(resume);
  const from = 'Cut load time by 40% across 3 pages';
  const place = await placeOf(pdf, from);
  const to = `Cut load time by 40% across 3 pages ${'by doing a great many careful things '.repeat(6)}`;
  await assert.rejects(writePdfEdits(pdf, [{ from, to, ...place }]), err => err instanceof PdfEditError && /too long to fit/.test(err.message));
});

test('a copy is refused rather than given with both wordings', async () => {
  const pdf = textPdf(resume);
  // Boxes somewhere else on the page: nothing is taken out, so the old line would remain.
  const wrong = [{ page: 0, l: 0.5, t: 0.9, w: 0.1, h: 0.02 }];
  await assert.rejects(
    writePdfEdits(pdf, [{ from: 'Helped with the sign-up page for the student union', to: 'Something new and true', boxes: wrong }]),
    err => err instanceof PdfEditError && /old wording/.test(err.message),
  );
  await assert.rejects(writePdfEdits(Buffer.from('%PDF-1.4 not really'), [{ from: 'x', to: 'y', boxes: wrong }]), PdfEditError);
});

test('an uploaded-style PDF from the fixtures can be edited too', async () => {
  const pdf = fs.readFileSync(new URL('./fixtures/resume.pdf', import.meta.url));
  const { text } = await extractText(pdf);
  const line = text.split('\n').find(l => l.trim().split(/\s+/).length >= 5);
  if (!line) return; // nothing long enough to test with
  const words = line.trim();
  const place = await placeOf(pdf, words);
  assert.ok(place.boxes.length, 'found the line');
  const out = await writePdfEdits(pdf, [{ from: words, to: 'A new line written for this test', ...place }]);
  const back = (await extractText(out)).text;
  assert.ok(back.includes('A new line written for this test'));
  assert.ok(back.indexOf('A new line') < back.indexOf('Education'), 'in its old place');
});

test('a rewrite that keeps the old words and adds to them is not taken for the old line', async () => {
  const pdf = textPdf(resume);
  const from = 'Cut load time by 40% across 3 pages';
  const out = await writePdfEdits(pdf, [{ from, to: `${from}, by caching routes`, ...await placeOf(pdf, from) }]);
  assert.ok((await extractText(out)).text.includes('across 3 pages, by caching routes'));
});

test('a bullet printed on two lines is replaced on both, and the new wording may use both', async () => {
  const pdf = textPdf('Sam Example\n\nExperience\n• Ran end-to-end tests on every pull request by setting up automated\nregression testing across FastAPI and React\n• Cut API calls 40% with Redis');
  const first = 'Ran end-to-end tests on every pull request by setting up automated';
  const second = 'regression testing across FastAPI and React';
  const a = await placeOf(pdf, first), b = await placeOf(pdf, second);
  const to = 'Caught [N] bugs before release by running end-to-end tests on every pull request, setting up automated regression testing across FastAPI and React';
  const out = await writePdfEdits(pdf, [{ from: `${first} ${second}`, to, boxes: [...a.boxes, ...b.boxes], right: a.right }]);
  const { text } = await extractText(out);
  assert.ok(!/Ran end-to-end/.test(text), text);
  assert.equal(text.match(/regression testing across FastAPI/g)?.length, 1, 'the old second line is gone, not repeated');
  assert.ok(text.indexOf('Caught [N] bugs') < text.indexOf('Cut API calls'));
});
