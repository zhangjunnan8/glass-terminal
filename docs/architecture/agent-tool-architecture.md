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
  `LangChainBackend` is the current Generic Provider implementation. The former
  in-house `AgentLoop` and `GenericHarnessBackend` were removed.
- `SessionToolContext` is an immutable snapshot of the Session identifier,
  terminal binding, default relative-path root, Host identity, and capabilities.
  An explicit Workspace is an informational work-range hint, not a permission
  boundary. Without one, the root falls back to Session cwd, the SFTP server's
  current absolute directory, or the local user home directory.
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
  terminal identity, default root, and Host changes revoke the injected tool
  lease. The next turn rebinds the current Session, and in-flight file
  operations are settled before a turn is released.

For SSH, `SessionToolContext` requires the terminal, Session, Workspace binding,
and SFTP backend to carry the same `hostId`. The remote filesystem provider
checks that identity again before opening SFTP. This is the same-host invariant:
terminal commands and Workspace operations cannot silently target different
machines.

## Permission model

Terminal permissions are independent `read`, `execute`, `sendInput`, and
`interrupt` capabilities. Command execution remains owned by `AgentService`,
including approval, command serialization, cancellation, and the atomic review mode;
arbitrary `sendInput` is disabled by default.

Beta.4 uses one `reviewMode` for commands and file tools: `all`, `risky`, or
`complete`. New runtimes start in `all`. Entering Complete Access requires an
explicit orange confirmation and grants no authority beyond the current OS or
SSH/SFTP account. Risk Review uses deterministic software classification as the
final arbiter; the model can raise but never lower risk. Unknown commands,
sensitive content reads, and recursive deletion fail into exact approval.

File tools are always available and use full path capability within the current
account. Workspace is only an informational default root for relative paths.
The existing policy membrane still enforces operation capabilities, same-host
binding, protected Session storage, path/symlink validation, expected-SHA
conflict checks, bounded recursive deletion, and operation auditing.

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

## LangChain harness (implemented)

`src/main/agent/langchain-backend.ts` is the concrete `AgentBackend` used for the
Generic Provider path (`index.ts` wires it through `LangChainProviderModelFactory`).
It replaces the in-house `AgentLoop` while keeping every boundary below it intact.

- The model transport is `ChatOpenAICompletions` (any OpenAI-compatible endpoint;
  DeepSeek, GLM, MiniMax, OpenAI all use the same `baseURL` mechanism). The model
  is built lazily from the app's `ProviderStore` so the API key stays in the
  secret store and the recipient revision is fenced, matching `GenericOpenAiProvider`.
- Tool schemas are derived only from the per-turn `ToolGateway`. LangChain's own
  Shell/LocalShell/ApplyPatch tools are never imported; `terminal_execute` and
  `file_*` are the only advertised file tools. Legacy `workspace_*` calls remain
  executable only so persisted conversations can resume. `PolicyWorkspaceTool`
  remains the authoritative per-call path and mutation-safety enforcement layer.
- Responses stream over SSE (`assistant_delta` → `assistant_text`), preserving the
  renderer streaming contract and the smoke tests. Tool calls are aggregated from
  streamed chunks via `collapseToolCallChunks`.
- Each Provider records its model input window (500,736-token default). The renderer shows
  estimated working-context use as a circular meter. Its 100% mark is the safe
  compression threshold (85% of the configured model window), leaving output and
  tool-call headroom rather than waiting for a Provider overflow.
- At that threshold, the selected Provider model summarizes older working history
  into a fixed JSON schema under a separate prompt that treats the transcript as
  untrusted data. Schema, field sizes, apparent credentials, and durable-field
  preservation are checked locally. Invalid output is retried exactly once, then
  a bounded deterministic fallback keeps the turn usable; cancellation is never
  swallowed. Later summaries merge constraints, decisions, and pending work so a
  model omission alone cannot delete them. The latest user request and recent
  complete assistant-tool-result groups remain verbatim.
- User-reviewed context memory cards are persisted separately from transcript
  checkpoints and injected as a dedicated system data block on every Generic turn.
  Cards retain category, source message IDs, timestamps, and pin provenance; the UI
  supports review, source location, edit/merge, and unpin. Limits of 32 cards,
  800 characters per card, and 4,096 estimated tokens keep this memory bounded.
  Apparent credentials are rejected before IPC and again before persistence.
  Visible chat and append-only audit/history remain intact.
- The same conservative estimate is a hard Provider-request gate. It explicitly
  reserves the final 15% of the model window for output, rejects an
  incompressible current prompt locally with estimated/allowed token counts, and
  rechecks after every tool result. If compaction cannot make the current
  assistant/tool protocol group fit, the group is checkpointed intact and the
  turn stops with a visible local error before another Provider request.
- Read-only results consume the live remaining input budget. File reads support
  line ranges and hash-bound continuation cursors; search, glob, and terminal
  history return bounded pages with truncation metadata and opaque continuation
  cursors. Mutating Workspace calls, terminal commands, and path arguments are
  never shortened: a call that cannot fit with its protocol result is rejected
  before execution and asks the model/user to split the operation.
- Completed file-tool bodies are reduced to stable metadata after the next
  reasoning step. Normal turns persist only a context delta; a compression or tool
  history rewrite persists a bounded checkpoint. Legacy full-checkpoint events are
  still replayed as checkpoints, so existing conversations remain readable.
- The harness owns no PTY, SSH, SFTP, or filesystem client; those remain under
  `TerminalService` and `AgentFileService`, reachable only through `ToolGateway`.
- One Generic harness turn freezes the current Settings checkpoint interval when it
  starts (default 40, range 1–64). At each protocol-complete interval the harness
  persists a full checkpoint, refreshes/compacts context, and continues the same
  user turn. A Settings change affects the next turn without rebuilding or clearing
  the existing backend thread; the interval is not a total task-round limit.

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

Generic Provider working context is now bounded prospectively by completed-tool
compaction, automatic summaries, and delta/checkpoint persistence. Existing
`ai/*.jsonl` files are append-only: legacy cumulative checkpoints already on disk
are not physically rewritten, and replay still reads the complete thread event
file to rebuild visible chat and support retract/replace. A future indexed context
snapshot or safe log compactor is needed to remove that historical disk/read cost.

The token count is a conservative provider-agnostic estimate (ASCII word/space
runs roughly four characters per token, syntax punctuation charged individually,
and non-ASCII at least one token per code point), not the exact
tokenizer for every custom endpoint. It includes the messages, the exact serialized
OpenAI function-tool definitions exposed by the current file-access mode, fixed
request/tool wrapping allowances, and a per-Provider safety factor (default 1.15,
range 1.0–2.0). Provider-reported prompt usage is diagnostic only and never reduces
that local safety estimate. Terminal tail reads use incremental journal cursors;
full history remains reserved for explicit replay/export paths.
