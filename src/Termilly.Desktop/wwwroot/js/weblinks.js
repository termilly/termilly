// @ts-check
// Web addresses in a terminal's output (http:// and https://, webaddress.js finds them) as links: underlined under
// the mouse and opened in the default browser, with Ctrl+click or a plain click as Settings › Terminal says. Links a
// program marks itself (OSC 8) are terminals.js's.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, on, EVENTS } from './store.js';
import { SETTING_VALUES } from './constants.js';
import { registerLinks, COPY_HINT } from './termlinks.js';
import { findWebLinks } from './webaddress.js';

const plainClick = () => state.settings.terminal.linkClick === SETTING_VALUES.linkClick.click;

on(EVENTS.terminalOpened, tab => registerLinks(tab.view.term, tab.view.body, {
  find: findWebLinks,
  active: () => true,
  plainClick,
  title: address => `${address}\n${plainClick() ? 'Click' : 'Ctrl+click'} to open in your browser\n${COPY_HINT}`,
  open: address => send(PAGE.openUrl, { url: address }),
}));
