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
  assert.match(await app.text('.si-status'), /No colour schemes found (1 file isn’t a scheme)/);
  assert.equal(await app.eval(t => t.$('.scheme-import [data-ok]').disabled), true);
}));

test('Browse lists the collection, searches it and previews a scheme (GitHub stubbed)', () => withImport('import-browse', async app => {
  await app.eval((t, scheme) => {
    globalThis.fetch = async url => String(url).includes('api.github.com')
      ? new Response(JSON.stringify([{ name: 'Dracula.json', type: 'file' }, { name: 'Night Owl.json', type: 'file' }, { name: 'README.md', type: 'file' }]))
      : new Response(scheme);
  }, fixture('Dracula.json'));
  await app.eval(t => t.click('[data-si-browse]'));
  await until(() => app.eval(t => t.$$('.si-row').length === 2), 'two schemes listed');
  await app.type('.si-search', 'drac');
  await until(() => app.eval(t => t.$$('.si-row').map(r => r.textContent).join() === 'Dracula'), 'the search');
  await app.eval(t => t.click('.si-row'));
  await until(async () => (await app.text('.si-name')) === 'Dracula', 'the preview');
  assert.match(await app.text('.si-status'), /iTerm2 Color Schemes/);
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

test('↓ in the collection’s search box previews the first row and keeps typing there (GitHub stubbed)', () => withImport('import-browse-keys', async app => {
  await app.eval((t, scheme) => {
    globalThis.fetch = async url => String(url).includes('api.github.com')
      ? new Response(JSON.stringify([{ name: 'Dracula.json', type: 'file' }, { name: 'Night Owl.json', type: 'file' }]))
      : new Response(scheme);
  }, fixture('Dracula.json'));
  await app.eval(t => t.click('[data-si-browse]'));
  await until(() => app.eval(t => t.$$('.si-row').length === 2), 'listed');
  await app.key('.si-search', 'ArrowDown');
  await until(async () => (await app.text('.si-name')) === 'Dracula', 'the first previewed');
  assert.equal(await app.eval(t => t.$('.si-search') === t.$('.si-search').ownerDocument.activeElement), true);
}));
