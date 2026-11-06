# Changelog

What changed in each release. Termilly says in its title bar when a newer one is out.

## 1.6.2 (2026-11-06)

- **Detachable windows:** move terminals, the Notepad and Snippets into their own windows.
- **Prompts and replies:** Prompt history now shows Claude Code's replies and tool calls.
- **Notepad:** toolbar, status bar, line numbers, text size, and docking on any edge.
- **More shells:** shell integration for zsh, fish, nushell, tcsh and ksh, and shells from package managers.
- **Clipboard:** a Termilly only switch keeps just what you copy in Termilly.
- **Remote control:** create and close workspaces and terminals from a phone or another computer, when Allow creating and Allow closing are on there.
- **Zoom:** Ctrl+Shift+= and - resize the whole app.
- **Dragging:** drop a terminal on another's title bar to add it as a tab.

Fixes:

- **Linux:** no white flash at start, rounded windows, and the first start follows your light or dark mode. On Wayland, Termilly now runs as an X11 app so windows open where they're dropped; turn this off in Settings > Appearance > Windowing system.
- **Remote:** works on any network, including cloud machines with only a public address. Only paired devices get in, over HTTPS.
- **Windows:** a background program that can't start no longer leaves a message box.
- Various smaller improvements and bug fixes.

## 1.6.1 (2026-11-02)

- **Remote computers:** remote terminals now show the right badge and Prompt history, and notify you when the connection is lost.
- **WSL:** fixed the Files panel in WSL terminals; it now follows the shell's folder.
- **Typing:** fixed occasional short freezes in terminals with a long history.

## 1.6.0 (2026-11-01)

- **Remote:** Access your workspaces, terminals, and agent sessions from your phone or another PC.
- **Search:** Improved search with detected paths, files, and URLs grouped into separate lists.
- **History:** Choose how long to keep your terminal history.
- **Clipboard:** Keep track of everything you copy, including text, images, and links.
- **Prompt history:** Browse prompts sent to agents in your terminals, organized by date and time.
- **Keyboard:** Customize any Termilly keyboard shortcut.
- **Terminal improvements:** Faster scrolling, scrollable long menus, and automatic detection of files, paths, and URLs.
- Various improvements and bug fixes.

## 1.5.0 (2026-10-30)

- **Notepad:** write down quick notes, save them to files or copy them to workspace and terminal notes.
- **Links:** highlighted under the mouse; Ctrl+click opens .html files in your browser, and Ctrl+C copies the link.
- Bugfix for auto update feature

## 1.4.0 (2026-10-29)

- **File Explorer:** explore, search, preview files and copy them between workspaces.
- **Sounds:** configure sounds when there is a pending action or error.
- Updates install more reliably.

## 1.3.0 (2026-10-26)

- **Actions:** open your browser, your editor or a web search from a shortcut or the context menu.
- **Snippets:** type `Snippet:` and execute one directly from terminal line.
- **Help:** each page in Settings window can take you straight to Docs page.
- **Links:** URLs, folders and files can now be opened directly from the terminal (Ctrl+click).

## 1.2.0 (2026-10-22)

- **Ask before quitting** while a command or an agent is still running.
- **Minimize and Close to the tray** (Windows).

## 1.1.0 (2026-10-21)

- **Updates** are handled by Termilly instead of manually running setup.
- **Snippets at the prompt:** type `snippet:` to pick one.
- **Images in the Git window,** before and after.
- **Notifications** while Termilly is minimized or behind other windows.
- Minor bugfixes.

## 1.0.0 (2026-10-20)

Initial version.
