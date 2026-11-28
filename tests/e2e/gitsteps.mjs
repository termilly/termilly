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
  await noTour(app);
  await app.click('#git-button');
  await app.waitFor('.git-win .gw-list > .cw-row, .git-win .gw-list > .gw-empty:not(:empty)');
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
  // Found and clicked in one go (the list can be drawn again between two steps), once it shows: a list still
  // loading gets the time a person would give it.
  const clicked = await until(() => app.eval((t, sel, want, how) => {
    const el = t.$$(sel).find(e => e.textContent.includes(want));
    if (!el) return false;
    el.setAttribute('data-e2e-target', '');
    try {
      t.click('[data-e2e-target]', how);
    } finally {
      el.removeAttribute('data-e2e-target');
    }
    return true;
  }, selector, text, options ?? {}), `${selector} with "${text}"`);
  if (!clicked) throw new Error(`No ${selector} with "${text}"`);
}

/**
 * Opens a file's diff from its row in a section of Changes.
 * @param {any} app
 * @param {string} section
 * @param {string} name
 */
export async function openFile(app, section, name) {
  const clicked = await app.eval((t, sec, file) => {
    let current = null;
    for (const row of t.$$('.gw-list > .cw-row')) {
      if (row.classList.contains('gw-section')) current = row.querySelector('.cw-name')?.textContent;
      else if (current === sec && row.querySelector('.cw-name')?.textContent === file) {
        row.setAttribute('data-e2e-target', '');
        try {
          t.click('[data-e2e-target]');
        } finally {
          row.removeAttribute('data-e2e-target');
        }
        return true;
      }
    }
    return false;
  }, section, name);
  if (!clicked) throw new Error(`${name} isn't under ${section}`);
  await app.waitFor('.gw-diff-path', { text: name });
}

/** Opens a row's menu (right click) and picks an entry by its words. */
export async function menu(app, rowSelector, label) {
  // Found and right-clicked in one go, once it shows: a refresh can draw the list again between two steps.
  await until(() => app.eval((t, sel) => {
    if (!t.$(sel)) return false;
    t.contextmenu(sel);
    return true;
  }, rowSelector), `${rowSelector} to right-click`);
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
  const pressed = await app.eval((t, want) => {
    const toast = t.$$('.toast').find(e => e.textContent.includes(want));
    const button = toast?.querySelector('[data-toast-action]');
    if (!button) return false;
    button.setAttribute('data-e2e-target', '');
    t.click('[data-e2e-target]');
    return true;
  }, text);
  if (!pressed) throw new Error(`The note "${text}" has no button`);
}

/** Switches the Git window to a tab by its name (Changes, History, Branches, Local history, Issues). */
export async function tab(app, name) {
  // Shown once the window knows the repository (a tab it doesn't apply to stays hidden).
  await clickText(app, '[data-gw-tab]:not([hidden])', name);
  await app.waitFor('[data-gw-tab].on', { text: name });
}

/**
 * No welcome tour: offered a few seconds after a first start (later on a slower machine), its card closes what a step
 * just opened. Marked seen, so it isn't offered, and stopped if it already began.
 * @param {any} app
 */
export async function noTour(app) {
  await app.eval(async t => {
    const { GROUPS } = await t.import('store.js');
    (await t.import('preferences.js')).updateSettings(GROUPS.uiState, { tourSeen: true });
    const tour = await t.import('tour.js');
    if (tour.tourActive()) tour.stopTour();
  });
}

/** Skips the welcome tour a first start offers: it would sit over everything, and hold the keyboard. */
export async function skipTour(app) {
  await app.eval(async () => {
    for (let i = 0; i < 20 && !globalThis.document.querySelector('.tour-skip, [data-tour="skip"]'); i++) await new Promise(r => setTimeout(r, 100));
    const skip = [...globalThis.document.querySelectorAll('button, a, span')].find(el => el.textContent.trim() === 'Skip tour');
    skip?.click();
  });
}
