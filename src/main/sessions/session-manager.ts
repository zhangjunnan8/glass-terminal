import { homedir } from 'node:os';
import { isAbsolute, posix } from 'node:path';
import type { WebContents } from 'electron';
import type { HostStore } from '../hosts/host-store';
import type {
  ClearWorkspaceRequest,
  DeleteSessionRequest,
  ReadSessionHistoryDetailRequest,
  RenameSessionRequest,
  SetWorkspaceRequest,
  SessionHistoryDetail,
  SessionRecord,
} from '../../shared/session';
import type { SessionAuditEvent } from '../../shared/session';
import type { AgentBackendRef } from '../../shared/agent';
import type { TerminalDescriptor } from '../../shared/terminal';
import type { TerminalService } from '../terminal/terminal-service';
import { LocalFilesystemBackend } from '../filesystem/local-filesystem';
import { RemoteFilesystemProvider } from '../filesystem/remote-filesystem';
import {
  buildSshRestoreInput,
  inferShellContext,
  ShellContextTracker,
} from './session-context';
import { conversationPreview, plainTerminalPreview } from './session-history';
import { SessionStore } from './session-store';

export class SessionManager {
  private readonly removeJournalListener: () => void;
  private readonly contextTrackers = new Map<string, ShellContextTracker>();

  constructor(
    private readonly store: SessionStore,
    private readonly terminals: TerminalService,
    private readonly hosts: HostStore,
    private readonly remoteFilesystems = new RemoteFilesystemProvider(terminals),
    private readonly localFilesystem = new LocalFilesystemBackend(),
  ) {
    this.removeJournalListener = terminals.onJournal((_terminalId, sessionId, event) => {
      this.store.appendTerminalEvents(sessionId, [event]);
      if (event.kind === 'output') {
        try {
          const session = this.store.get(sessionId);
          let tracker = this.contextTrackers.get(sessionId);
          if (!tracker) {
            tracker = new ShellContextTracker(session.shellKind);
            this.contextTrackers.set(sessionId, tracker);
          }
          const context = tracker.push(event.data);
          if (context) this.store.updateShellContext(sessionId, context);
        } catch (error) {
          // Terminal I/O must remain usable if a context metadata update cannot be persisted.
          console.error('Unable to persist Session shell context:', error);
        }
      }
      if (event.kind === 'exit') {
        this.store.markDisconnected(sessionId, event.exitCode, event.signal);
        this.contextTrackers.delete(sessionId);
      }
    });
  }

  list(hostId?: string): SessionRecord[] {
    return this.store.list(hostId);
  }

  upgrade(owner: WebContents, terminalId: string): SessionRecord {
    const existingSessionId = this.terminals.sessionId(owner, terminalId);
    if (existingSessionId) return this.store.get(existingSessionId);

    const snapshot = this.terminals.snapshot(owner, terminalId);
    const terminalOutput = snapshot.history
      .filter((event) => event.kind === 'output')
      .map((event) => event.data)
      .join('');
    const inferredContext = inferShellContext(terminalOutput, snapshot.descriptor.shellKind);
    let effectiveUser = inferredContext?.effectiveUser ?? process.env.USERNAME;
    let targetSnapshot: SessionRecord['targetSnapshot'] = {
      label: snapshot.descriptor.title,
    };
    if (snapshot.descriptor.hostId) {
      try {
        const host = this.hosts.get(snapshot.descriptor.hostId);
        effectiveUser = inferredContext?.effectiveUser ?? host.username;
        targetSnapshot = {
          label: host.name,
          hostname: host.hostname,
          port: host.port,
          username: host.username,
        };
      } catch {
        // A live terminal can outlast a deleted Host profile; history remains independent.
        effectiveUser = undefined;
      }
    }
    const session = this.store.create({
      ...snapshot,
      effectiveUser,
      cwd: inferredContext?.cwd
        ?? (snapshot.descriptor.transport === 'local' ? homedir() : undefined),
      targetSnapshot,
    });
    this.terminals.bindSession(owner, terminalId, session.id);
    const tracker = new ShellContextTracker(snapshot.descriptor.shellKind);
    tracker.push(terminalOutput);
    this.contextTrackers.set(session.id, tracker);

    const exit = [...snapshot.history].reverse().find((event) => event.kind === 'exit');
    if (exit?.kind === 'exit') {
      return this.store.markDisconnected(session.id, exit.exitCode, exit.signal);
    }
    return session;
  }

