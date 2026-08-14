import { homedir } from 'node:os';
import type { WebContents } from 'electron';
import type { HostStore } from '../hosts/host-store';
import type { RenameSessionRequest, SessionRecord } from '../../shared/session';
import type { SessionAuditEvent } from '../../shared/session';
import type { TerminalDescriptor } from '../../shared/terminal';
import type { TerminalService } from '../terminal/terminal-service';
import { SessionStore } from './session-store';

export class SessionManager {
  private readonly removeJournalListener: () => void;

  constructor(
    private readonly store: SessionStore,
    private readonly terminals: TerminalService,
    private readonly hosts: HostStore,
  ) {
    this.removeJournalListener = terminals.onJournal((_terminalId, sessionId, event) => {
      this.store.appendTerminalEvents(sessionId, [event]);
      if (event.kind === 'exit') {
        this.store.markDisconnected(sessionId, event.exitCode, event.signal);
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
    let effectiveUser = process.env.USERNAME;
    let targetSnapshot: SessionRecord['targetSnapshot'] = {
      label: snapshot.descriptor.title,
    };
    if (snapshot.descriptor.hostId) {
      try {
        const host = this.hosts.get(snapshot.descriptor.hostId);
        effectiveUser = host.username;
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
      cwd: snapshot.descriptor.transport === 'local' ? homedir() : undefined,
      targetSnapshot,
    });
    this.terminals.bindSession(owner, terminalId, session.id);

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
    const snapshot = this.terminals.snapshot(owner, terminal.id);
    this.store.appendTerminalEvents(sessionId, snapshot.history);
    this.terminals.bindSession(owner, terminal.id, sessionId);
    return this.store.markConnected(sessionId, terminal.id);
  }

  rename(request: RenameSessionRequest): SessionRecord {
    return this.store.rename(request.sessionId, request.name, request.source ?? 'manual');
  }

  readTerminalHistory(sessionId: string): string {
    return this.store.readTerminalHistory(sessionId);
  }

  bindAgentThread(sessionId: string, providerId: string, threadId: string): SessionRecord {
    return this.store.bindAgentThread(sessionId, providerId, threadId);
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
    this.store.flushAll();
  }
}
