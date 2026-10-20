# Termilly for Debian and Ubuntu

`build-deb.sh` builds `dist/termilly_<version>_amd64.deb` (about 1 MB):

```sh
installer/linux/build-deb.sh
sudo apt install ./dist/termilly_1.0.0_amd64.deb
```

Needs the .NET 10 SDK and `dpkg-deb`. The version comes from `Directory.Build.props`. The Release workflow builds
it together with the Windows setup (see "Release builds" in `installer/README.md`).

## What it installs

- `/opt/termilly`: Termilly, framework-dependent. .NET comes from the distribution's `dotnet-runtime-10.0`
  (Ubuntu 24.04 and later; elsewhere Microsoft's package repository has it), so the package stays small.
  `agent/` holds the termilly command and the claude shim, `host/` the background host.
- `/usr/bin/termilly` (`termilly-launcher.sh`): `termilly` starts Termilly, `termilly <folder>` or `termilly .`
  opens it there (handing over to one already running), and `termilly list`, `state`, `open`… are the scripting
  commands. `agent/` itself stays off PATH, as on Windows.
- `/usr/share/applications/termilly.desktop` and the icons in `/usr/share/icons/hicolor`: the app grid, the dock
  and Alt+Tab show Termilly with its icon, and folders get "Open With › Termilly" in the file manager.
- Depends on WebKitGTK 4.1, GTK 3, libnotify and libsecret; recommends OpenSSH, notify-send, xdg-utils, lspci
  and a keyring.

Removing the package (`sudo apt remove termilly`) leaves `~/.local/share/Termilly` (settings, workspaces, history).

## A build from source instead

`src/Termilly.Linux/bin/.../install-desktop.sh` puts that build in the app grid for the current user. Its entry
(`~/.local/share/applications/termilly.desktop`) takes precedence over the package's; `install-desktop.sh --remove`
takes it out again.
