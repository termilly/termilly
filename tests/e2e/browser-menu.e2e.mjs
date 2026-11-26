// Right-clicks across the app (js/browsermenu.js): the browser's own menu shows nowhere, and a text field with no menu
// of its own gets Termilly's text menu, with what fits the field (a read-only one can't take a paste, a password can't
// be copied). Termilly's own menus still open. Run with: npm run e2e (on Linux, under Xvfb).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';

let app;
let failed = false;

/** A test that marks the run failed (with a screenshot of the moment) when it throws. @param {string} name @param {() => Promise<void>} run */
const step = (name, run) => test(name, async () => {
  try {
    await run();
  } catch (e) {
    failed = true;
    await app?.screenshot(name.replace(/\W+/g, '-')).catch(() => null);
    throw e;
  }
});

/**
 * Right-clicks an element: whether the browser's menu would show, and the rows of the menu that opened (each with
 * whether it's on), closing it after.
 * @param {string} selector
 */
const rightClick = selector => app.eval(async (t, selector) => {
  const el = t.$(selector);
  const realm = el.ownerDocument.defaultView;
  const browserMenu = el.dispatchEvent(new realm.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
  const rows = t.$$('.context-menu .menu-row').map(b => `${b.querySelector('.menu-label').textContent.trim()}${b.disabled ? ' (off)' : ''}`);
  (await t.import('popups.js')).closeAll();
  return { browserMenu, rows };
}, selector);

before(async () => {
  app = await startApp({ name: 'browser-menu' });
  await app.waitFor('.pane .xterm');
  // Fields of each kind, as any window may have them.
  await app.eval(t => {
    const box = t.$('body').ownerDocument.createElement('div');
    box.id = 'e2e-fields';
    box.innerHTML = '<input id="e2e-text" value="hello"><input id="e2e-empty"><input id="e2e-read" value="fixed" readonly>'
      + '<input id="e2e-secret" type="password" value="pw"><input id="e2e-number" type="number" value="3"><textarea id="e2e-area">notes</textarea>';
    t.$('body').append(box);
  });
});

after(async () => { await app?.stop({ failed }); });

step('no browser menu where Termilly has none: the window, its bars, the terminal area', async () => {
  for (const selector of ['body', '#titlebar', '.pane']) {
    assert.deepEqual(await rightClick(selector), { browserMenu: false, rows: [] }, selector);
  }
});

step('a text field gets Termilly\'s text menu, with what fits the field, and never the browser\'s', async () => {
  const typed = ['Cut (off)', 'Copy (off)', 'Paste', 'Paste as plain text'];
  assert.deepEqual(await rightClick('#e2e-text'), { browserMenu: false, rows: [...typed, 'Select all'] });
  assert.deepEqual(await rightClick('#e2e-empty'), { browserMenu: false, rows: [...typed, 'Select all (off)'] });
  assert.deepEqual(await rightClick('#e2e-area'), { browserMenu: false, rows: [...typed, 'Select all'] });
  assert.deepEqual(await rightClick('#e2e-read'), { browserMenu: false, rows: ['Copy (off)', 'Select all'] });
  assert.deepEqual(await rightClick('#e2e-number'), { browserMenu: false, rows: [] });
});

step('a name being edited in a terminal\'s header gets the text menu, not the tab\'s', async () => {
  await app.eval(async t => {
    const { state } = await t.import('store.js');
    (await t.import('rename.js')).beginRename([...state.tabs.values()][0]);
    await t.waitFor('.rename-input');
  });
  const { browserMenu, rows } = await rightClick('.rename-input');
  await app.eval(t => t.$('.rename-input').dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(browserMenu, false);
  assert.ok(rows.includes('Paste') && rows.includes('Select all'), rows.join(', '));
});

step('a selection can be copied, but a password\'s can\'t', async () => {
  const selected = await app.eval(async t => {
    const rows = id => {
      const el = t.$(id);
      el.focus();
      el.select();
      el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return t.$$('.context-menu .menu-row').map(b => `${b.querySelector('.menu-label').textContent.trim()}${b.disabled ? ' (off)' : ''}`);
    };
    const text = rows('#e2e-text');
    (await t.import('popups.js')).closeAll();
    const secret = rows('#e2e-secret');
    (await t.import('popups.js')).closeAll();
    return { text, secret };
  });
  assert.deepEqual(selected.text.slice(0, 2), ['Cut', 'Copy']);
  assert.deepEqual(selected.secret.slice(0, 2), ['Cut (off)', 'Copy (off)']);
});

step('Select all selects the field\'s text', async () => {
  const all = await app.eval(async t => {
    const el = t.$('#e2e-area');
    el.focus();
    el.setSelectionRange(0, 0);
    el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    t.$$('.context-menu .menu-row').find(b => b.querySelector('.menu-label').textContent.trim() === 'Select all').click();
    await new Promise(r => setTimeout(r, 50));
    return [el.selectionStart, el.selectionEnd];
  });
  assert.deepEqual(all, [0, 'notes'.length]);
});

step('Termilly\'s own menus still open, and only they do', async () => {
  const { browserMenu, rows } = await rightClick('#sidebar .tab-row, #sidebar [data-tab]');
  assert.equal(browserMenu, false);
  assert.ok(rows.length > 0 && !rows.includes('Paste as plain text'), rows.join(', '));
});
