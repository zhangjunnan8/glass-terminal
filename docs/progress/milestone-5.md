# Milestone 5 — Provider infrastructure

## Implemented

- Typed `ProviderProfile` abstraction for Generic OpenAI-compatible APIs with
  name, Base URL, Model ID, default selection, readiness, and connection-test
  state.
- Provider metadata supports create, edit, list, delete, set-default, and Test
  Connection. A profile becomes Ready only after its authenticated `/models`
  request succeeds and, when a non-empty model list is returned, contains the
  configured Model ID.
- Provider JSON contains only a Windows Credential Manager reference and a
  configured flag. API keys never enter the metadata file.
- Production secret storage uses the Windows Generic Credential Win32 API
  through a non-interactive, hidden PowerShell process. Secret payloads travel
  over stdin, never command-line arguments, environment variables, or files.
- Provider imports are rebuilt from an explicit field allowlist, so an unknown
  `apiKey` field cannot be reflected through IPC or written back later.
- Replacing the API key, Base URL, or Model ID resets readiness to `not-tested`.
- Remote Provider URLs require HTTPS; loopback HTTP is permitted for isolated
  local integration tests. URL credentials, query strings, fragments, and
  redirects are rejected.
- The renderer provides Provider create/edit/delete/default/test UI and always
  displays the current Provider and status in the Agent panel.

## Tests run

- ProviderStore unit tests use an in-memory secret adapter and mocked HTTP:
  non-secret metadata persistence, authenticated test request, Ready gating,
  safe HTTP errors, default selection, removal, credential deletion, and
  unknown-field stripping.
- Strict typecheck, full unit suite, production build, and existing terminal,
  SSH, Session, and SFTP regressions.

## Manual verification

No Windows Credential was created, read, changed, or removed during
development or automated tests. The real adapter is implemented but remains
uninvoked until a user explicitly saves a Provider in the running application.

## Known issues / next milestone

- This milestone supports Generic OpenAI-compatible APIs. Official Codex App
  Server/Auth integration remains its own later milestone and will not parse
  or automate the Codex TUI.
- Provider and Model are one profile in this alpha; reusable multi-model
  Provider accounts can be normalized later without changing the runtime
  abstraction.
- Connection testing uses `/models`; Providers with a nonstandard discovery
  endpoint require a future adapter.
- The next milestone adds the complete multi-turn Agent loop, structured tool
  calls, same-visible-terminal execution, and per-command approval.