  reconnect(
    owner: WebContents,
    terminal: TerminalDescriptor,
    sessionId: string,
  ): SessionRecord {
    const session = this.store.get(sessionId);
    if (session.transport !== terminal.transport || session.hostId !== terminal.hostId) {
      throw new Error('Session target does not match the connected terminal.');
    }
    if (session.transport === 'ssh' && session.hostId) {
      const host = this.hosts.get(session.hostId);
      const target = session.targetSnapshot;
      if (
        target.hostname !== host.hostname
        || target.port !== host.port
        || target.username !== host.username
      ) {
        throw new Error('主机地址、端口或用户名已变更；为避免将旧会话上下文发送到新目标，请新建会话。');
      }
    }
    if (
      session.connectionState === 'connected'
      && session.runtimeTerminalId !== terminal.id
    ) {
      throw new Error('该会话仍有活动终端；请先打开现有终端或关闭它后再重连。');
    }
    const snapshot = this.terminals.snapshot(owner, terminal.id);
    this.store.appendTerminalEvents(sessionId, snapshot.history);
    this.terminals.bindSession(owner, terminal.id, sessionId);
    const connected = this.store.markConnected(sessionId, terminal.id);
    this.contextTrackers.set(sessionId, new ShellContextTracker(session.shellKind));
    const restoreInput = buildSshRestoreInput(session);
    if (restoreInput) this.terminals.write(owner, terminal.id, restoreInput);
    return connected;
  }

  sessionForTerminal(owner: WebContents, terminalId: string): SessionRecord | undefined {
    const sessionId = this.terminals.sessionId(owner, terminalId);
    return sessionId ? this.store.get(sessionId) : undefined;
  }

  async setWorkspace(
    owner: WebContents,
    request: SetWorkspaceRequest,
    beforeCommit?: () => void,
  ): Promise<SessionRecord> {
    const session = this.upgrade(owner, request.terminalId);
    const descriptor = this.terminals.descriptor(owner, request.terminalId);
    if (
      descriptor.transport !== session.transport
      || descriptor.hostId !== session.hostId
    ) throw new Error('Workspace target does not match the Session terminal.');

    if (session.transport === 'local') {
      if (!isAbsolute(request.root)) throw new Error('Local workspace root must be absolute.');
      const root = await this.localFilesystem.realpath(request.root);
      if (!isAbsolute(root)) throw new Error('Local workspace root must resolve absolutely.');
      const attributes = await this.localFilesystem.stat(root);
      if (attributes?.type !== 'directory') {
        throw new Error('Local workspace root must be an existing directory.');
      }
      beforeCommit?.();
      return this.store.setWorkspace(session.id, { backend: 'local', root });
    }

    if (!session.hostId) throw new Error('SSH Session is missing its Host binding.');
    if (!posix.isAbsolute(request.root)) {
      throw new Error('SSH workspace root must be an absolute POSIX path.');
    }
    const root = await this.remoteFilesystems.withFilesystem(
      owner,
      request.terminalId,
      async (filesystem) => {
        const canonicalRoot = await filesystem.realpath(request.root);
        if (!posix.isAbsolute(canonicalRoot)) {
          throw new Error('SSH workspace root must resolve to an absolute POSIX path.');
        }
        const attributes = await filesystem.stat(canonicalRoot);
        if (attributes?.type !== 'directory') {
          throw new Error('SSH workspace root must be an existing directory.');
        }
        return canonicalRoot;
      },
      session.hostId,
    );
    beforeCommit?.();
    return this.store.setWorkspace(session.id, {
      backend: 'sftp',
      root,
      hostId: session.hostId,
    });
  }

