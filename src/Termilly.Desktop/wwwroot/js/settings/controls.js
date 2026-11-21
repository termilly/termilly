// @ts-check
// The building blocks the Settings sections are written with. A control bound to a setting carries its key
// (data-setting="group.key"); the page shows the value and saves changes for every such control.

import { escapeHtml } from '../ui.js';

/**
 * Sets a slider (type=range) to a value, with its track filled up to it (--fill, in app.css).
 * @param {HTMLInputElement} range
 * @param {number} value
 */
export function setRange(range, value) {
  const min = Number(range.min), max = Number(range.max);
  range.value = String(value);
  range.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
}

/** Marks a switch in a row's `needs` that has to be off. */
const NEEDS_OFF = '!';

/**
 * Whether a row's `needs` (see row) aren't met: a switch it needs is off, or one that takes its place is on.
 * @param {string} needs
 * @param {(key: string) => unknown} setting
 */
export const needsUnmet = (needs, setting) => needs.split(',').some(need => (need.startsWith(NEEDS_OFF)
  ? !!setting(need.slice(NEEDS_OFF.length))
  : !setting(need)));

/**
 * Greys a row out (css/settings.css), its controls out of reach of the mouse and the keyboard, or makes it usable again.
 * @param {HTMLElement} row
 * @param {boolean} off
 */
export function greyOut(row, off) {
  row.classList.toggle('needs-off', off);
  for (const control of /** @type {NodeListOf<HTMLButtonElement>} */ (row.querySelectorAll('button, input, select'))) control.disabled = off;
}

/**
 * A labelled row: title and description on the left, the control on the right (or below with `stack`).
 * `keywords` are other words the search finds it by. `needs` is a switch it depends on ("group.key", or several
 * with commas): while one is off, the row is greyed out and can't be changed. "!group.key" is a switch that takes the
 * row's place: while that one is on, the row is greyed out.
 * @param {string} label
 * @param {string} description
 * @param {string} control
 * @param {{ stack?: boolean, keywords?: string, needs?: string }} [options]
 */
export const row = (label, description, control, { stack = false, keywords = '', needs = '' } = {}) => `
  <div class="set-row${stack ? ' stack' : ''}"${keywords ? ` data-keywords="${escapeHtml(keywords)}"` : ''}${needs ? ` data-needs="${needs}"` : ''}>
    <div class="set-label"><div class="set-name">${label}</div>${description ? `<div class="set-desc">${description}</div>` : ''}</div>
    <div class="set-control">${control}</div>
  </div>`;

/**
 * Segmented choice bound to a setting. Options: [value, label, icon?].
 * @param {string} key
 * @param {Array<[string | number, string, string?]>} options
 * @param {{ firstIfNone?: boolean }} [how] firstIfNone: a value not among the options shows as the first one (what
 *   the app uses instead, as with an effect this system doesn't have).
 */
export const seg = (key, options, how = {}) => `
  <span class="seg" data-setting="${key}"${how.firstIfNone ? ' data-first-if-none' : ''}>${options.map(([value, label, icon]) =>
    `<button data-value="${value}">${icon ?? ''}${label}</button>`).join('')}</span>`;

/**
 * Choices for a segmented control from a setting's list of values, each with its label.
 * @template T
 * @param {readonly T[]} values
 * @param {(value: T) => string} label
 * @returns {Array<[T, string]>}
 */
export const choices = (values, label) => values.map(value => [value, label(value)]);

/**
 * A slider bound to a setting, with its value beside it (data-range-setting: settings.js shows it and saves it as it
 * moves).
 * @param {string} key
 * @param {{ min: number, max: number }} range
 * @param {string} unit what the value is shown with: '%' or 'px'
 * @param {string} label
 */
export const slider = (key, { min, max }, unit, label) => `<div class="size-control">
    <input class="set-range" type="range" min="${min}" max="${max}" step="1" data-range-setting="${key}" data-unit="${unit}" aria-label="${label}">
    <span class="set-range-value"></span>
  </div>`;

/** An on/off switch bound to a setting. @param {string} key */
export const toggle = key => `<button class="switch" role="switch" data-setting="${key}" aria-label="${key}"><span></span></button>`;

/**
 * Rows under a heading (none with '').
 * @param {string} heading
 * @param {string} rows
 */
export const group = (heading, rows) => `<section class="set-group">${heading ? `<h4>${heading}</h4>` : ''}${rows}</section>`;
