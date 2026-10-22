# Termilly on Linux (work in progress)

The same web UI as on Windows, in a Photino window (WebKitGTK), with terminals in Linux pseudo terminals
(`src/Termilly.Pty/Unix`). It shares the Windows app's platform-neutral code (compiled in from
`src/Termilly.Desktop`). What the page asks for is answered by `PageHost.cs`, shared with Windows; `LinuxHost.cs`
adds what Linux does its own way (pseudo terminals, GTK dialogs, xdg-open, notify-send).

## Install it

`installer/linux/build-deb.sh` builds a .deb (see `installer/linux/README.md`).

## Run it from source (Ubuntu 24.04)

Needs the .NET 10 SDK and WebKitGTK 4.1 (`sudo apt install dotnet-sdk-10.0 libwebkit2gtk-4.1-0`).

```sh
cd ~/Development/termilly
dotnet run --project src/Termilly.Linux
```

The app builds as `termilly` (`bin/Debug/net10.0/termilly`), with the agent helper in `agent/` next to it.

Data lives in `~/.local/share/Termilly`, or in `TERMILLY_DATA_DIR` if set. Its key file `local.key` (mode 600)
does what DPAPI does on Windows. `TERMILLY_DEVTOOLS=1` turns on WebKit's inspector (right-click › Inspect).

## What works

- Shells: your login shell first, then the others in `/etc/shells`, plus ssh hosts from `~/.ssh/config`.
- Terminals: typing, resize, splits, closing, exit codes.
- Workspaces, tags and settings, all kept encrypted as on Windows.
- Session restore and closed-terminal history.
- Command palette and command history.
- The `termilly` command and its MCP server (`termilly mcp`), in Termilly's terminals and outside them.
- Claude Code's hooks: terminals find the `claude` shim first on PATH, so agent state, Claude usage, plan limits
  and context show as on Windows.
- Activity: a spinner while a terminal runs a command (its shell's child processes, from /proc), none while it
  waits on you in an interactive program (vim, less, ssh, htop, tmux, Claude Code…) or a shell started from
  the terminal's own (pwsh typed at bash's prompt).
- Shell integration for bash and PowerShell (prompt marks: when a command starts and ends, and its exit code). It
  also keeps Termilly's agent folder first on PATH after a login profile moves `~/.local/bin` in front.
- Notifications (`notify-send`), links and folders opened with `xdg-open`, files shown in the file manager,
  files dropped on a terminal, each terminal's folder (bash and PowerShell report it).
- Everything else the page does, from the same code as on Windows: SFTP panel (uploads by drop or the Upload
  button's GTK dialog), port forwards, SSH import, layouts (export, import, .termilly.yml), the change preview,
  history sync, agent worktrees, phone check-in, plugins, recovery code flows.
- Saved SSH passwords in the system keyring (GNOME Keyring, KWallet: libsecret);
  ssh reads a saved password through Termilly's askpass helper.
- Background shells (Settings › Workspaces › Keep shells running): the host process (host/termilly-host, in a
  session of its own) runs the terminals, so closing or crashing the window doesn't end them, and the next window
  takes them back with the output it missed. "Start it when you sign in" adds an XDG autostart entry.
- The ports a terminal's programs listen on, on its sidebar row, from /proc (LinuxPorts.cs).
- The same window as on Windows: no system title bar, the page's own with minimise / maximise / close, moved and
  resized from the page (GTK, Wayland and X11), and the "Loading..." start-up loader.
- One Termilly per data folder: starting it again (`termilly`, `termilly <folder>`) hands over to the running one, even while it loads; a folder opens a terminal there, or brings forward one already in it.

## Not yet

- Clicking a notification to open its terminal, and the dock badge.
- Quake mode and global hotkeys.
- Shell integration for zsh and fish (bash and PowerShell have it).
- An AppImage (for distributions without a .deb).
