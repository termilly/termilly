// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startApp } from './harness.mjs';
import { makeRepo } from './repo.mjs';
import { until } from './gitsteps.mjs';

/** A 1x1 PNG, as the backgrounds folder keeps one: named by its content's hash (any 16 hex digits do here). */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PICTURE = '0123456789abcdef.png';

/** The page root's background attributes and variables (js/backgrounds.js). */
const rootState = app => app.eval(t => {
  const root = t.$('html');
  return { ...root.dataset, alpha: root.style.getPropertyValue('--window-alpha'), image: root.style.getPropertyValue('--backdrop-image') };
});
/** Sets background settings as the page's controls do. */
const setBackground = (app, patch) => app.eval(async (t, p) => {
  const { updateSettings } = await t.import('preferences.js');
  const { GROUPS } = await t.import('store.js');
  updateSettings(GROUPS.background, p);
}, patch);
/** Whether the focused terminal draws a background of its own (xterm's transparency). */
const terminalClear = app => app.eval(async t => {
  const { state } = await t.import('store.js');
  return [...state.tabs.values()][0]?.view?.term.options.allowTransparency;
});

/** A fresh app with a picture in its backgrounds folder. */
async function withApp(name, body) {
  const repo = await makeRepo();
  let app, failed = true;
  try {
    app = await startApp({ folder: repo.folder, name });
    await mkdir(path.join(app.dataDir, 'backgrounds'), { recursive: true });
    await writeFile(path.join(app.dataDir, 'backgrounds', PICTURE), PIXEL);
    await app.waitFor('.xterm');
    await body(app);
    failed = false;
  } finally { await app?.stop({ failed }); await repo.dispose(); }
}

test('Background is a tab of Appearance, solid and without a picture at first', () => withApp('background-tab', async app => {
  await app.eval(async t => (await t.import('settings.js')).openSettings('appearance-background'));
  await app.waitFor('[data-range-setting="background.opacity"]');
  assert.deepEqual(await app.eval(t => t.$$('.set-tab').map(b => b.textContent.trim())), ['Theme', 'Background', 'Text', 'Layout']);
  assert.equal(await app.text('.set-range-value'), '100%');
  const state = await rootState(app);
  assert.equal(state.seeThrough, undefined, 'solid, as before');
  assert.equal(state.backdrop, undefined);
  assert.equal(await terminalClear(app), false);
  assert.ok(await app.eval(t => !!t.$('[data-background-choose]')));
}));

test('below 100% the window is see-through and the terminals draw nothing behind their text', () => withApp('background-see-through', async app => {
  await setBackground(app, { opacity: 70 });
  await until(async () => (await rootState(app)).seeThrough === '', 'see-through');
  assert.equal((await rootState(app)).alpha, '0.7');
  await until(async () => (await terminalClear(app)) === true, 'the terminals are clear');
  assert.match(await app.eval(t => globalThis.getComputedStyle(t.$('body')).backgroundColor), /rgba?\(.*0\.7\)|color\(srgb .* \/ 0\.7\)/);
  await setBackground(app, { solidTerminals: true });
  await until(async () => (await terminalClear(app)) === false, 'Solid terminals keep their colour');
  await setBackground(app, { opacity: 100, solidTerminals: false });
  await until(async () => (await rootState(app)).seeThrough === undefined, 'solid again');
}));

test('a picture shows behind the terminals, then the whole window, served from the backgrounds folder', () => withApp('background-picture', async app => {
  await setBackground(app, { picture: PICTURE, dim: 40, blur: 4 });
  await until(async () => (await rootState(app)).backdrop === 'terminals', 'behind the terminals');
  assert.match((await rootState(app)).image, new RegExp(PICTURE));
  await until(async () => (await terminalClear(app)) === true, 'the picture shows through the terminals');
  const loaded = await app.eval(async t => {
    const url = /url\("(.*)"\)/.exec(t.$('html').style.getPropertyValue('--backdrop-image'))?.[1] ?? '';
    const image = new globalThis.Image();
    image.src = url;
    await image.decode();
    return image.naturalWidth;
  });
  assert.equal(loaded, 1, 'the picture loads');
  await setBackground(app, { behind: 'window' });
  await until(async () => (await rootState(app)).backdrop === 'window', 'behind the whole window');
  await setBackground(app, { picture: null });
  await until(async () => (await rootState(app)).backdrop === undefined, 'no picture');
  assert.equal(await terminalClear(app), false);
}));

