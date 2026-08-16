import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostStore } from '../hosts/host-store';
import type { TerminalSnapshot, TerminalService } from '../terminal/terminal-service';
import type { TerminalJournalEvent } from '../../shared/session';
import type { TerminalDescriptor } from '../../shared/terminal';
import { SessionManager } from './session-manager';
import { SessionStore } from './session-store';

const roots: string[] = [];

function owner(): WebContents {
  return { id: 7 } as unknown as WebContents;
}

function descriptor(id: string): TerminalDescriptor {
  return {
    id,
    title: 'Ubuntu',
    profileId: 'ssh:host',
    shellKind: 'posix',
    transport: 'ssh',
    hostId: 'host',
  };
}

function snapshot(id: string, output: string): TerminalSnapshot {
  return {
    descriptor: descriptor(id),
    startedAt: new Date(0).toISOString(),
    history: [{
      version: 1,
      sequence: 1,
      timestamp: new Date(0).toISOString(),
      kind: 'output',
      data: output,
    }],
    preludeTruncated: false,
    droppedPreludeBytes: 0,
  };
}

class FakeTerminals {
  readonly writes: string[] = [];
  readonly snapshots = new Map<string, TerminalSnapshot>();
  readonly bindings = new Map<string, string>();
  private journalListener?: (
    terminalId: string,
    sessionId: string,
    event: TerminalJournalEvent,
  ) => void;

  onJournal(listener: (
    terminalId: string,
    sessionId: string,
    event: TerminalJournalEvent,
  ) => void) {
    this.journalListener = listener;
    return () => { this.journalListener = undefined; };
  }
  snapshot(_owner: WebContents, terminalId: string) {
    const value = this.snapshots.get(terminalId);
    if (!value) throw new Error('missing snapshot');
    return value;
  }
  sessionId(_owner: WebContents, terminalId: string) { return this.bindings.get(terminalId); }
  bindSession(_owner: WebContents, terminalId: string, sessionId: string) {
    this.bindings.set(terminalId, sessionId);
  }
  write(_owner: WebContents, _terminalId: string, input: string) { this.writes.push(input); }
  emitOutput(terminalId: string, data: string) {
    const sessionId = this.bindings.get(terminalId);
    if (!sessionId) throw new Error('terminal is not bound');
    this.journalListener?.(terminalId, sessionId, {
      version: 1,
      sequence: 2,
      timestamp: new Date(1).toISOString(),
      kind: 'output',
      data,
    });
  }
  emitExit(terminalId: string) {
    const sessionId = this.bindings.get(terminalId);
    if (!sessionId) throw new Error('terminal is not bound');
    this.journalListener?.(terminalId, sessionId, {
      version: 1,
      sequence: 3,
      timestamp: new Date(2).toISOString(),
      kind: 'exit',
      exitCode: 0,
    });
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('SessionManager reconnect restoration', () => {
  it('captures prompt context, restores it on reconnect, and exposes the rebound Session', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-manager-test-'));
    roots.push(root);
    const terminals = new FakeTerminals();
    terminals.snapshots.set(
      'old-terminal',
      snapshot('old-terminal', 'zjn@ubuntu:~$ sudo -i\r\nroot@ubuntu:/srv/project# '),
    );
    let currentHost = {
        id: 'host',
        name: 'Ubuntu',
        hostname: '192.0.2.10',
        port: 22,
        username: 'zjn',
      };
    const hosts = {
      get: vi.fn(() => currentHost),
    } as unknown as HostStore;
    const manager = new SessionManager(
      new SessionStore(join(root, 'sessions')),
      terminals as unknown as TerminalService,
      hosts,
    );
    const browser = owner();

    const session = manager.upgrade(browser, 'old-terminal');
    expect(session).toMatchObject({ cwd: '/srv/project', effectiveUser: 'root' });

    terminals.emitOutput('old-terminal', '\r\nroot@ubuntu:/opt/new-project# ');
    expect(manager.list('host')[0]).toMatchObject({
      cwd: '/opt/new-project',
      effectiveUser: 'root',
    });
    terminals.emitExit('old-terminal');

    terminals.snapshots.set('new-terminal', snapshot('new-terminal', 'zjn@ubuntu:~$ '));
    const reconnected = manager.reconnect(browser, descriptor('new-terminal'), session.id);

    expect(reconnected.runtimeTerminalId).toBe('new-terminal');
    expect(terminals.writes).toHaveLength(1);
    expect(terminals.writes[0]).toContain("sudo -iu 'root'");
    expect(terminals.writes[0]).toContain('/opt/new-project');
    expect(manager.sessionForTerminal(browser, 'new-terminal')?.id).toBe(session.id);

    terminals.snapshots.set('duplicate-terminal', snapshot('duplicate-terminal', 'zjn@ubuntu:~$ '));
    expect(() => manager.reconnect(
      browser,
      descriptor('duplicate-terminal'),
      session.id,
    )).toThrow('仍有活动终端');
    expect(terminals.bindings.has('duplicate-terminal')).toBe(false);

    terminals.emitExit('new-terminal');
    currentHost = { ...currentHost, hostname: '192.0.2.99' };
    terminals.snapshots.set('changed-target-terminal', snapshot('changed-target-terminal', 'zjn@ubuntu:~$ '));
    expect(() => manager.reconnect(
      browser,
      descriptor('changed-target-terminal'),
      session.id,
    )).toThrow('主机地址、端口或用户名已变更');
    expect(terminals.bindings.has('changed-target-terminal')).toBe(false);
    manager.close();
  });

  it('previews persisted content and deletes only an unchanged disconnected Session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-manager-history-test-'));
    roots.push(root);
    const terminals = new FakeTerminals();
    terminals.snapshots.set('history-terminal', snapshot(
      'history-terminal',
      '\u001b[32mzjn@ubuntu:~$\u001b[0m echo history\r\nhistory\r\n',
    ));
    const hosts = {
      get: vi.fn(() => ({
        id: 'host',
        name: 'Ubuntu',
        hostname: '192.0.2.10',
        port: 22,
        username: 'zjn',
      })),
    } as unknown as HostStore;
    const store = new SessionStore(join(root, 'sessions'));
    const manager = new SessionManager(
      store,
      terminals as unknown as TerminalService,
      hosts,
    );
    const browser = owner();
    const created = manager.upgrade(browser, 'history-terminal');
    const threadId = '55555555-5555-5555-5555-555555555555';
    manager.bindAgentThread(created.id, 'provider', threadId);
    manager.appendThreadEvent(created.id, threadId, {
      type: 'chat',
      item: {
        id: 'message-1',
        role: 'user',
        content: 'inspect this session',
        createdAt: new Date(3).toISOString(),
      },
    });

    const detail = manager.readHistoryDetail({ sessionId: created.id });
    expect(detail.terminal.content).toContain('echo history');
    expect(detail.terminal.content).not.toContain('\u001b[');
    expect(detail.conversation.messages[0]?.content).toBe('inspect this session');

    terminals.emitExit('history-terminal');
    await expect(manager.remove(browser, {
      sessionId: created.id,
      expectedUpdatedAt: created.updatedAt,
      expectedRuntimeTerminalId: created.runtimeTerminalId,
    })).rejects.toThrow('会话状态已发生变化');

    const disconnected = manager.list()[0]!;
    await manager.remove(browser, {
      sessionId: disconnected.id,
      expectedUpdatedAt: disconnected.updatedAt,
      expectedRuntimeTerminalId: disconnected.runtimeTerminalId,
    });
    expect(manager.list()).toEqual([]);
    manager.close();
  });
});
