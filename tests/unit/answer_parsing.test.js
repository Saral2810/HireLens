import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNoticePeriodDays, parseNumber } from '../../backend/src/utils/validation.js';

test('parseNoticePeriodDays', () => {
  assert.equal(parseNoticePeriodDays('Immediate'), 0);
  assert.equal(parseNoticePeriodDays('currently serving notice'), 0);
  assert.equal(parseNoticePeriodDays('30'), 30);
  assert.equal(parseNoticePeriodDays('2 months'), 60);
  assert.equal(parseNoticePeriodDays('1 week'), 7);
  assert.equal(parseNoticePeriodDays(90), 90);
  assert.equal(parseNoticePeriodDays('soon'), null);
  assert.equal(parseNoticePeriodDays(-5), null);
});

test('parseNumber', () => {
  assert.equal(parseNumber('12,00,000'), 1200000);
  assert.equal(parseNumber('4.5 years'), 4.5);
  assert.equal(parseNumber(1800000), 1800000);
  assert.equal(parseNumber('lots'), null);
  assert.equal(parseNumber('-3'), null);
});
