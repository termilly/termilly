// @ts-check
// Files and folders dropped on the Import dialog (themeimport.js): each file with where it is, walking folders a few
// levels down, within the limits.

import { CUSTOM_THEME } from './constants.js';

/** A file found and where it is: its path in the folder dropped, or its name. */
/** @typedef {{ file: File, place: string }} DroppedFile */

/**
 * The files dropped: each file, and the files in each folder (and its folders' a few levels down, where the system
 * lets the page read them), within the limits; how many couldn't be read, and whether there were more than the limit.
 * @param {DataTransfer} transfer
 * @returns {Promise<{ files: DroppedFile[], left: number, capped: boolean }>}
 */
export async function droppedFiles(transfer) {
  /** @type {DroppedFile[]} */
  const files = [];
  let left = 0;
  let capped = false;
  /** Whether there's room for one more file; when there isn't, the walk stops. */
  const room = () => !(capped ||= files.length >= CUSTOM_THEME.maxFiles);
  /** @param {FileSystemEntry} entry @param {number} depth */
  const walk = async (entry, depth) => {
    try {
      if (entry.isFile) {
        if (!room()) return;
        const file = await new Promise((resolve, reject) => /** @type {FileSystemFileEntry} */ (entry).file(resolve, reject));
        return void files.push({ file, place: entry.fullPath.replace(/^\//, '') });
      }
      if (depth > CUSTOM_THEME.folderDepth) return;
      const reader = /** @type {FileSystemDirectoryEntry} */ (entry).createReader();
      for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
        for (const child of batch) {
          if (capped) return;
          await walk(child, depth + 1);
        }
      }
    } catch {
      left++; // a file or folder the system won't give: counted, the rest still read
    }
  };
  // Taken while the drop is still going on (a drop's items can't be read once it's over): a file as it is, a folder
  // as an entry to walk (where the system gives one).
  const dropped = [...transfer.items].map(item => {
    try {
      const entry = item.webkitGetAsEntry?.();
      return entry?.isDirectory ? { folder: entry } : { file: item.getAsFile() };
    } catch {
      return { unreadable: true };
    }
  });
  for (const { file, folder, unreadable } of dropped) {
    if (unreadable) left++;
    else if (folder && !capped) await walk(folder, 0);
    else if (file && room()) files.push({ file, place: file.name });
  }
  return { files, left, capped };
}

/** @param {FileSystemDirectoryReader} reader @returns {Promise<FileSystemEntry[]>} */
const readBatch = reader => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
