# Milestone 0 — Architecture

## Implemented

- Independent Git repository.
- Concise technology and license decision.
- Electron main process with a hardened BrowserWindow.
- Narrow context-isolated preload bridge.
- React/TypeScript renderer shell.
- Dark, terminal-first three-column application layout.
- Unit-test and build scaffolding.

## Tests run

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run smoke`

## Manual verification

The first Windows window is launched after the automated gates pass.

## Known issues / next milestone

The terminal surface is a placeholder until Milestone 1 adds xterm.js and the
local ConPTY adapter.
