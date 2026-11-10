// @ts-check
// Implementing many tasks at once (the Active header's Implement button, To do's js/todopanel.js): before they start, a
// dialog lists them with their tags, and says which of those picked are left out (not open).

import { modal, CONFIRM_DIALOG } from './dialogs.js';
import { escapeHtml, cssColor } from './ui.js';
import { tagColor } from './todo.js';

/** @param {string} tag */
const tagHtml = tag => `<span class="td-chip" style="--td-hue:${cssColor(tagColor(tag))}">${escapeHtml(tag)}</span>`;

/** A task in the dialog's list: its text, then its tags. @param {TodoTask} task */
const taskHtml = task => `<li><span class="td-bulk-text">${escapeHtml(task.text)}</span>${(task.tags ?? []).map(tagHtml).join('')}</li>`;

/** How many tasks, in words. @param {number} count */
export const tasksWord = count => (count === 1 ? 'one task' : `${count} tasks`);

/**
 * Asks to start an agent on each of these tasks. Resolves true to go ahead.
 * @param {{ tasks: TodoTask[], by: string, left: number }} question by: who does the work; left: how many picked aren't open
 * @returns {Promise<boolean>}
 */
export function confirmImplement({ tasks, by, left }) {
  const leftOut = left ? ` ${left === 1 ? 'One task isn’t' : `${left} tasks aren’t`} open, so ${left === 1 ? 'it is' : 'they are'} left out.` : '';
  return modal(CONFIRM_DIALOG, `
    <h3>Implement ${tasksWord(tasks.length)}?</h3>
    <p class="dialog-sub">${escapeHtml(`${by} starts on each of these.${leftOut}`)}</p>
    <ul class="td-bulk">${tasks.map(taskHtml).join('')}</ul>
    <div class="dialog-actions">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-ok autofocus>Implement</button>
    </div>`, (_dialog, close) => ({ submit: () => close(true) })).then(result => result === true);
}
