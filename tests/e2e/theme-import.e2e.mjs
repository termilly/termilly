// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until } from './gitsteps.mjs';

const fixture = name => readFileSync(new URL(`../js/fixtures/schemes/${name}`, import.meta.url), 'utf8');
/** The interface settings the page has. */
const iface = app => app.eval(async t => ({ ...(await t.import('store.js')).state.settings.interface }));

/** The Import dialog open from Settings › Appearance › Theme, in a fresh app. */
async function withImport(name, body) {
  const repo = await makeRepo();
  let app, failed = true;
  try {
    app = await startApp({ folder: repo.folder, name });
    await app.waitFor('.xterm');
    await app.eval(async t => (await t.import('settings.js')).openSettings('appearance'));
    await app.waitFor('[data-theme-import]');
    await app.eval(t => t.click('[data-theme-import]'));
    await app.waitFor('.scheme-import');
    await body(app);
    failed = false;
  } finally { await app?.stop({ failed }); await repo.dispose(); }
}

/** Drops files on the dialog, as dragging them from the file manager does. */
const dropAll = (app, files) => app.eval((t, list) => {
  const dialog = t.$('.scheme-import');
  const transfer = new globalThis.DataTransfer();
  for (const [n, x] of list) transfer.items.add(new File([x], n));
  dialog.dispatchEvent(new globalThis.DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
}, files);
const drop = (app, name, text) => dropAll(app, [[name, text]]);

test('a dropped scheme shows, is used, and then is removed with a right-click', () => withImport('import-drop', async app => {
  await drop(app, 'Dracula.conf', fixture('Dracula.conf'));
  await until(async () => (await app.text('.si-name')) === 'Dracula', 'the preview');
  assert.equal(await app.eval(t => t.$('.scheme-import [data-ok]').disabled), false);
  await app.eval(t => t.click('.scheme-import [data-ok]'));
  await until(async () => (await iface(app)).theme === 'custom-dracula', 'the imported theme on screen');
  assert.equal((await iface(app)).customThemes.length, 1);
  assert.equal(await app.eval(t => globalThis.getComputedStyle(t.$('html')).getPropertyValue('--surface').trim()), '#282a36');
  await until(() => app.eval(t => t.$('.theme-card')?.dataset.themeId === 'custom-dracula'), 'imported first in the gallery');
  assert.equal(await app.text('.theme-card[data-theme-id="custom-dracula"] .tc-like'), 'Imported');

  await app.eval(t => t.contextmenu('.theme-card[data-theme-id="custom-dracula"]'));
  await app.waitFor('.menu-row');
  await app.eval(t => t.$$('.menu-row').find(r => r.textContent.includes('Remove theme')).click());
  await until(async () => (await iface(app)).customThemes.length === 0, 'removed');
  assert.equal((await iface(app)).theme, 'dark', 'the theme on screen gave way to Dark');
}));

test('two names that make the same id are two themes, and the same name again replaces its own', () => withImport('import-names', async app => {
  const named = name => JSON.stringify({ ...JSON.parse(fixture('Dracula.json')), name });
  const importNamed = async name => {
    if (!(await app.eval(t => !!t.$('.scheme-import')))) {
      await app.eval(t => t.click('[data-theme-import]'));
      await app.waitFor('.scheme-import');
    }
    await drop(app, `${name}.json`, named(name));
    await until(async () => (await app.text('.si-name')) === name, `${name} previewed`);
    await app.eval(t => t.click('.scheme-import [data-ok]'));
    await app.waitFor('.scheme-import', { gone: true });
  };
  await importNamed('Night Owl');
  await importNamed('Night-Owl');
  await importNamed('night owl');
  const saved = (await iface(app)).customThemes;
  assert.deepEqual(saved.map(t => t.name), ['night owl', 'Night-Owl']);
  assert.equal(new Set(saved.map(t => t.id)).size, 2);
}));

test('a file that is no scheme says so and offers nothing to use',() => withImport('import-bad', async app => {
  await drop(app, 'notes.txt', 'just some notes');
  await until(() => app.eval(t => t.$('.si-status').classList.contains('error')), 'the error line');
  assert.equal(await app.text('.si-status'), 'No colour schemes found (1 file isn’t a scheme).');
  assert.equal(await app.eval(t => t.$('.scheme-import [data-ok]').disabled), true);
}));

test('several files dropped fill the list, and ↑ and ↓ preview each in turn', () => withImport('import-many', async app => {
  const nord = JSON.stringify({ ...JSON.parse(fixture('Dracula.json')), name: 'Nord-ish', background: '#2e3440' });
  await dropAll(app, [['Dracula.conf', fixture('Dracula.conf')], ['nord.json', nord], ['notes.txt', 'not a scheme']]);
  await until(() => app.eval(t => t.$$('.si-row').length === 2), 'both schemes listed');
  assert.match(await app.text('.si-status'), /2 schemes found; 1 file isn’t a scheme/);
  assert.equal(await app.text('.si-name'), 'Dracula', 'the first shown');
  await app.key('.si-row.on', 'ArrowDown');
  await until(async () => (await app.text('.si-name')) === 'Nord-ish', '↓ shows the next');
  assert.equal(await app.eval(t => t.$('.si-row.on') === t.$('.si-row.on').ownerDocument.activeElement), true);
  await app.key('.si-row.on', 'ArrowDown');
  assert.equal(await app.text('.si-name'), 'Nord-ish', 'the last stays');
  await app.key('.si-row.on', 'ArrowUp');
  await until(async () => (await app.text('.si-name')) === 'Dracula', '↑ goes back');
  await app.eval(t => t.click('.scheme-import [data-ok]'));
  await until(async () => (await iface(app)).theme === 'custom-dracula', 'the one shown is used');
}));

test('ticked schemes are added at once, the one shown put on screen', () => withImport('import-tick', async app => {
  const named = (name, background) => JSON.stringify({ ...JSON.parse(fixture('Dracula.json')), name, background });
  await dropAll(app, [['a.json', named('One', '#111111')], ['b.json', named('Two', '#222222')], ['c.json', named('Three', '#333333')]]);
  await until(() => app.eval(t => t.$$('.si-row').length === 3), 'three listed');
  assert.equal(await app.text('.scheme-import [data-ok]'), 'Use this theme');
  await app.eval(t => { t.$('[data-si-all]').click(); });
  await until(async () => (await app.text('.scheme-import [data-ok]')) === 'Add 3 themes', 'all ticked');
  await app.key('.si-row[data-si-key="0"]', ' ');
  await until(async () => (await app.text('.scheme-import [data-ok]')) === 'Add 2 themes', 'Space unticks a row');
  assert.equal(await app.eval(t => t.$('[data-si-all]').indeterminate), true);
  await app.eval(t => t.click('.si-row[data-si-key="2"]'));
  await until(async () => (await app.text('.si-name')) === 'Three', 'Three previewed');
  await app.eval(t => t.click('.scheme-import [data-ok]'));
  await app.waitFor('.scheme-import', { gone: true });
  const saved = await iface(app);
  assert.deepEqual(saved.customThemes.map(t => t.name), ['Two', 'Three']);
  assert.equal(saved.theme, 'custom-three', 'the one shown goes on screen');
}));

test('Imported filters the gallery, and Manage removes the ticked themes', () => withImport('import-manage', async app => {
  assert.equal(await app.eval(t => !!t.$('[data-theme-manage]') || !!t.$('[data-theme-filter="imported"]')), false, 'none until a theme is imported');
  const named = (name, background) => JSON.stringify({ ...JSON.parse(fixture('Dracula.json')), name, background });
  await dropAll(app, [['a.json', named('One', '#111111')], ['b.json', named('Two', '#222222')], ['c.json', named('Three', '#333333')]]);
  await until(() => app.eval(t => t.$$('.si-row').length === 3), 'three listed');
  await app.eval(t => { t.$('[data-si-all]').click(); });
  await app.eval(t => t.click('.scheme-import [data-ok]'));
  await app.waitFor('[data-theme-manage]');
  await app.eval(t => t.click('[data-theme-filter="imported"]'));
  const shown = () => app.eval(t => t.$$('.theme-card').filter(c => c.getClientRects().length).map(c => c.querySelector('.tc-name').textContent));
  assert.deepEqual(await shown(), ['One', 'Two', 'Three']);
  await app.eval(t => t.click('[data-theme-manage]'));
  await app.waitFor('.theme-manage');
  assert.equal(await app.eval(t => t.$('.theme-manage [data-ok]').disabled), true);
  await app.eval(t => { t.$$('.theme-manage [data-tm-id]').slice(0, 2).forEach(b => b.click()); });
  assert.equal(await app.text('.theme-manage [data-ok]'), 'Remove 2 themes');
  await app.eval(t => t.click('.theme-manage [data-ok]'));
  await app.waitFor('.theme-manage', { gone: true });
  assert.deepEqual((await iface(app)).customThemes.map(t => t.name), ['Three']);
  await until(async () => (await shown()).join() === 'Three', 'the gallery keeps the Imported filter');
  await app.eval(t => t.click('[data-theme-manage]'));
  await app.waitFor('.theme-manage');
  await app.eval(t => { t.$('[data-tm-all]').click(); });
  await app.eval(t => t.click('.theme-manage [data-ok]'));
  await until(() => app.eval(t => !t.$('[data-theme-manage]') && !t.$('[data-theme-filter="imported"]')), 'Manage and Imported gone with the last one');
  assert.equal(await app.eval(t => t.$('[data-theme-filter="all"]').classList.contains('on')), true, 'back to All');
}));
