# Command history sync — design

Termilly can share the history of commands you ran (Settings › Privacy & security › Sync) between your
computers through a folder you already sync: OneDrive, Dropbox, a network share. Termilly runs no server.
The folder only ever holds encrypted files, and the sync code that decrypts them never goes into the folder.

## Keys

- **The local key stays local.** Each PC has its own vault key (DPAPI plus a recovery code, see `Vault.cs`).
  That key encrypts workspaces and history on that PC and is never shared.
- **Sync has its own key.** It's a random 256-bit key, made when sync is first turned on. It's shown as a
  **sync code** (base32 in groups, e.g. `ABCD-EFGH-…`, 52 characters), which you copy to the other PC. This
  is the only way the key moves between machines. On each PC, the key is stored sealed with that PC's vault
  key in `sync.json` next to the vault, so it is exactly as safe as the local history.
- **Checking a code.** The folder holds `key.check`: a fixed text sealed with the sync key. When a second PC
  joins, it opens that file with the code it was given. Only the right code works, and a typo gets a clear
  "that code doesn't fit this folder".

## Folder layout (`<chosen folder>\Termilly sync\`)

| File | Contents |
|---|---|
| `key.check` | `Sealed(syncKey, "termilly-sync-1")` |
| `<device id>.tsh` | `Sealed(syncKey, {device, name, updated, entries[]})`: the commands that PC ran |

- The file names are random device ids (not PC names), and each file is AES-256-GCM (`Sealed`), so the
  folder has no readable text: no commands, no folder paths, no PC names.
- **Each PC writes only its own file.** There's never a write conflict for the sync service to resolve.
  Merging happens on read: every PC reads the others' files and adds entries it hasn't seen, by entry id.
- Entries keep the history's fields (command, exit code, duration, folder, time), plus an `id` and the
  `host` (name of the PC that ran it). Redaction happens before anything is stored, so a redacted command
  is also redacted in the sync folder.
- A PC's own file holds its newest 5,000 commands (the history cap). Imported entries also expire by the
  local retention setting.

## When it syncs

- At start, every 2 minutes, and a few seconds after a command finishes: the PC writes its own file (if it
  has new commands) and reads the others' files (if they changed since the last read).

## Rotating and revoking

- **New sync code (rotate, and revoke):** first merges what the others last wrote. Then it makes a new key,
  rewrites `key.check` and this PC's own file with it, and deletes the other PCs' files, which are sealed
  with the old key. The other PCs show "the sync code was replaced" and stop syncing until you enter the new
  code on them. Each PC rewrites its own file when it rejoins, so nothing is lost. To remove a PC (a lost
  laptop, a leaked code), make a new code and don't give it to that PC: it can't read anything written
  afterwards. Commands it had already downloaded stay on it; encryption can't take back what was already
  shared.
- Settings lists the PCs in the folder by name (read from their encrypted files), with their command
  counts and when they last wrote.
- **Turn off on this PC:** stops syncing and forgets the key. The imported commands stay in local history,
  and this PC's file stays in the folder for the others. Remove it from another PC if you want it gone.

## Not covered (by design)

- No server, no account, no conflict resolution beyond "union by id".
- Only the command history (#9) syncs. Closed-terminal output, workspaces and settings stay local.
