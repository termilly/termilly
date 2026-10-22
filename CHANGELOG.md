# Changelog

What changed in each release. Termilly says in its title bar when a newer one is out.

## Unreleased

- **Ask before quitting:** when a command is still running, or an agent is working or waiting for you, quitting names them and asks first, and quits by itself after a 30-second countdown if you don't answer. Not asked while Keep shells running is on, since they go on without the window. Turn it off in Settings › Workspaces.
- **Minimize and Close to the tray (Windows):** in Settings › Workspaces, Minimize can hide Termilly in the tray instead of the taskbar, and Close can keep it running there, so agents can still notify you. Click the tray icon to bring it back; its menu and the palette's Quit Termilly quit.
- **The version in the title bar,** next to the name.
- **The tour only on the very first start:** setup no longer has a "Show me around" box, which upgrades showed checked although the tour never came back.

## 1.1.0 (2026-10-21)

- **Updates from inside Termilly:** Download and install, then Restart to update. The installer is checked against the signed release before it runs, and nothing happens until you choose it. Updating from 1.0.0 still goes through the browser once.
- **Copy and paste in terminals:** Ctrl+C copies a selection (without one it stops the command), Ctrl+Shift+C and Ctrl+Insert copy, Ctrl+V, Ctrl+Shift+V and Shift+Insert paste, a right-click menu, and Copy on select in Settings › Terminal.
- **Snippets at the prompt:** type `snippet:` to pick a snippet from a list at the cursor, with each one's command and the values it asks for.
- **One window for changes:** the changed-files window is now the Git window's Agent changes, and search finds text in the files Claude changed. A Wrap button in the change preview and the Git window's diffs.
- **Images in the Git window:** a changed PNG, JPEG, GIF, WebP, BMP, ICO, AVIF or SVG shows as a picture, before and after side by side, with its size.
- **After a restart** terminals come back scrolled where they were, and a Claude Code session resumes in its own folder, also over SSH.
- **Notifications** now appear when an agent finishes, needs you or fails while Termilly is minimized, behind another window or on another workspace. They didn't appear at all before.
- **Subagents** leave the sidebar a few seconds after they finish.
- **Agents over SSH:** no spinner while Claude waits for you, and hooks get through inside tmux. Hosts set up with 1.0.0 are offered an update of Termilly's scripts.

## 1.0.0 (2026-10-20)

The first public release, for Windows 10 and 11 and for Debian and Ubuntu.

- **Workspaces** of terminals, in tabs, splits and docked panes, restored after a restart with their scrollback. "Keep shells running" keeps them alive while the window is closed or updated.
- **Shells:** PowerShell, cmd, Git Bash, WSL, SSH (with `~/.ssh/config`, forwards and SFTP), serial ports and network consoles.
- **Coding agents:** Claude Code's state in the sidebar and title bar, notifications when one needs you, its plan limits and context, and a preview of every file it changes.
- **The Git window:** changes, history and branches, staging and restoring, and one search across changed files, commits and the code they added.
- **Search** across terminals, command history and output, and a command palette.
- **Snippets** with optional variables, tags, and a red frame around production terminals.
- **Scripting:** the `termilly` command and MCP server, and plugins (themes and palette commands) in a sandbox.
- **Privacy:** workspaces, history and secrets encrypted on disk, secrets redacted from history, history sync through a folder you already sync, and phone check-in on your local network.
- **Installers:** a Windows setup (full or online) and a .deb, and a signed update check.
