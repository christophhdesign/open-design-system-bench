import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeUsageLimit } from './errors.ts';

test('looksLikeUsageLimit matches typical claude CLI usage-limit phrasings', () => {
  assert.equal(looksLikeUsageLimit('Claude usage limit reached. Your limit resets at 5pm'), true);
  assert.equal(looksLikeUsageLimit('rate limit exceeded'), true);
  assert.equal(looksLikeUsageLimit('429 too many requests'), true);
  assert.equal(looksLikeUsageLimit('Error: quota exceeded for this account'), true);
  assert.equal(looksLikeUsageLimit('you are out of credits'), true);
  assert.equal(looksLikeUsageLimit('the API is currently overloaded, please retry'), true);
  // Real message that slipped past the original patterns (2026-08-25 monthly run):
  assert.equal(
    looksLikeUsageLimit("You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit"),
    true,
  );
  assert.equal(looksLikeUsageLimit('insufficient credits to complete this request'), true);
  // Real message that slipped past the patterns (2026-09-03 field test, 25 cells lost):
  assert.equal(looksLikeUsageLimit("You've hit your session limit · resets 2am (Europe/Berlin)"), true);
  assert.equal(looksLikeUsageLimit("You've hit your weekly limit · resets Sep 8 at 9am"), true);
});

test('looksLikeUsageLimit does not match ordinary errors', () => {
  assert.equal(looksLikeUsageLimit('TS2307 cannot find module'), false);
  assert.equal(looksLikeUsageLimit('network timeout'), false);
  assert.equal(looksLikeUsageLimit(undefined), false);
  assert.equal(looksLikeUsageLimit(null), false);
  assert.equal(looksLikeUsageLimit(''), false);
});
