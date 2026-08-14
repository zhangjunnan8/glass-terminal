# Milestone 2 — SSH

## Implemented

- Host and terminal session are separate concepts; selecting a Host shows its
  detail/actions and never auto-connects.
- Non-secret Host CRUD with name, hostname, custom port, username, group,
  favorite flag, auth method, and private-key path.
- Password, keyboard-interactive, private-key + passphrase, and Windows
  OpenSSH/Pageant agent authentication paths.
- Real interactive SSH PTY backed by ssh2 with keepalive, UTF-8, resize,
  Ctrl+C/Ctrl+D-compatible byte input, and reconnect action.
- Trust-on-first-use host-key confirmation using a conventional
  `SHA256:<base64>` fingerprint; subsequent connections enforce the pinned key
  and reject mismatches.
- Initial-output buffering so the remote banner/prompt cannot race ahead of the
  xterm attachment.
- Passwords and passphrases are connection-only values and never enter Host
  JSON. The smoke-data secret scan passed.

## Tests run

- HostStore unit tests, including non-secret persistence and fingerprint pinning.
- Existing shell discovery and product tests.
- Real SSH integration against the designated Ubuntu VM:
  unknown-key rejection, explicit trust, password login, PTY allocation,
  resize, marker command, same-stream output, and clean exit.
- Windows Electron SSH smoke against the same VM: the renderer created an SSH
  tab, attached xterm to that SSH PTY, sent a marker through the preload bridge,
  and observed it in that exact visible xterm surface.
- Local ConPTY Electron smoke regression.
- Strict typecheck and production build.

## Manual verification

The designated target `192.168.31.93` accepted the test login and executed only
the non-mutating marker command plus `exit`. No remote project files were
created or changed.

## Known issues / next milestone

- ProxyJump and SSH config import remain for the later management milestone.
- Host search UI is present but filtering is not wired yet.
- Persistent credentials wait for the Windows Credential Manager adapter; the
  current safe default is session-memory-only.
- Milestone 3 adds temporary-to-formal Session upgrade and durable history.