test('a workspace’s own background, from its right-click menu, wins over the window’s', () => withApp('background-workspace', async app => {
  await setBackground(app, { picture: PICTURE });
  await until(async () => (await rootState(app)).backdrop === 'terminals', 'the window’s picture');
  await app.eval(t => t.contextmenu('.ws-row'));
  await app.waitFor('.menu-row');
  await app.eval(t => t.$$('.menu-row').find(r => r.textContent.trim() === 'Background').click());
  await until(() => app.eval(t => t.$$('.menu-row').some(r => r.textContent.trim() === 'Ember')), 'the gradients');
  await app.eval(t => t.$$('.menu-row').find(r => r.textContent.trim() === 'Ember').click());
  await until(async () => (await rootState(app)).image.startsWith('linear-gradient'), 'Ember on screen');
  const saved = await app.eval(async t => (await t.import('store.js')).activeWs()?.background);
  assert.deepEqual(saved, { kind: 'gradient', gradient: 'ember' });
  await app.eval(async t => {
    const { setWorkspaceBackground } = await t.import('workspacebackground.js');
    setWorkspaceBackground((await t.import('store.js')).activeWs(), { kind: 'none' });
  });
  await until(async () => (await rootState(app)).backdrop === undefined, 'None: no background here');
  await app.eval(async t => {
    const { setWorkspaceBackground } = await t.import('workspacebackground.js');
    setWorkspaceBackground((await t.import('store.js')).activeWs(), undefined);
  });
  await until(async () => (await rootState(app)).backdrop === 'terminals', 'Same as the window again');
}));

test('Theme gradient paints the accent, background and magenta until its colours are picked from the theme', () => withApp('background-gradient-colors', async app => {
  await app.eval(async t => (await t.import('settings.js')).openSettings('appearance-background'));
  await app.waitFor('[data-setting="background.gradientGlow"]');
  const glowRow = '[data-setting="background.gradientGlow"]', secondRow = '[data-setting="background.gradientSecondGlow"]';
  const offered = row => app.eval((t, s) => t.$$(`${s} [data-value]`).map(b => b.dataset.value), row);
  // The theme's own colours, not the terminal's; a terminal colour already set (Second glow's magenta) still shows.
  assert.deepEqual(await offered(glowRow), ['accent', 'background', 'surface', 'text', 'muted'], "the theme's colours");
  assert.deepEqual(await offered(secondRow), ['accent', 'background', 'surface', 'text', 'muted', 'magenta'], 'and the magenta it has');
  assert.ok(await app.eval((t, s) => t.$(s).closest('.set-row').classList.contains('needs-off'), glowRow), 'waits for Theme gradient');

  await app.click('[data-setting="background.themeGradient"]');
  await until(async () => (await rootState(app)).themeGradient === '', 'Theme gradient on');
  const before = (await rootState(app)).image;
  assert.match(before, /var\(--accent\) 65%, var\(--bg\)/, 'the accent over the background, as before');
  assert.match(before, /var\(--hl-title\) 85%/, 'magenta at the bottom right, as before');
  await app.screenshot('gradient-default');

  await app.click(`${glowRow} [data-value="background"]`);
  await app.click(`${secondRow} [data-value="text"]`);
  await until(async () => /var\(--text\) 85%/.test((await rootState(app)).image), 'the text colour at the bottom right');
  assert.match((await rootState(app)).image, /var\(--bg\) 65%, var\(--bg\)/, 'no accent left in it');
  await until(() => app.eval((t, s) => t.$(`${s} .on`)?.dataset.value === 'text', secondRow), 'Text shows as picked');
  assert.ok(await app.eval((t, s) => t.$(`${s} [data-value="background"]`).classList.contains('on'), glowRow));
  const saved = await app.eval(async t => (await t.import('store.js')).state.settings.background);
  assert.equal(saved.gradientGlow, 'background');
  assert.equal(saved.gradientSecondGlow, 'text');
  await app.screenshot('gradient-picked');
}));
