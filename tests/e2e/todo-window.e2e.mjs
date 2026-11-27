// @ts-check
// To do in a window of its own: the window's title bar has Close, so the list's own Detach and Close are hidden there,
// as Notepad's are; docked in the main window they show.
// Covers: js/todopanel.js js/todo*.js css/todo.css
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.mjs';
import { until } from './gitsteps.mjs';

/** Whether To do's Detach and Close buttons show, and whether its list is in a window of its own (one gone is in neither). */
const buttons = app => app.eval(t => {
  const panel = t.$('.todo-panel');
  return {
    detach: t.visible('[data-td="detach"]'), close: t.visible('[data-td="close"]'),
    windowed: !!panel?.ownerDocument.body.classList.contains('detached-window'),
  };
});

test('docked, To do shows its Detach and Close; in a window of its own, it shows neither', async () => {
  let app, failed = true;
  try {
    app = await startApp({ name: 'todo-window' });
    await app.waitFor('.xterm');
    await app.eval(async t => (await t.import('todopanel.js')).toggleTodo());
    await app.waitFor('[data-td="detach"]');
    assert.deepEqual(await buttons(app), { detach: true, close: true, windowed: false });
    await app.click('[data-td="detach"]');
    await until(async () => (await buttons(app)).windowed, 'To do in a window of its own');
    assert.deepEqual(await buttons(app), { detach: false, close: false, windowed: true });
    failed = false;
  } finally {
    await app?.stop({ failed });
  }
});
