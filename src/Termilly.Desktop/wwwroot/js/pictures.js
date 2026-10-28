// @ts-check
// An image file's versions as pictures, in the Git window (gitwindow.js) and the change preview (preview.js): the
// host sends them as data: URLs (ChangePictures.cs), as a binary image has no lines to compare.

import { escapeHtml } from './ui.js';

/** What a picture is drawn from: a file's change, with its images where it's one. */
/** @typedef {{ beforeImage?: string | null, afterImage?: string | null, beforeSize?: number, afterSize?: number }} Pictured */

/** Bytes in a kilobyte and in a megabyte. */
const KB_BYTES = 1024;
const MB_BYTES = 1 << 20;

/** A file size as people read it: KB, or MB from a megabyte. @param {number} bytes */
export const fileSize = bytes => (bytes >= MB_BYTES ? `${(bytes / MB_BYTES).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / KB_BYTES))} KB`);

/**
 * An image's versions side by side (one for a new or deleted file, or one that didn't change), on a checkerboard so
 * transparency shows, each with its size; '' for a file that isn't an image.
 * @param {Pictured} data
 */
export function imagesHtml(data) {
  const both = !!data.beforeImage && !!data.afterImage;
  /**
   * @param {string | null | undefined} src
   * @param {string} label
   * @param {number | undefined} bytes
   */
  const picture = (src, label, bytes) => src ? `<figure class="gw-image">
      <div class="gw-image-box"><img src="${escapeHtml(src)}" alt="${escapeHtml(label)}"></div>
      <figcaption>${both ? `<b>${escapeHtml(label)}</b> · ` : ''}<span data-image-size></span>${fileSize(bytes ?? 0)}</figcaption>
    </figure>` : '';
  const shown = picture(data.beforeImage, 'Before', data.beforeSize) + picture(data.afterImage, 'After', data.afterSize);
  return shown ? `<div class="gw-images">${shown}</div>` : '';
}

/**
 * Adds each picture's width and height to its caption once it has loaded.
 * @param {Element} target
 */
export function measureImages(target) {
  for (const img of target.querySelectorAll('.gw-image img')) {
    const image = /** @type {HTMLImageElement} */ (img);
    const show = () => {
      const size = image.closest('.gw-image')?.querySelector('[data-image-size]');
      if (size && image.naturalWidth) size.textContent = `${image.naturalWidth} × ${image.naturalHeight} px · `;
    };
    if (image.complete) show();
    else image.addEventListener('load', show, { once: true });
  }
}
