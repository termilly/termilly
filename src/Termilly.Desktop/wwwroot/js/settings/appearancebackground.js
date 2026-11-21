// @ts-check
// Settings › Appearance › Background: how see-through the window is and what shows through it, and a picture behind
// the terminals or the whole window (js/backgrounds.js shows them; the host makes the window see-through).

import { request } from '../host.js';
import { PAGE } from '../protocol.js';
import { getSetting } from '../store.js';
import { setSetting } from '../preferences.js';
import { ICONS, escapeHtml } from '../ui.js';
import { row, seg, toggle, group, slider } from './controls.js';
import { SECTION, redraw } from './page.js';
import { BACKGROUND } from '../constants.js';
import { targetOf, showError } from '../dom.js';
import { effects, pictureUrl } from '../backgrounds.js';

const { effect: EFFECT, opacity: OPACITY, fit: FIT, dim: DIM, blur: BLUR, behind: BEHIND } = BACKGROUND;

/**
 * Each effect's name in the choice.
 * @type {Readonly<Record<string, string>>}
 */
const EFFECT_LABEL = Object.freeze({ [EFFECT.none]: 'None', [EFFECT.blur]: 'Blur', [EFFECT.acrylic]: 'Acrylic' });
const PICTURE_SETTING = 'background.picture';
/** Theme gradient covers the whole window, so neither the desktop nor a picture shows: their rows wait while it's on. */
const NO_GRADIENT = '!background.themeGradient';
const PERCENT = '%';
const PIXELS = 'px';
/** The picture row's buttons, and where an error picking one shows. */
const CHOOSE = '[data-background-choose]';
const REMOVE = '[data-background-remove]';
const PICTURE_ERROR = '.bg-error';

/** The picture chosen: a small copy of it, or a dashed empty box. */
function pictureControl() {
  const picture = getSetting(PICTURE_SETTING);
  const thumb = picture
    ? `<span class="bg-thumb" style="background-image:url(&quot;${escapeHtml(pictureUrl(picture))}&quot;)"></span>`
    : '<span class="bg-thumb empty"></span>';
  return `<div class="bg-picture">${thumb}<button class="btn" data-background-choose>Choose picture</button>${picture ? '<button class="btn" data-background-remove>Remove</button>' : ''}</div>
    <p class="set-desc bg-error" hidden></p>`;
}

/** Copies a picture the user picks into Termilly's backgrounds and shows it; an error says why it couldn't. */
async function choosePicture() {
  const reply = await request(PAGE.backgroundPick, {});
  if (reply.error) {
    const error = document.querySelector(PICTURE_ERROR);
    if (error instanceof HTMLElement) showError(error, reply.error);
    return;
  }
  if (!reply.picture) return; // cancelled
  setSetting(PICTURE_SETTING, reply.picture);
  redraw();
}

/** The effects this system has, if any beyond plain see-through. */
const effectRow = () => (effects().length > 1
  ? row('Effect', 'What shows through.', seg('background.effect', effects().map(e => [e, EFFECT_LABEL[e] ?? e]), { firstIfNone: true }), { keywords: 'blur acrylic vibrancy glass frosted', needs: NO_GRADIENT })
  : '');

/** @type {import('./page.js').Section} */
const BACKGROUND_TAB = {
  id: SECTION.appearanceBackground,
  label: 'Background', tab: 'Background', parent: SECTION.appearance, icon: ICONS.appearance,
  html: () => group('Window',
    row('Theme gradient', 'Frosted glass over the theme\'s colours.', toggle('background.themeGradient'), { keywords: 'gradient glow glass frosted theme colours colors' })
    + row('Opacity', 'Below 100%, the desktop shows through.', slider('background.opacity', OPACITY, PERCENT, 'Opacity'), { keywords: 'transparent transparency see-through translucent opacity alpha', needs: NO_GRADIENT })
    + effectRow()
    + row('Solid terminals', 'Only the window around them shows through.', toggle('background.solidTerminals'), { keywords: 'terminal solid opaque', needs: NO_GRADIENT }))
    + group('Picture',
      row('Picture', 'Behind the terminals or the whole window.', pictureControl(), { keywords: 'background image picture wallpaper photo', needs: NO_GRADIENT })
      + row('Fit', '', seg('background.fit', [[FIT.fill, 'Fill'], [FIT.contain, 'Fit'], [FIT.center, 'Center'], [FIT.tile, 'Tile']]), { keywords: 'picture fill stretch tile center', needs: NO_GRADIENT })
      + row('Dim', 'Keeps text readable.', slider('background.dim', DIM, PERCENT, 'Dim'), { keywords: 'picture dim darken shade', needs: NO_GRADIENT })
      + row('Blur', '', slider('background.blur', BLUR, PIXELS, 'Blur'), { keywords: 'picture blur soften', needs: NO_GRADIENT })
      + row('Show behind', '', seg('background.behind', [[BEHIND.terminals, 'Terminals'], [BEHIND.window, 'Whole window']]), { keywords: 'picture behind window terminals', needs: NO_GRADIENT })),
  click(e) {
    if (targetOf(e).closest(CHOOSE)) {
      choosePicture();
      return true;
    }
    if (!targetOf(e).closest(REMOVE)) return false;
    setSetting(PICTURE_SETTING, null);
    redraw();
    return true;
  },
};

export default BACKGROUND_TAB;
