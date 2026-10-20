// Tests for consoleDefaults (src/Termilly.Desktop/wwwroot/js/consolecolors.js), against PSReadLine's real output.
// Run with: node --test tests/js/consolecolors.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consoleDefaults } from '../../src/Termilly.Desktop/wwwroot/js/consolecolors.js';

const E = '\x1b';

test("PSReadLine's white-on-black reset becomes the terminal's default colours", () => {
  // `npm run dev --port 4000` typed at a PowerShell prompt, as ConPTY passes it on.
  const typed = `${E}[93mnpm${E}[37m${E}[40m ${E}[37mrun${E}[37m${E}[40m ${E}[37mdev${E}[37m${E}[40m ${E}[90m--port${E}[37m${E}[40m ${E}[97m4000${E}[37m${E}[40m${E}[0m`;
  const out = consoleDefaults(typed);
  assert.ok(!out.includes(`${E}[40m`), 'no black background left');
  assert.equal(out, typed.replaceAll(`${E}[37m${E}[40m`, `${E}[39m${E}[49m`));
});

test('other ways of asking for white on black are left alone', () => {
  for (const s of [`${E}[37;40mboxed${E}[0m`, `${E}[40m${E}[37mreversed order`, `${E}[37mtext${E}[40m`]) {
    assert.equal(consoleDefaults(s), s);
  }
});

test('output without the pair comes back as it was', () => {
  const s = `plain ${E}[32mgreen${E}[0m`;
  assert.equal(consoleDefaults(s), s);
});
