// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until } from './gitsteps.mjs';

/** The names of the gallery's cards that are drawn (not only marked hidden). */
const shownCards = app => app.eval(t => t.$('.theme-card').filter(c => c.getClientRects().length).map(c => c.querySelector('.tc-name').textContent));
/** The interface settings the page has. */
const iface = app => app.eval(async t => ({ ...(await t.import('store.js')).state.settings.interface }));

/** Settings open on Appearance, in a fresh app. */
async function withAppearance(name, body) {
  const repo = await makeRepo();
  let app, failed = true;
  try {
    app = await startApp({ folder: repo.folder, name });
    await app.waitFor('.xterm');
    await app.eval(async t => (await t.import('settings.js')).openSettings('appearance'));
    await app.waitFor('.set-tab');
    await body(app);
    failed = false;
  } finally { await app?.stop({ failed }); await repo.dispose(); }
}

test('Appearance has Theme, Text and Layout tabs, and a tab keeps the title Appearance', () => withAppearance('appearance-tabs', async app => {
  assert.deepEqual(await app.eval(t => t.$$('.set-tab').map(b => b.textContent)), ['Theme', 'Text', 'Layout']);
  assert.equal(await app.text('.set-tab.on'), 'Theme');
  await app.eval(t => t.click('.set-tab[data-section="appearance-text"]'));
  await app.waitFor('.font-picker');
  assert.equal(await app.text('.set-tab.on'), 'Text');
  assert.equal(await app.eval(t => t.$('#set-title').textContent), 'Appearance');
  await app.eval(t => t.click('.set-tab[data-section="appearance-layout"]'));
  await until(async () => (await app.text('.set-tab.on')) === 'Layout', 'the Layout tab');
  assert.equal(await app.eval(t => t.$('.set-row .set-name').some(n => n.textContent === 'Terminal names')), true);
  // The keyboard moves between tabs and stays on them; the body is the open tab's panel.
  await app.key('.set-tab.on', 'Home');
  await until(async () => (await app.text('.set-tab.on')) === 'Theme', 'Home opens the first tab');
  await app.key('.set-tab.on', 'ArrowRight');
  await until(async () => (await app.text('.set-tab.on')) === 'Text', 'Right opens the next tab');
  assert.equal(await app.eval(t => t.$('.set-tab.on') === t.$('.set-tab.on').ownerDocument.activeElement), true);
  assert.equal(await app.eval(t => t.$('#set-body').getAttribute('aria-labelledby')), 'set-tab-appearance-text');
}));

test('the gallery lists Popular first, finds a theme by its well-known name, and filters dark and light', () => withAppearance('appearance-gallery', async app => {
  assert.deepEqual(await app.eval(t => t.$$('.theme-group-head').map(h => h.textContent)), ['Popular', 'Termilly’s own']);
  const popular = await app.eval(t => [...t.$$('.theme-group')[0].querySelectorAll('.tc-name')].map(n => n.textContent));
  assert.equal(popular.length, 12);
  assert.deepEqual(popular.slice(0, 3), ['Midnight', 'Catppuccin Mocha', 'Catppuccin Latte']);
  await app.type('.theme-search', 'dracula');
  await until(async () => (await shownCards(app)).join() === 'Midnight', 'Dracula finds Midnight');
  await app.type('.theme-search', 'nothing like this');
  await until(() => app.eval(t => !t.$('.theme-none').hidden), 'the no-match line');
  await app.type('.theme-search', '');
  await app.eval(t => t.click('[data-theme-filter="light"]'));
  const light = await app.eval(t => t.$('.theme-card').filter(c => c.getClientRects().length).map(c => c.dataset.base));
  assert.ok(light.length > 0 && light.every(b => b === 'light'), 'only light themes');
  assert.ok((await shownCards(app)).includes('Catppuccin Latte'));
}));

test('a card picks its theme for the app and the terminals', () => withAppearance('appearance-pick', async app => {
  await app.eval(t => t.click('.theme-card[data-theme-id="catppuccin-mocha"]'));
  await until(async () => (await iface(app)).theme === 'catppuccin-mocha', 'the setting saved');
  assert.equal(await app.eval(t => globalThis.getComputedStyle(t.$('html')).getPropertyValue('--bg').trim()), '#181825');
  assert.equal(await app.eval(t => t.$('.theme-card.on').dataset.themeId), 'catppuccin-mocha');
  assert.equal(await app.eval(async t => {
    const { state } = await t.import('store.js');
    return [...state.tabs.values()].find(tab => tab.view?.term).view.term.options.theme.background;
  }), '#1e1e2e');
}));

test('following the system uses the dark or light pick, and turning it off keeps the theme on screen', () => withAppearance('appearance-follow', async app => {
  // A first start follows the system on Linux and macOS: start from a theme of its own.
  await app.eval(t => t.click('.theme-card[data-theme-id="midnight"]'));
  await until(async () => (await iface(app)).theme === 'midnight', 'a theme of its own');
  assert.equal(await app.eval(t => t.$('[data-theme-follow]').getAttribute('aria-checked')), 'false');
  await app.eval(t => t.click('[data-theme-follow]'));
  await until(async () => (await iface(app)).theme === 'system', 'following the system');
  assert.equal(await app.eval(t => t.$('[data-theme-follow]').getAttribute('aria-checked')), 'true');
  // Each mode's pick is a dropdown; picking one for the mode the system is in shows it at once.
  const mode = await app.eval(() => globalThis.matchMedia('(prefers-color-scheme: light)').matches ? 'themeLight' : 'themeDark');
  const pick = mode === 'themeLight' ? 'catppuccin-latte' : 'kanagawa';
  await app.eval((t, m, p) => {
    const select = t.$(`select[data-setting="interface.${m}"]`);
    select.value = p;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, mode, pick);
  await until(async () => (await iface(app))[mode] === pick, 'the pick saved');
  assert.equal(await app.eval(async t => (await t.import('themes.js')).themeId()), pick);
  await app.eval(t => t.click('[data-theme-follow]'));
  await until(async () => (await iface(app)).theme === pick, 'off keeps the pick on screen');
}));

test('a setting found by the search opens on its own tab', () => withAppearance('appearance-search', async app => {
  await app.type('#set-search', 'line height');
  await until(() => app.eval(t => t.$$('.set-result-head').some(h => h.textContent === 'Appearance › Text')), 'the Text tab named in the results');
  await app.key('#set-search', 'Enter');
  await until(async () => (await app.text('.set-tab.on')) === 'Text', 'the Text tab opened');
  assert.equal(await app.eval(t => t.$('#set-title').textContent), 'Appearance');
}));
