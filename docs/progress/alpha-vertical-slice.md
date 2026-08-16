# Alpha vertical slice status

> Historical milestone record. For the current implementation and code map,
> use `docs/AI_PROJECT_GUIDE.md`; later commits have completed some items that
> were still open when this snapshot was written.

This repository now demonstrates the product-defining path on both local
Windows ConPTY and the designated Ubuntu SSH target:

1. Open a real visible terminal and promote it to a durable Session.
2. Let a configured OpenAI-compatible Provider inspect bounded terminal
   context and propose commands.
3. Execute/Edit/Reject each command by default in that exact terminal.
4. Explicitly enable Full Takeover for consecutive commands, then Take Control
   with keep-process or exact Ctrl+C semantics.
5. Pause on an authentication prompt, accept the credential only in the same
   visible terminal, redact persistence/model output, and resume the Agent.
6. Browse and transfer files over an SFTP subsystem on the existing SSH
   connection, with asynchronous queue/progress/cancel/retry.
7. Persist Host, Session, terminal log, AI Thread, and Audit across restart.

This was an **Alpha vertical slice**, not the completed Core Demo. At the time
of this snapshot, the Codex App Server Thread/Turn Agent data plane was not yet
connected (it is connected now; see `docs/AI_PROJECT_GUIDE.md`). ProxyJump,
complete cwd/effective-user restoration, manual Secure Input fallback,
arbitrary interactive/full-screen programs, Portable packaging, and the full
30-step release acceptance remain open.
