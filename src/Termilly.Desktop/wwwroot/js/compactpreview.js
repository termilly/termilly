// @ts-check
// A compact view card's preview (js/compact.js): all the question the agent waits on says (the whole command, the
// diff, the plan), in a dialog with its choices, where the card shows only the lines nearest its question.

import { modal } from './dialogs.js';
import { escapeHtml } from './ui.js';
import { targetOf } from './dom.js';
import { previewLines, choiceHtml, menuKey } from './compactcard.js';

/** The dialog's class (statusbar.css styles it). */
const DIALOG_CLASS = 'cv-preview';
/** Its choice buttons: data-choice holds the key that picks it. */
const CHOICE = '[data-choice]';

/**
 * Shows the preview; a choice picked in it (a click, or Enter on it: data-no-enter keeps the dialog's Enter off it)
 * closes it and is passed on (the caller checks the agent still waits on this question).
 * @param {import('./compactcard.js').Menu} menu
 * @param {string} name the agent's short name
 * @param {(key: string) => void} pick
 */
export function showPreview(menu, name, pick) {
  const choices = menuKey(menu) ? menu.choices.map(choiceHtml).join('') : '';
  return modal(DIALOG_CLASS, `
    <h3>${escapeHtml(name)} asks</h3>
    <pre class="cv-preview-text">${escapeHtml(previewLines(menu).join('\n'))}</pre>
    ${choices ? `<div class="cv-choices" data-no-enter>${choices}</div>` : ''}
    <div class="dialog-actions"><button class="btn" data-cancel autofocus>Close</button></div>`, (dialog, close) => {
    dialog.addEventListener('click', e => {
      const choice = /** @type {HTMLElement | null} */ (targetOf(e).closest(CHOICE));
      if (!choice) return;
      close(null);
      pick(choice.dataset.choice ?? '');
    });
    return { submit: () => close(null) };
  });
}
