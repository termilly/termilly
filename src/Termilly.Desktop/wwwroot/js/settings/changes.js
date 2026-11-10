// @ts-check
// Settings › Change preview: how Claude's edits are shown, where from, and how.

import { state } from '../store.js';
import { ICONS } from '../ui.js';
import { row, seg, toggle, group, choices } from './controls.js';
import { SECTION, redraw } from './page.js';
import { SETTING_VALUES } from '../constants.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { changePlacement, changeFollow, changeSource, changeCompare, changeNewFile, changeKeep, changeContext, changeLayout, changeMaxFileKb } = SETTING_VALUES;

const KB_PER_MB = 1024;

/** @type {import('./page.js').Section} */
const CHANGES = {
  id: SECTION.changes,
  label: 'Change preview', icon: ICONS.diff,
  html: () => {
    const s = state.settings;
    return group('', row('Change preview',
      'See Claude’s whole edit, coloured for the file’s language.',
      toggle('changes.enabled'))
      + (s.agents.integration ? '' : `<p class="set-desc set-note">Agent integration is off (Terminal), so Termilly doesn’t hear about Claude’s edits.
        Ctrl+click on a path still works, comparing the file with the last commit.</p>`))
      + `<div class="${s.changes.enabled ? '' : 'set-off'}">`
      + group('Open it from', row('Ctrl+click a path', 'Paths in a terminal’s output open the preview.', toggle('changes.links'))
        + row('Changed files list', 'The files the agent changed, in the terminal’s status bar.', toggle('changes.button'))
        + row('Shortcut and palette', 'Ctrl+Shift+D shows the last change.', toggle('changes.shortcut')))
      + group('Where it opens', row('Placement', 'A pane, a panel over the right edge, or a window.',
        seg('changes.placement', [[changePlacement.split, 'Pane'], [changePlacement.panel, 'Side panel'], [changePlacement.float, 'Floating']]))
        + row('When Claude changes another file', 'Offer the new file, or switch to it.',
          seg('changes.follow', [[changeFollow.offer, 'Offer it'], [changeFollow.follow, 'Follow']])))
      + group('Where changes come from', row('Source',
        'Copies around each edit, Git, or Claude’s own edit text.',
        seg('changes.source', [[changeSource.path, 'File path'], [changeSource.git, 'Git'], [changeSource.fullEdits, 'Full edit']]), { stack: true })
        + row('Files changed by shell commands',
          'Also list files Claude changes with a command.',
          toggle('changes.shellFiles')))
      + group('View', row('Compare', 'All of Claude’s edits since the first, or the last one (the Git window’s Agent changes).',
          seg('changes.compare', [[changeCompare.session, 'All edits'], [changeCompare.lastEdit, 'Last edit']]))
        + row('New files open as', 'The file itself, or a diff with every line added.',
          seg('changes.newFile', [[changeNewFile.file, 'The file'], [changeNewFile.diff, 'A diff']]))
        + row('Keep the list', 'Until you clear it, or also when Claude starts a new session.',
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