  async clearWorkspace(
    owner: WebContents,
    request: ClearWorkspaceRequest,
  ): Promise<SessionRecord> {
    const session = this.upgrade(owner, request.terminalId);
    return this.store.setWorkspace(session.id, undefined);
  }

  rename(request: RenameSessionRequest): SessionRecord {
    return this.store.rename(request.sessionId, request.name, request.source ?? 'manual');
  }

  readTerminalHistory(sessionId: string): string {
    return this.store.readTerminalHistory(sessionId);
  }

  readHistoryDetail(request: ReadSessionHistoryDetailRequest): SessionHistoryDetail {
    const session = this.store.get(request.sessionId);
    const terminal = this.store.readRecentTerminalHistory(session.id);
    const recentEvents = session.aiThreadId
      ? this.store.readRecentThreadEvents(session.id, session.aiThreadId)
      : { events: [], truncated: false };
    return {
      session: { ...session, targetSnapshot: { ...session.targetSnapshot } },
      terminal: {
        content: plainTerminalPreview(terminal.content),
        truncated: terminal.truncated,
      },
      conversation: conversationPreview(recentEvents.events, recentEvents.truncated),
    };
  }

  async remove(owner: WebContents, request: DeleteSessionRequest): Promise<void> {
    const session = this.store.get(request.sessionId);
    if (
      session.updatedAt !== request.expectedUpdatedAt
      || session.runtimeTerminalId !== request.expectedRuntimeTerminalId
    ) {
      throw new Error('会话状态已发生变化；请刷新历史后重新确认删除。');
    }
    if (session.connectionState === 'connected' || session.status === 'active') {
      // Resolve the exact renderer-owned binding when possible, but never let
      // stale metadata make deletion of a nominally active Session possible.
      try {
        const boundSessionId = this.terminals.sessionId(owner, session.runtimeTerminalId);
        if (boundSessionId && boundSessionId !== session.id) {
          throw new Error('Terminal ownership does not match the Session.');
        }
      } catch {
        // The active-state refusal below remains authoritative.
      }
      throw new Error('活动或正在运行的会话不能删除，请先关闭对应终端。');
    }
    this.contextTrackers.delete(session.id);
    await this.store.remove(session.id);
  }

  bindAgentThread(sessionId: string, providerId: string, threadId: string): SessionRecord {
    return this.store.bindAgentThread(sessionId, providerId, threadId);
  }

  bindAgentBackendThread(
    sessionId: string,
    backend: AgentBackendRef,
    threadId: string,
  ): SessionRecord {
    return this.store.bindAgentBackendThread(sessionId, backend, threadId);
  }

  bindProviderThread(
    sessionId: string,
    localThreadId: string,
    providerThreadId: string,
  ): SessionRecord {
    return this.store.bindProviderThread(sessionId, localThreadId, providerThreadId);
  }

  appendThreadEvent(
    sessionId: string,
    threadId: string,
    event: Record<string, unknown>,
  ): void {
    this.store.appendThreadEvent(sessionId, threadId, event);
  }

  readThreadEvents(sessionId: string, threadId: string): Array<Record<string, unknown>> {
    return this.store.readThreadEvents(sessionId, threadId);
  }

  appendAudit(
    sessionId: string,
    type: SessionAuditEvent['type'],
    actor: SessionAuditEvent['actor'],
    details: Record<string, unknown>,
  ): void {
    this.store.appendAudit(sessionId, type, actor, details);
  }

  close(): void {
    this.removeJournalListener();
    this.contextTrackers.clear();
    this.store.flushAll();
  }
}
