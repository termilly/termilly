# Security

## Reporting a problem

Please report security problems privately, through GitHub: on the [Security tab](https://github.com/termilly/termilly/security) choose **Report a vulnerability**. Don't open a public issue for them. If you can't use GitHub, email hello@termilly.com.

Say what you found, how to reproduce it, and which version and system you saw it on. You'll get an answer within a week. Once it's fixed and released, the advisory is published with credit to you, unless you'd rather not be named.

## Supported versions

Only the newest release gets security fixes. Termilly says in its title bar when a newer one is out (Settings › About › Check for updates).

## What Termilly keeps, and where

- Workspaces, scrollback, command history and saved secrets are encrypted on disk. On Windows the key is protected with DPAPI; on Linux it's a file only your user can read. A recovery code can open them on another PC.
- Phone check-in is off by default and never leaves your local network. Its design and limits are in [docs/checkin.md](docs/checkin.md).
- History sync goes through a folder you already sync, and only encrypted files go into it: see [docs/history-sync.md](docs/history-sync.md).
- Plugins run in a sandboxed frame with no network access and no access to your files: see [docs/plugins.md](docs/plugins.md).
- Update checks read a version file from termilly.com, signed with an Ed25519 key that the app checks before saying an update is out. Termilly never downloads or installs updates by itself.
