// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until } from './gitsteps.mjs';

/** The names of the gallery's cards that are drawn (not only marked hidden). */
const shownCards = app => app.eval(t => t.$$('.theme-card').filter(c => c.getClientRects().length).map(c => c.querySelector('.tc-name').textContent));
/** How far past the tools the page is scrolled, in px: several rows of cards. */
const SCROLL_PAST = 400;
/** The settings body's height in the sticky test. */
const SHORT_BODY_PX = 320;
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

test('Appearance has Theme, Background, Text and Layout tabs, and a tab keeps the title Appearance', () => withAppearance('appearance-tabs', async app => {
  assert.deepEqual(await app.eval(t => t.$$('.set-tab').map(b => b.textContent)), ['Theme', 'Background', 'Text', 'Layout']);
  assert.equal(await app.text('.set-tab.on'), 'Theme');
  await app.eval(t => t.click('.set-tab[data-section="appearance-text"]'));
  await app.waitFor('.font-picker');
  assert.equal(await app.text('.set-tab.on'), 'Text');
  assert.equal(await app.eval(t => t.$('#set-title').textContent), 'Appearance');
  await app.eval(t => t.click('.set-tab[data-section="appearance-layout"]'));
  await until(async () => (await app.text('.set-tab.on')) === 'Layout', 'the Layout tab');
  assert.equal(await app.eval(t => t.$$('.set-row .set-name').some(n => n.textContent === 'Terminal names')), true);
  // The keyboard moves between tabs and stays on them; the body is the open tab's panel.
  await app.key('.set-tab.on', 'Home');
  await until(async () => (await app.text('.set-tab.on')) === 'Theme', 'Home opens the first tab');
  await app.key('.set-tab.on', 'ArrowRight');
  await until(async () => (await app.text('.set-tab.on')) === 'Background', 'Right opens the next tab');
  await app.key('.set-tab.on', 'End');
  await until(async () => (await app.text('.set-tab.on')) === 'Layout', 'End opens the last tab');
  await app.key('.set-tab.on', 'ArrowRight');
  await until(async () => (await app.text('.set-tab.on')) === 'Theme', 'Right on the last goes round to the first');
  await app.key('.set-tab.on', 'ArrowLeft');
  await until(async () => (await app.text('.set-tab.on')) === 'Layout', 'Left on the first goes round to the last');
  await app.key('.set-tab.on', 'ArrowLeft');
  assert.equal(await app.eval(t => t.$('.set-tab.on') === t.$('.set-tab.on').ownerDocument.activeElement), true);
  assert.equal(await app.eval(t => t.$('#set-body').getAttribute('aria-labelledby')), 'set-tab-appearance-text');
}));

test('the gallery is one list, well-known schemes first, names only, searches and filters dark and light', () => withAppearance('appearance-gallery', async app => {
  const names = await app.eval(t => t.$$('.theme-cards .tc-name').map(n => n.textContent));
  assert.deepEqual(names.slice(0, 3), ['Midnight', 'Catppuccin Mocha', 'Catppuccin Latte']);
  assert.equal(names[12], 'Dark', 'Termilly’s own come after the 12 well-known ones');
  assert.equal(await app.eval(t => t.$$('.theme-cards').length), 1);
  assert.equal(await app.eval(t => !!t.$('.theme-card[data-theme-id="midnight"] .tc-like')), false, 'names only, as in 1.9.3');
  assert.equal((await shownCards(app)).length, await app.eval(t => t.$$('.theme-card').length), 'all themes show');
  await app.type('.theme-search', 'dracula');
  await until(async () => (await shownCards(app)).join() === 'Midnight', 'Dracula finds Midnight');
  await app.type('.theme-search', 'nothing like this');
  await until(() => app.eval(t => !t.$('.theme-none').hidden), 'the no-match line');
  await app.type('.theme-search', '');
  await until(async () => (await shownCards(app)).length === await app.eval(t => t.$$('.theme-card').length), 'all back');
  const gap = await app.eval(t => t.$('.theme-cards').getBoundingClientRect().top - t.$('.theme-search').getBoundingClientRect().bottom);
  assert.ok(gap >= 14, `room between the tools and the cards (${gap}px)`);
  await app.eval(t => t.click('[data-theme-filter="light"]'));
  const light = await app.eval(t => t.$$('.theme-card').filter(c => c.getClientRects().length).map(c => c.dataset.base));
  assert.ok(light.length > 0 && light.every(b => b === 'light'), 'only light themes');
  assert.ok((await shownCards(app)).includes('Catppuccin Latte'));
  // Settings search still finds the gallery by a well-known scheme's name.
  await app.type('#set-search', 'dracula');
  await until(() => app.eval(t => t.$$('.set-result-head').some(h => h.textContent === 'Appearance › Theme')), 'Dracula found in Theme');
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

test('the search and buttons stay on top while the cards scroll, and a long name is cut short', () => withAppearance('appearance-sticky', async app => {
  assert.equal(await app.eval(t => t.$$('.set-desc').some(d => d.textContent === 'Default theme per mode')), true);
  const long = 'A very long imported theme name that never fits a card';
  await app.eval(async (t, name) => {
    const { updateSettings } = await t.import('preferences.js');
    const { GROUPS } = await t.import('store.js');
    const base = { background: '#000000', foreground: '#ffffff', cursor: null, ansi: Array(16).fill('#808080') };
    updateSettings(GROUPS.interface, { customThemes: [{ ...base, id: 'custom-long', name }] });
    (await t.import('settings.js')).openSettings('appearance');
  }, long);
  await app.waitFor('.theme-card[data-theme-id="custom-long"]');
  const card = await app.eval(t => {
    const [first, second] = t.$$('.theme-card');
    const name = first.querySelector('.tc-name');
    return { cut: name.scrollWidth > name.clientWidth, same: Math.abs(first.offsetWidth - second.offsetWidth) <= 1, title: first.title };
  });
  assert.equal(card.cut, true, 'the name is cut short');
  assert.equal(card.same, true, 'the card keeps its column width');
  assert.match(card.title, new RegExp(`^${long}`), 'the whole name in the tooltip');
  // A short body, so the gallery always has room to scroll whatever the window's size.
  await app.eval(t => { t.$('#set-body').style.maxHeight = `${SHORT_BODY_PX}px`; });
  const before = await app.eval(t => t.$('.theme-tools').getBoundingClientRect().top - t.$('#set-body').getBoundingClientRect().top);
  await app.eval((t, by) => { t.$('#set-body').scrollTop = t.$('.theme-tools').offsetTop + by; }, SCROLL_PAST);
  await until(() => app.eval(t => t.$('#set-body').scrollTop > 0), 'scrolled');
  const after = await app.eval(t => {
    const body = t.$('#set-body').getBoundingClientRect();
    const tools = t.$('.theme-tools').getBoundingClientRect();
    return { top: tools.top - body.top, onTop: t.$('.theme-tools').contains(globalThis.document.elementFromPoint(tools.left + 4, tools.top + tools.height / 2)) };
  });
  assert.ok(before > 0 && after.top >= -1 && after.top <= 1, `the tools stay at the top (${after.top}px)`);
  assert.equal(after.onTop, true, 'nothing scrolls over them');
}));
