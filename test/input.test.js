import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textFields, isWebLink, LIMITS } from '../src/input.js';

test('textFields trims the fields that are present and skips the rest', () => {
  assert.deepEqual(textFields({ company: '  Stripe ', role: 'Intern' }, ['company', 'role', 'notes']), {
    fields: { company: 'Stripe', role: 'Intern' },
  });
});

test('textFields refuses anything that is not text', () => {
  assert.match(textFields({ company: 42 }, ['company']).error, /should be text/);
  assert.match(textFields({ role: ['a'] }, ['role']).error, /should be text/);
});

test('textFields needs required fields, and not empty', () => {
  assert.match(textFields({}, ['company'], { required: ['company'] }).error, /required/);
  assert.match(textFields({ company: '   ' }, ['company'], { required: ['company'] }).error, /empty/);
});

test('textFields caps the length', () => {
  assert.match(textFields({ notes: 'x'.repeat(LIMITS.notes + 1) }, ['notes']).error, /too long/);
});

test('links must be web links', () => {
  assert.equal(isWebLink('https://jobs.example.com/1'), true);
  assert.equal(isWebLink('http://example.com'), true);
  assert.equal(isWebLink('javascript:alert(1)'), false);
  assert.equal(isWebLink('data:text/html,hi'), false);
  assert.match(textFields({ url: 'javascript:alert(1)' }, ['url']).error, /https/);
  assert.deepEqual(textFields({ url: '' }, ['url']), { fields: { url: '' } });
});
