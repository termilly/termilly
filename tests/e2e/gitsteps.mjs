// Steps the Git window's end-to-end tests share: what a person does in the window (open it, pick a file in a
// section, press a block's Stage, answer a dialog, press a note's Undo) and what they'd look at (the files in a
// section, the window's title), written once on top of the harness (harness.mjs).
import { setTimeout as delay } from 'node:timers/promises';

/** How long a git-side condition is waited for, and how often it's looked at. */
const WAIT_MS = 10000;
const POLL_MS = 100;

/**
 * Waits until `check` returns something truthy (git's state, a file's text), and returns it.
 * @template T
 * @param {() => T | Promise<T>} check
 * @param {string} what said when it never comes
 */
export async function until(check, what) {
  const end = Date.now() + WAIT_MS;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await delay(POLL_MS);
  }
  throw new Error(`Waited ${WAIT_MS} ms for ${what}; last saw ${JSON.stringify(last)}`);
}

/** Opens the Git window from the toolbar's Git button, and waits for its list. @param {any} app */
export async function openGit(app) {
  await app.click('#git-button');
  await app.waitFor('.git-win .gw-list .cw-row');
}

/**
 * The file names listed under a section of Changes (Staged, Changes, Untracked, Conflicts).
 * @param {any} app
 * @param {string} section
 * @returns {Promise<string[]>}
 */
export function filesIn(app, section) {
  return app.eval((t, name) => {
    const out = [];
    let current = null;
    for (const row of t.$$('.gw-list > .cw-row')) {
      if (row.classList.contains('gw-section')) current = row.querySelector('.cw-name')?.textContent;
      else if (current === name && row.classList.contains('gw-file')) out.push(row.querySelector('.cw-name')?.textContent);
    }
    return out;
  }, section);
}

/**
 * Clicks the first element matching `selector` whose text has `text` in it.
 * @param {any} app
 * @param {string} selector
 * @param {string} text
 * @param {object} [options] the harness's click options (shift, button)
 */
export async function clickText(app, selector, text, options) {
  const marked = await app.eval((t, sel, want) => {
    const el = t.$$(sel).find(e => e.textContent.includes(want));
    if (!el) return false;
    el.setAttribute('data-e2e-target', '');
    return true;
  }, selector, text);
  if (!marked) throw new Error(`No ${selector} with "${text}"`);
  await app.click('[data-e2e-target]', options);
  await app.eval(t => t.$$('[data-e2e-target]').forEach(e => e.removeAttribute('data-e2e-target')));
}

/**
 * Opens a file's diff from its row in a section of Changes.
 * @param {any} app
 * @param {string} section
 * @param {string} name
 */
export async function openFile(app, section, name) {
  const marked = await app.eval((t, sec, file) => {
    let current = null;
    for (const row of t.$$('.gw-list > .cw-row')) {
      if (row.classList.contains('gw-section')) current = row.querySelector('.cw-name')?.textContent;
      else if (current === sec && row.querySelector('.cw-name')?.textContent === file) {
        row.setAttribute('data-e2e-target', '');
        return true;
      }
    }
    return false;
  }, section, name);
  if (!marked) throw new Error(`${name} isn't under ${section}`);
  await app.click('[data-e2e-target]');
  await app.eval(t => t.$$('[data-e2e-target]').forEach(e => e.removeAttribute('data-e2e-target')));
  await app.waitFor('.gw-diff-path', { text: name });
}

/** Opens a row's menu (right click) and picks an entry by its words. */
export async function menu(app, rowSelector, label) {
  await app.contextmenu(rowSelector);
  await app.waitFor('.menu-row');
  await clickText(app, '.menu-row', label);
}

/** Says yes to the dialog that's open. @param {any} app */
export async function confirm(app) {
  await app.waitFor('[data-ok]');
  await app.click('[data-ok]');
  await app.waitFor('[data-ok]', { gone: true });
}

/**
 * Presses the button on the note that says `text` (Undo, Show).
 * @param {any} app
 * @param {string} text
 */
export async function noteAction(app, text) {
  await app.waitFor('.toast', { text });
  const marked = await app.eval((t, want) => {
    const toast = t.$$('.toast').find(e => e.textContent.includes(want));
    const button = toast?.querySelector('[data-toast-action]');
    button?.setAttribute('data-e2e-target', '');
    return !!button;
  }, text);
  if (!marked) throw new Error(`The note "${text}" has no button`);
  await app.click('[data-e2e-target]');
}

/** Switches the Git window to a tab by its name (Changes, History, Branches, Local history, Issues). */
export async function tab(app, name) {
  await clickText(app, '[data-gw-tab]', name);
  await app.waitFor('[data-gw-tab].on', { text: name });
}
