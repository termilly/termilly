// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';

test('terminal opens and the Git window opens separately and closes', async () => {
  const repo = await makeRepo({ files: { 'README.md': 'Smoke repository\n' } });
  let app, failed = true;
  try {
    app = await startApp({ folder: repo.folder, name: 'smoke' });
    await app.waitFor('.xterm');
    await app.key('.xterm textarea', 'G', { ctrl: true, shift: true });
    await app.waitFor('.git-win');
    assert.equal(await app.eval(t => t.$('.git-win').ownerDocument !== t.$('.xterm').ownerDocument), true);
    await app.click('.git-win [data-gw="close"]');
    await app.waitFor('.git-win', { gone: true });
    failed = false;
  } finally {
    await app?.stop({ failed });
    await repo.dispose();
  }
});
