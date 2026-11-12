// Reads the text out of one uploaded PDF or Word file, in a worker thread (see extractText
// in resume.js). A file built to make the reader spin or swell then only ties up this
// thread, which is stopped after a time limit, instead of the server everyone shares.
import { parentPort, workerData } from 'node:worker_threads';

const { kind, bytes } = workerData;
try {
  let text;
  if (kind === 'pdf') {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    text = (await extractText(pdf, { mergePages: true })).text;
  } else {
    const { default: mammoth } = await import('mammoth');
    text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
  }
  parentPort.postMessage({ text });
} catch {
  parentPort.postMessage({ failed: true });
}
