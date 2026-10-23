import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../scripts/eval.js';

// The labeled emails in test/fixtures/emails.json, sorted by the built-in rules.
// Every email added there after a mistake has to keep passing.
test('the built-in rules sort every labeled email correctly', async () => {
  const { score, misses } = await evaluate();
  assert.deepEqual(misses, []);
  assert.equal(score.notJob[0], score.notJob[1]); // no rental, utility or bank "application" gets in
});
