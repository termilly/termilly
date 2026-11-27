// Opening a layout (js/layouts.js applyLayout: a .termilly.yml, or one exported from a workspace): its terminals come
// back where they were, and a tab group shows the tab that was showing when it was saved. Run with: npm run e2e (on
// Linux, under Xvfb).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';

let app;
let failed = false;

before(async () => {
  app = await startApp({ name: 'layout-import' });
});

after(async () => { await app?.stop({ failed }); });

test('a tab group on the left keeps its second tab showing after the layout opens', async () => {
  try {
    const shown = await app.eval(async t => {
      const { applyLayout } = await t.import('layouts.js');
      const { state, tabsOf, groupOf } = await t.import('store.js');
      const ws = applyLayout({
        name: 'Imported',
        layout: {
          split: 'row',
          panes: [
            { tabs: [{ terminal: { name: 'first' } }, { terminal: { name: 'second' } }], active: 1 },
            { terminal: { name: 'right' } },
          ],
        },
      });
      await new Promise(r => setTimeout(r, 300)); // once drawn
      const byName = name => tabsOf(ws).find(tab => tab.name === name);
      const second = byName('second');
      // On screen as a user sees it: a group's other tabs stay laid out, hidden (visibility).
      const visible = tab => !!tab?.view?.el?.checkVisibility({ visibilityProperty: true });
      return {
        active: tabsOf(ws).find(tab => tab.id === groupOf(ws, second.id)?.active)?.name,
        secondVisible: visible(second),
        firstVisible: visible(byName('first')),
        workspaceShown: state.activeId === ws.id,
      };
    });
    assert.equal(shown.workspaceShown, true, 'the opened workspace is in front');
    assert.equal(shown.active, 'second', 'the group still has its second tab selected');
    assert.equal(shown.secondVisible, true, 'the second tab is on screen');
    assert.equal(shown.firstVisible, false, 'the first tab is behind it');
  } catch (e) {
    failed = true;
    await app?.screenshot('layout-import').catch(() => null);
    throw e;
  }
});
