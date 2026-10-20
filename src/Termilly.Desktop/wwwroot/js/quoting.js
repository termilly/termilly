// @ts-check
// Windows paths written the way each shell reads them, for files dropped on a terminal.

import { PROFILE_ICON } from './constants.js';

/**
 * Quotes paths for a shell (a profile's badge: powershell, cmd, bash for Git Bash, wsl), joined by spaces.
 * Git Bash gets /c/dir, WSL /mnt/c/dir; anything else (ssh, custom commands) gets "C:\dir".
 * @param {string[]} paths
 * @param {string} [shell]
 */
export function quotePaths(paths, shell) {
  return paths.map(path => quotePath(path, shell)).join(' ');
}

/**
 * @param {string} path
 * @param {string} [shell]
 */
export function quotePath(path, shell) {
  switch (shell) {
    case PROFILE_ICON.powerShell:
      return `'${path.replace(/'/g, "''")}'`;
    case PROFILE_ICON.bash:
      return single(toPosix(path, ''));
    case PROFILE_ICON.wsl:
      return single(toPosix(path, '/mnt'));
    default:
      return `"${path}"`;
  }
}

/**
 * C:\dir\file → <prefix>/c/dir/file; other paths (\\server\share) only get forward slashes.
 * @param {string} path
 * @param {string} prefix
 */
function toPosix(path, prefix) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return m ? `${prefix}/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : path.replace(/\\/g, '/');
}

/** @param {string} text */
const single = text => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * A command line from separate words (termilly open -- claude "a prompt"), each quoted for the shell that will read
 * it, so a word with spaces, brackets or quotes stays one argument. Plain words (claude, npm, a path) stay as they are.
 * @param {unknown[]} words
 * @param {string} [shell]
 */
export function commandLine(words, shell) {
  return words.map(word => quoteArg(String(word), shell)).join(' ');
}

/**
 * @param {string} word
 * @param {string} [shell]
 */
export function quoteArg(word, shell) {
  if (/^[\w@%+=:,./\\-]+$/.test(word)) return word;
  switch (shell) {
    case PROFILE_ICON.powerShell:
      return `'${word.replace(/'/g, "''")}'`;
    case PROFILE_ICON.bash:
    case PROFILE_ICON.wsl:
    case PROFILE_ICON.ssh:
      return single(word);
    default:
      // cmd and the rest: double quotes, with a quote inside (and the backslashes before it) escaped the way
      // Windows programs read their command line.
      return `"${word.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  }
}
