// @ts-check
// The building blocks the Settings sections are written with. A control bound to a setting carries its key
// (data-setting="group.key"); the page shows the value and saves changes for every such control.

import { escapeHtml } from '../ui.js';

/**
 * A labelled row: title and description on the left, the control on the right (or below with `stack`).
 * `keywords` are other words the search finds it by.
 * @param {string} label
 * @param {string} description
 * @param {string} control
 * @param {{ stack?: boolean, keywords?: string }} [options]
 */
export const row = (label, description, control, { stack = false, keywords = '' } = {}) => `
  <div class="set-row${stack ? ' stack' : ''}"${keywords ? ` data-keywords="${escapeHtml(keywords)}"` : ''}>
    <div class="set-label"><div class="set-name">${label}</div>${description ? `<div class="set-desc">${description}</div>` : ''}</div>
    <div class="set-control">${control}</div>
  </div>`;

/**
 * Segmented choice bound to a setting. Options: [value, label, icon?].
 * @param {string} key
 * @param {Array<[string | number, string, string?]>} options
 */
export const seg = (key, options) => `
  <span class="seg" data-setting="${key}">${options.map(([value, label, icon]) =>
    `<button data-value="${value}">${icon ?? ''}${label}</button>`).join('')}</span>`;

/**
 * Choices for a segmented control from a setting's list of values, each with its label.
 * @template T
 * @param {readonly T[]} values
 * @param {(value: T) => string} label
 * @returns {Array<[T, string]>}
 */
export const choices = (values, label) => values.map(value => [value, label(value)]);

/** An on/off switch bound to a setting. @param {string} key */
export const toggle = key => `<button class="switch" role="switch" data-setting="${key}" aria-label="${key}"><span></span></button>`;

/**
 * Rows under a heading (none with '').
 * @param {string} heading
 * @param {string} rows
 */
export const group = (heading, rows) => `<section class="set-group">${heading ? `<h4>${heading}</h4>` : ''}${rows}</section>`;
