# Milestone 1 — Local Terminal

## Implemented

- xterm.js renderer with fit/resize, clipboard-compatible selection, scrollback,
  UTF-8 rendering, and normal control-character input.
- node-pty transport using Windows ConPTY.
- Automatic discovery for PowerShell 7, Windows PowerShell, Command Prompt,
  installed WSL distributions, and Git Bash.
- Multi-tab terminal creation, activation, resize, and close lifecycle.
- Context-isolated, ownership-checked IPC; renderer code cannot select an
  arbitrary executable or write to another window's terminal.

## Tests run

- Shell discovery unit tests.
- TypeScript strict typecheck.
- Production renderer and Electron builds.
- Windows Electron smoke: create PowerShell ConPTY, observe output, send a
  marker command through the renderer IPC bridge, observe that marker in the
  same xterm surface, resize, and close cleanly.

## Manual verification

The automated smoke passed on Windows with a real ConPTY. PowerShell, CMD, WSL,
and Git Bash are exposed when present; each remains selectable from the sidebar
and New Terminal menu.

## Known issues / next milestone

- Pop-out windows and configurable default shell are deferred to management UI.
- Terminal search UI is present but not wired yet.
- Milestone 2 adds Host management and a real SSH shell transport while keeping
  this same xterm component and input/output ownership model.
