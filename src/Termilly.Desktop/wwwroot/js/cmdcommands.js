// @ts-check
// cmd's commands, for the command history and autocomplete. cmd's prompt marks where it starts and where typing
// starts (SessionLaunch.CmdPrompt), but cmd can't run anything before a command or say how one ended, so Enter at
// its prompt starts the command here, read from what's typed; its next prompt ends it, without an exit code.
// After autocomplete.js and snippetprompt.js: an Enter their lists take never gets here.

import { addInputHook } from './terminals.js';
import { atCmdPrompt, commandStarted } from './commands.js';

const ENTER = 'Enter';

addInputHook((tab, term, e) => {
  if (e.type === 'keydown' && e.key === ENTER && !e.isComposing && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && atCmdPrompt(tab)) {
    commandStarted(tab);
  }
  return true;
});
