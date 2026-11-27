// The machine's Claude Code login, lent to a real-agent test and taken back when the test refreshed it (tests/e2e/login.mjs, #100).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expiresAt, isNewer } from '../e2e/login.mjs';

const login = (/** @type {number} */ at) => JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: at } });

test("a login's expiry reads from it, and anything else counts as long expired", () => {
  assert.equal(expiresAt(login(1234)), 1234);
  assert.equal(expiresAt('not json'), 0);
  assert.equal(expiresAt('{}'), 0);
});

test("the test's login goes back only when it's newer than the machine's", () => {
  assert.equal(isNewer(login(2000), login(1000)), true, 'the test refreshed it: the machine needs it');
  assert.equal(isNewer(login(1000), login(1000)), false, 'unchanged');
  assert.equal(isNewer(login(1000), login(2000)), false, 'the machine refreshed its own since');
  assert.equal(isNewer('broken', login(1000)), false);
});
