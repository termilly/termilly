// Tests for the window's state as the host reports it (src/Termilly.Desktop/wwwroot/js/windowshown.js), which
// decides whether a terminal counts as in view for notifications.
// Run with: node --test tests/js/windowshown.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowInFront, setWindowState } from '../../src/Termilly.Desktop/wwwroot/js/windowshown.js';

test('the window starts in front', () => {
  assert.equal(windowInFront(), true);
});

test('minimized or inactive is not in front, and coming back says so once', () => {
  assert.equal(setWindowState({ minimized: true, active: false }), false);
  assert.equal(windowInFront(), false);
  // Restored but another window is active: still not in front.
  assert.equal(setWindowState({ minimized: false, active: false }), false);
  assert.equal(windowInFront(), false);
  assert.equal(setWindowState({ minimized: false, active: true }), true);
  assert.equal(windowInFront(), true);
  // Already in front: nothing new.
  assert.equal(setWindowState({ minimized: false, active: true }), false);
});

test('minimized counts even if the host says active', () => {
  setWindowState({ minimized: true, active: true });
  assert.equal(windowInFront(), false);
  setWindowState({ minimized: false, active: true });
});
