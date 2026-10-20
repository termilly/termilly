// @ts-check
// Settings › Change preview: how Claude's edits are shown, where from, and how.

import { state } from '../store.js';
import { ICONS } from '../ui.js';
import { row, seg, toggle, group, choices } from './controls.js';
import { SECTION, redraw } from './page.js';
import { SETTING_VALUES } from '../constants.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { changePlacement, changeFollow, changeSource, changeView, changeCompare, changeNewFile, changeKeep, changeContext, changeLayout, changeMaxFileKb } = SETTING_VALUES;

const KB_PER_MB = 1024;

/** @type {import('./page.js').Section} */
const CHANGES = {
  id: SECTION.changes,
  label: 'Change preview', icon: ICONS.diff,
  html: () => {
    const s = state.settings;
    return group('', row('Change preview',
      'See the whole change when Claude Code edits a file, coloured for the file’s language. Claude’s own output shows only a short preview.',
      toggle('changes.enabled'))
      + (s.agents.integration ? '' : `<p class="set-desc set-note">Agent integration is off (Terminal), so Termilly doesn’t hear about Claude’s edits.
        Ctrl+click on a path still works, comparing the file with the last commit.</p>`))
      + `<div class="${s.changes.enabled ? '' : 'set-off'}">`
      + group('Open it from', row('Ctrl+click a path', 'In any terminal’s output: Claude’s Update(…) and Write(…) lines, and other file paths. Files on SSH or WSL can’t be previewed.', toggle('changes.links'))
        + row('Changed files list', 'A list on the terminal’s header of the files Claude changed there, which you clear yourself. It shows once Claude has run in the terminal.', toggle('changes.button'))
        + row('Shortcut and palette', 'Ctrl+Shift+D shows the last change. When off, Ctrl+Shift+D goes to the shell.', toggle('changes.shortcut')))
      + group('Where it opens', row('Placement', 'A pane next to the terminal, a panel over the right edge, or a window you can move.',
        seg('changes.placement', [[changePlacement.split, 'Pane'], [changePlacement.panel, 'Side panel'], [changePlacement.float, 'Floating']]))
        + row('When Claude changes another file', 'While the preview is open: offer the new file with a button, or switch to it (the terminal keeps the keyboard).',
          seg('changes.follow', [[changeFollow.offer, 'Offer it'], [changeFollow.follow, 'Follow']])))
      + group('Where changes come from', row('Source',
        'File path: Claude’s hook passes only the file’s path, and Termilly copies the file just before and after each edit. Git: the file against the last commit, no copies. Full edit: Claude’s edit text is passed to Termilly as well.',
        seg('changes.source', [[changeSource.path, 'File path'], [changeSource.git, 'Git'], [changeSource.fullEdits, 'Full edit']]), { stack: true })
        + row('Files changed by shell commands',
          'Claude sometimes makes or changes files with a command (Copy-Item, Set-Content, sed). While one runs, Termilly watches Claude’s folder and the folders of files already listed, and lists what appears or changes. Only the folder is passed, never the command.',
          toggle('changes.shellFiles')))
      + group('View', row('Opens on', 'You can switch while it’s open, except with Diff only.',
          seg('changes.view', [[changeView.diff, 'Diff'], [changeView.file, 'Whole file'], [changeView.diffOnly, 'Diff only']]))
        + row('Compare', 'All of Claude’s edits to the file since the first, or the last one only. Also switchable in the preview.',
          seg('changes.compare', [[changeCompare.session, 'All edits'], [changeCompare.lastEdit, 'Last edit']]))
        + row('New files open as', 'The file itself, coloured for its language, or a diff with every line added. Last edit still shows Claude’s later edits to it.',
          seg('changes.newFile', [[changeNewFile.file, 'The file'], [changeNewFile.diff, 'A diff']]))
        + row('Keep the list', 'Until you clear it on the terminal’s header (or the terminal closes), or also empty it when Claude starts a new session there.',
          seg('changes.keep', [[changeKeep.terminal, 'Until I clear it'], [changeKeep.perSession, 'Per session']]))
        + row('Lines around a change', '', seg('changes.context', choices(changeContext.all, String)))
        + row('Layout', 'Side by side shows the old and new text in two columns.', seg('changes.layout', [[changeLayout.inline, 'Inline'], [changeLayout.sideBySide, 'Side by side']]))
        + row('Syntax colours', 'Colours for the file’s language; plain text stays plain.', toggle('changes.highlight'))
        + row('Wrap long lines', '', toggle('changes.wrap'))
        + row('Largest file', 'Bigger files are listed but not copied or shown.', seg('changes.maxFileKb', choices(changeMaxFileKb.all, kb => (kb >= KB_PER_MB ? `${kb / KB_PER_MB} MB` : `${kb} KB`)))))
      + '</div>';
  },
  changed(key) {
    if (key === 'changes.enabled') redraw(); // dims the rest of the section
  },
};

export default CHANGES;
