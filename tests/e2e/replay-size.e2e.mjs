// Playing a recording (js/replay.js): output is drawn at the size the terminal had when it was printed, even when a
// resize comes in the same frame, and seeking back draws it at that size again. Run with: npm run e2e (on Linux,
// under Xvfb).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startApp } from './harness.mjs';
import { until } from './gitsteps.mjs';

let app;
let failed = false;

before(async () => {
  app = await startApp({ name: 'replay-size' });
});

after(async () => { await app?.stop({ failed }); });

/**
 * A recording on a 20-column screen: the cursor sent to column 30 (so it stops at column 20) and an X printed there,
 * then, at the same moment, the terminal widened to 40 columns. Drawn at the wrong size, the X lands at column 30.
 */
const CAST = [
  JSON.stringify({ version: 2, width: 20, height: 5, title: 'size test' }),
  JSON.stringify([0, 'o', '\u001b[1;30HX']),
  JSON.stringify([0, 'r', '40x5']),
  JSON.stringify([0.5, 'o', '\r\nend']),
].join('\n');

/** The column (from 1) of the X on the player's first row, as the screen shows it. */
const columnOfX = () => app.eval(t => {
  const row = t.$('.rp-screen .xterm-rows > div');
  const text = (row?.textContent ?? '').replace(new RegExp(String.fromCharCode(0xa0), 'g'), ' '); // xterm draws spaces as no-break spaces
  return text.indexOf('X') + 1;
});

test('output and a resize in the same moment: the output is drawn at the size before the resize', async () => {
  try {
    const file = path.join(app.dataDir, 'size.cast');
    await writeFile(file, CAST);
    await app.eval(async (t, file) => {
      const { send } = await t.import('host.js');
      const { PAGE } = await t.import('protocol.js');
      send(PAGE.recLoad, { path: file });
    }, file);
    await until(() => app.eval(t => /end/.test(t.$('.rp-screen .xterm-rows')?.textContent ?? '')), 'the recording played to its end');
    assert.equal(await columnOfX(), 20, 'the X stopped at the 20-column edge it was printed against');

    // Seeking back to the start draws it again at the recording's first size.
    await app.eval(t => {
      const seek = /** @type {HTMLInputElement} */ (t.$('.rp-seek'));
      seek.value = '0';
      seek.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 300)); // once drawn
    assert.equal(await columnOfX(), 20, 'after seeking back, still at column 20');
  } catch (e) {
    failed = true;
    await app?.screenshot('replay-size').catch(() => null);
    throw e;
  }
});
