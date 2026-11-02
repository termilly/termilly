// @ts-check
// Paths and places as the Files panel (filepanel.js) and its "Copy to" window (copyto.js) see them: a folder here
// (Windows' backslashes, the drives above a drive's root) or on an SSH terminal's server (slashes).

import { profileOf, isSsh, isRemote, wsById } from './store.js';
import { FOLDER_PATH, PROFILE_SOURCE } from './constants.js';
import { platform, PLATFORM } from './host.js';
import { wslLinuxPath } from './quoting.js';

/** Bytes in a kilobyte and in a megabyte, for sizes. */
const KB = 1024;
const MB = KB * KB;

/** A path's separator: a backslash in a Windows folder, else a slash. */
export const sepOf = /** @param {string} path */ path => (/^[A-Za-z]:\\|^\\\\/.test(path) ? '\\' : '/');
/**
 * @param {string} dir
 * @param {string} name
 */
export const joinPath = (dir, name) => (dir.endsWith(sepOf(dir)) ? dir + name : `${dir}${sepOf(dir)}${name}`);
/** A Windows drive's root ("C:\") or a network share's ("\\server\share"): above it are the drives. */
const DRIVE_ROOT = /^[A-Za-z]:\\?$|^\\\\[^\\]+\\[^\\]+\\?$/;
/** The folder a path is in: above a drive or share, the drives; the server's root (and the drives) stay themselves. */
export const parentOf = /** @param {string} path */ path => {
  if (path === FOLDER_PATH.drives || DRIVE_ROOT.test(path)) return FOLDER_PATH.drives;
  const sep = sepOf(path);
  const up = path.replace(sep === '\\' ? /\\[^\\]+\\?$/ : /\/[^/]+\/?$/, '');
  return sep === '\\' ? (/^[A-Za-z]:$/.test(up) ? `${up}\\` : up || path) : up || '/';
};
/**
 * Whether `path` is `folder` or inside it (case aside, as on Windows).
 * @param {string} path
 * @param {string} folder
 */
export const isInside = (path, folder) => {
  const [p, f] = [path.toLowerCase(), folder.toLowerCase().replace(/[\\/]$/, '')];
  return p === f || p.startsWith(f + sepOf(folder));
};
/** A drive, drawn on whole pixels at 16px with 1px lines (half-pixel coordinates), so it stays crisp. */
export const DRIVE_ICON = '<svg class="files-drive" viewBox="0 0 16 16"><rect x="1.5" y="4.5" width="13" height="7" rx="1"/><path d="M3.5 9.5h1M11.5 9.5h1"/></svg>';
/** What the drives are called where a path would be. */
export const DRIVES_NAME = 'This PC';
/** A folder's name in a path bar: the drives have one of their own. */
export const folderName = /** @param {string} path */ path => (path === FOLDER_PATH.drives ? DRIVES_NAME : path);

export const sizeText = /** @param {number} n */ n => (n < KB ? `${n} B` : n < MB ? `${(n / KB).toFixed(1)} KB` : `${(n / MB).toFixed(1)} MB`);

/**
 * Which WSL distribution a terminal's shell runs in, on Windows: as the shell said (its integration reports
 * $WSL_DISTRO_NAME, also for `wsl` typed in another shell or a profile of the user's), else its WSL profile's,
 * which Termilly names after the distribution as Windows registers it (SessionProfiles.cs); null for any other
 * terminal.
 * @param {Tab} tab
 */
export function wslDistroOf(tab) {
  if (platform !== PLATFORM.windows) return null;
  if (tab.wslDistro) return tab.wslDistro;
  const profile = profileOf(tab);
  return profile?.source === PROFILE_SOURCE.wsl ? profile.name : null;
}

/** A terminal whose shell runs in WSL (its distribution known). @param {Tab} tab */
export const isWsl = tab => !!wslDistroOf(tab);

/** Where Windows reaches a WSL terminal's distribution: \\wsl.localhost\<distribution>. @param {Tab} tab */
export const wslRootOf = tab => '\\\\wsl.localhost\\' + wslDistroOf(tab);

/**
 * A Linux path of a WSL terminal (/home/me/x) as Windows reaches it (\\wsl.localhost\Ubuntu\home\me\x); its
 * distribution's root for anything else.
 * @param {Tab} tab
 * @param {string | null | undefined} linuxPath
 */
export const wslPath = (tab, linuxPath) =>
  wslRootOf(tab) + (linuxPath?.startsWith('/') ? linuxPath.replace(/\/+$/, '').replace(/\//g, '\\') : '');

/**
 * A path as the terminal's shell types it: Linux's for a WSL terminal's files, else as it is.
 * @param {Tab} tab
 * @param {string} path
 */
export const shellPathOf = (tab, path) => (isWsl(tab) ? wslLinuxPath(path) ?? path : path);

/**
 * Whether a terminal's files can be shown: its server's over SFTP, its WSL distribution's, or this machine's (not a
 * container or serial).
 */
export const hasFiles = /** @param {Tab} tab */ tab => !!tab.pcFiles || isSsh(tab) || isWsl(tab) || !isRemote(tab);

/**
 * The folder a terminal's shell is in (on its server, for SSH; in its distribution, as Windows reaches it, for WSL),
 * or its workspace's, or home.
 */
export const shellFolderOf = /** @param {Tab} tab */ tab =>
  (tab.pcFiles ? tab.pcFiles.cwd : isSsh(tab) ? tab.remoteCwd ?? '~' : isWsl(tab) ? wslPath(tab, tab.remoteCwd)
    : tab.cwd ?? wsById(tab.wsId)?.cwd ?? '~');

/** Where a terminal's files are: its SSH host's name, or this computer. */
export const placeOf = /** @param {Tab} tab */ tab => (tab.pcFiles ? tab.pcFiles.place : isSsh(tab) ? profileOf(tab)?.name ?? '' : DRIVES_NAME);

/**
 * A folder of a terminal, said where it matters which machine it's on: "host: /path" on a server, the path here.
 * @param {Tab} tab
 * @param {string} dir
 */
export const folderOf = (tab, dir) => (tab.pcFiles || isSsh(tab) ? `${placeOf(tab)}: ${dir}` : dir);

/**
 * Whether two terminals' files are on the same machine: both here, or both on one SSH host.
 * @param {Tab} a
 * @param {Tab} b
 */
export const sameMachine = (a, b) => (a.pcFiles || b.pcFiles ? a.pcFiles?.machine === b.pcFiles?.machine
  : isSsh(a) === isSsh(b) && (!isSsh(a) || a.profile === b.profile));

/**
 * "name.txt", or "name (1).txt" when that's taken among `taken` (a folder's whole name is its stem), as the host's
 * LocalFiles.FreeName names a copy.
 * @param {string} name
 * @param {boolean} folder
 * @param {Set<string>} taken the names there, as `key` gives them (lower case where case doesn't count)
 * @param {(name: string) => string} key
 */
export function freeName(name, folder, taken, key) {
  const dot = folder ? -1 : name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let free = name;
  for (let i = 1; taken.has(key(free)); i++) free = `${stem} (${i})${ext}`;
  return free;
}
