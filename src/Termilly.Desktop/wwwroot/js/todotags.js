// @ts-check
// To do's Manage tags: every tag there is, in use or not. A tag can be made here, renamed (into another one merges them),
// recoloured and deleted, which takes it off its tasks.

import { openPopover } from './popups.js';
import { confirmDialog } from './dialogs.js';
import { swatchesHtml, TAG_LIST } from './tagpicker.js';
import { escapeHtml, cssColor, ICONS } from './ui.js';
import { find, targetOf } from './dom.js';
import { todoTags, tagColor, setTagColor, addTag, renameTag, deleteTag, nextTagColor } from './todo.js';
import { tagOfHeading } from './todolist.js';

const COLOR_INPUT = 'color';
const ROW = '.tm-row';

/**
 * A tag's row: its colour, its name to edit, how many tasks have it, and Delete.
 * @param {string} tag
 * @param {number} count
 * @param {boolean} recolor its colours show
 */
const rowHtml = (tag, count, recolor) => `
  <div class="tm-row" data-tag="${escapeHtml(tag)}">
    <span class="td-tag-color" data-recolor style="background:${cssColor(tagColor(tag))}" title="Change the colour"></span>
    <input class="tm-name" value="${escapeHtml(tag)}" spellcheck="false" autocomplete="off" aria-label="Tag name">
    <span class="tp-count">${count || ''}</span>
    <button class="pane-btn" data-delete title="Delete tag">${ICONS.trash}</button>
  </div>${recolor ? swatchesHtml(tagColor(tag)) : ''}`;

/**
 * The tags to show, those the field's text finds.
 * @param {string} query
 * @param {string | null} recolor the tag whose colours show
 */
function rowsHtml(query, recolor) {
  const rows = todoTags().filter(([tag]) => tag.includes(query)).map(([tag, count]) => rowHtml(tag, count, tag === recolor));
  return rows.join('') || `<div class="tp-empty">${query ? 'Press Enter to create this tag' : 'Type a name to create a tag'}</div>`;
}

/**
 * Takes a tag away, asking first when tasks have it.
 * @param {string} tag
 * @param {number} count
 * @param {(tag: string, to: string | null) => void} retagged
 */
async function askDelete(tag, count, retagged) {
  if (count && !await confirmDialog({ title: `Delete the tag ${tag}?`, body: `It comes off ${count === 1 ? 'one task' : `${count} tasks`}. The tasks stay.`, confirm: 'Delete' })) return;
  deleteTag(tag);
  retagged(tag, null);
}

/**
 * The list's clicks (a colour, Delete), the colour field, and a name changing.
 * @param {HTMLElement} list
 * @param {{ recolor: string | null }} pick the tag whose colours show
 * @param {() => void} draw
 * @param {(tag: string, to: string | null) => void} retagged
 */
function wireList(list, pick, draw, retagged) {
  list.addEventListener('click', e => {
    const target = targetOf(e);
    const tag = /** @type {HTMLElement | null} */ (target.closest(ROW))?.dataset.tag;
    const swatch = /** @type {HTMLElement | null} */ (target.closest('[data-color]'));
    if (swatch && pick.recolor) setTagColor(pick.recolor, /** @type {string} */ (swatch.dataset.color));
    else if (tag && target.closest('[data-recolor]')) pick.recolor = pick.recolor === tag ? null : tag;
    else if (tag && target.closest('[data-delete]')) {
      askDelete(tag, todoTags().find(([name]) => name === tag)?.[1] ?? 0, retagged).then(draw);
      return;
    } else return;
    draw();
  });
  // The colour field follows as it's moved; a name changes when it's left, or with Enter.
  list.addEventListener('input', e => {
    const field = /** @type {HTMLInputElement} */ (e.target);
    if (field.type === COLOR_INPUT && pick.recolor) setTagColor(pick.recolor, field.value);
  });
  list.addEventListener('change', e => {
    const field = /** @type {HTMLInputElement} */ (e.target);
    const tag = /** @type {HTMLElement | null} */ (field.closest(ROW))?.dataset.tag;
    const to = tagOfHeading(field.value.replace(/^#/, ''));
    if (tag && field.type !== COLOR_INPUT && to && to !== tag) {
      renameTag(tag, to);
      retagged(tag, to);
    }
    draw();
  });
  list.addEventListener('keydown', e => {
    if (e.key === 'Enter') /** @type {HTMLElement} */ (e.target).blur();
  });
}

/**
 * Opens the list of tags under a button.
 * @param {HTMLElement} at
 * @param {(tag: string, to: string | null) => void} retagged a tag was renamed, or deleted (to is null)
 */
export function openTagManager(at, retagged) {
  const box = at.ownerDocument.createElement('div');
  box.className = 'popover tag-picker tag-manager';
  box.hidden = true;
  box.innerHTML = `<input class="field" placeholder="Find or create a tag" spellcheck="false" autocomplete="off" aria-label="Tag"><div class="tp-list"></div>`;
  const input = /** @type {HTMLInputElement} */ (find(box, 'input'));
  const list = find(box, TAG_LIST);
  const query = () => tagOfHeading(input.value.replace(/^#/, ''));
  /** @type {{ recolor: string | null }} */
  const pick = { recolor: null };
  const draw = () => { list.innerHTML = rowsHtml(query(), pick.recolor); };

  input.addEventListener('input', draw);
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !query()) return;
    e.preventDefault();
    addTag(query(), nextTagColor());
    input.value = '';
    draw();
  });
  wireList(list, pick, draw, retagged);
  draw();
  openPopover(box, at, { dynamic: true });
  input.focus();
}
