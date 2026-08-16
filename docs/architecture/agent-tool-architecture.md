# Agent tool architecture

## Invariants

The human and the Generic API Agent share one formal Session and the exact same
visible PTY or SSH shell. Shell and process work always enters that terminal;
Workspace file work uses a separate local-filesystem or SFTP data path and does
not print synthetic commands into the terminal.

There is no fallback shell, hidden filesystem client, or hidden SSH connection.
A Harness receives only the turn-scoped `ToolGateway` supplied by
`AgentService`. It must not construct `TerminalService`, Node filesystem, SSH,
SFTP, or a platform default shell itself.

```text
AgentService -> replaceable AgentBackend / Harness -> turn-scoped ToolGateway
                                                        |             |
                                                  terminal             workspace
                                                        |             |
                                                        v             v
                                              SharedTerminalTool   PolicyWorkspaceTool
                                                        |             |
human keyboard -----------------------------------------+             v
                                                        |         WorkspaceTool adapter
                                                        v             |
                                                 TerminalService      v
                                                                  AgentFileService
                                                    |       |          |
                                                    v       v          v
                                            visible PTY  SSH shell    +-------------------------+
                                                                      |                         |
                                                                      v                         v
                                                       LocalFilesystemBackend   RemoteFilesystemProvider
                                                                                         |
                                                                  SFTP subsystem on the existing
                                                                  TerminalService SSH connection
```

## Boundaries and ownership

- `AgentBackend` is the replaceable Harness boundary. It owns provider-facing
  conversation execution, but not Session lifecycle, approval, takeover,
  permissions, persistence, terminal creation, or filesystem transport.
  `GenericHarnessBackend` currently adapts `AgentLoop` to this contract.
- `SessionToolContext` is an immutable snapshot of the Session identifier,
  terminal binding, optional explicit Workspace Root, Host identity, and
  granular capabilities. A Workspace Root is never inferred from terminal
  `cwd`.
- `ToolGateway` is created for one live turn. `SharedTerminalTool` revalidates
  the Session/terminal/Host binding and routes execution through the normal
  approval and shared-terminal command path. It also reads the history produced
  by that same terminal.
- `WorkspaceTool` is an independent data-plane API for bounded list, read,
  stat, search, glob, write, patch, mkdir, rename, and delete operations. Local
  Sessions use `LocalFilesystemBackend`; SSH Sessions obtain an SFTP subsystem
  from the already-connected terminal's SSH client through
  `RemoteFilesystemProvider`. Both sit behind the common `FilesystemBackend`
  primitive contract (`RemoteFilesystem` is its SFTP compatibility name).
- Turn, provider recipient, permission generation, Session connection,
  terminal identity, Workspace Root, and Host changes revoke the injected
  tools. In-flight Workspace operations are settled before a turn is released.

For SSH, `SessionToolContext` requires the terminal, Session, Workspace binding,
and SFTP backend to carry the same `hostId`. The remote filesystem provider
checks that identity again before opening SFTP. This is the same-host invariant:
terminal commands and Workspace operations cannot silently target different
machines.

## Permission model

Terminal permissions are independent `read`, `execute`, `sendInput`, and
`interrupt` capabilities. Command execution remains owned by `AgentService`,
including approval, command serialization, cancellation, and Full Takeover;
arbitrary `sendInput` is disabled by default.

Workspace access defaults to `off` and supports `read-only`, `read-write`, and
explicitly confirmed `full-access` modes. The policy membrane checks
`read`/`write`/`create`/`delete` independently and enforces canonical absolute
readable and writable scopes on every call. Full Filesystem Access removes only
the application's path-range restriction. It does not bypass capability bits,
OS or SFTP account permissions, same-host checks, protected Session storage,
symlink/path validation, expected-SHA conflict checks, or operation auditing.
Grants are fail-closed and bound to the current connected Session and provider
recipient.

## Journal and activity surfaces

Every Workspace operation writes a durable intent before dispatch and a durable
outcome afterward to the Session's protected
`workspace/operations.jsonl`. Outcomes distinguish success/failure and record
whether a side effect is known committed (`true`), known uncommitted (`false`),
or uncertain (`null`). The JSONL schema is allowlisted and excludes file bodies,
patch text, search queries, raw errors, credentials, and hostnames. Bounded
write/patch diffs live in separate hashed artifacts under `workspace/diffs/`.
Production bounds are 32 KiB per JSONL record, 64 KiB per diff, 8 MiB for the
log, and 256 MiB for total journal storage; exhaustion fails closed.

Agent tool activities are a separate, bounded UI summary. They expose sanitized
operation labels, running/succeeded/failed/cancelled state, and small facts such
as exit code or result count. They do not replace the durable Workspace journal
and do not retain file contents, patches, or command payloads. Actual shell
commands and output remain visible in the shared terminal history.

## Extension points

A future Codex-backed `AgentBackend` may reuse `SessionToolContext` and
`ToolGateway` when it needs these exact shared-terminal guarantees; it must not
bypass them with Codex-internal shell, filesystem, or SSH access.

An optional future MCP adapter should expose this same main-process
`ToolGateway`, not create a second tool host, shell, filesystem client, or SSH
connection. MCP is therefore a transport option at the Harness boundary rather
than an alternate authority or execution path.

The gateway design also reserves room for a read-only Git inspection tool
(for example status, diff, and log) rooted in the authorized Workspace. Any Git
operation with possible side effects—including checkout, commit, merge, rebase,
reset, clean, stash, apply, hooks, or configuration changes—continues to run as
a visible terminal command through the normal approval path. Until such a
read-only facade exists, Git commands use the terminal.

## Known large-workspace limits

Search and glob have bounded depth, visited-file count, bytes read, result count,
and elapsed time. However, the current local and SFTP backend APIs return a full
array for one `readdir`; in particular, SFTP must materialize a single enormous
directory before traversal budgets can stop further walking. The implementation
is therefore intended for small and medium projects, not million-entry flat
directories.

Remote path validation and the eventual SFTP operation are separate protocol
requests, leaving a narrow path time-of-check/time-of-use window if another
remote actor replaces an entry concurrently. SFTP also has no portable atomic
"rename only if the destination does not exist" primitive. Exclusive temporary
files, hash preconditions, repeated link checks, and OpenSSH atomic replacement
reduce risk, but cannot provide a universal no-replace guarantee across all
servers. An iterative remote directory API and stronger server-specific
primitives are future hardening work.
