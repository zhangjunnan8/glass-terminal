import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalJournalEvent } from '../../shared/session';
import { SessionStore } from './session-store';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-terminal-session-test-'));
  temporaryRoots.push(root);
  return join(root, 'sessions');
}

function output(sequence: number, data: string): TerminalJournalEvent {
  return {
    version: 1,
    sequence,
    timestamp: new Date().toISOString(),
    kind: 'output',
    data,
  };
}

function createSession(store: SessionStore) {
  return store.create({
    descriptor: {
      id: 'runtime-terminal',
      title: 'Ubuntu Lab',
      profileId: 'ssh:host-1',
      shellKind: 'posix',
      transport: 'ssh',
      hostId: 'host-1',
    },
    startedAt: new Date().toISOString(),
    history: [output(1, 'pre-promotion output\r\n')],
    preludeTruncated: false,
    droppedPreludeBytes: 0,
    effectiveUser: 'tester',
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  }
});

describe('SessionStore', () => {
  it('does not create persistent data until a Session is promoted', () => {
    const root = temporaryRoot();
    const store = new SessionStore(root);

    expect(store.list()).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it('persists pre-promotion and live output in compressed indexed chunks', () => {
    const root = temporaryRoot();
    const store = new SessionStore(root);
    const session = createSession(store);

    store.appendTerminalEvents(session.id, [output(2, 'live output\r\n')]);
    store.flushAll();

    expect(store.readTerminalHistory(session.id)).toBe(
      'pre-promotion output\r\nlive output\r\n',
    );
    const terminalPath = join(root, session.id, 'terminal');
    const chunks = readdirSync(terminalPath).filter((file) => file.endsWith('.jsonl.gz'));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(readFileSync(join(terminalPath, 'index.json'), 'utf8')).chunks)
      .toHaveLength(chunks.length);
  });

  it('reads only terminal history after a durable cursor across chunk boundaries', () => {
    const root = temporaryRoot();
    const store = new SessionStore(root);
    const session = createSession(store);
    const cursor = store.currentTerminalHistoryCursor(session.id);

    store.appendTerminalEvents(session.id, [output(2, 'second chunk\r\n')]);
    store.flushAll();

    expect(store.readTerminalHistorySince(session.id, cursor, 1_000)).toEqual({
      content: 'second chunk\r\n',
      nextCursor: {
        version: 1,
        position: cursor.position + 'second chunk\r\n'.length,
      },
      truncated: false,
    });
  });

  it('uses chunk offsets to skip unrelated compressed history', () => {
    const root = temporaryRoot();
    const store = new SessionStore(root);
    const session = createSession(store);
    const cursor = store.currentTerminalHistoryCursor(session.id);
    store.appendTerminalEvents(session.id, [output(2, 'readable tail')]);
    store.flushAll();

    const terminalPath = join(root, session.id, 'terminal');
    const index = JSON.parse(readFileSync(join(terminalPath, 'index.json'), 'utf8'));
    writeFileSync(join(terminalPath, index.chunks[0].file), 'not gzip data');

    expect(store.readTerminalHistorySince(session.id, cursor, 1_000).content)
      .toBe('readable tail');
  });

  it('migrates a version-one terminal index once and preserves readable history', () => {
    const root = temporaryRoot();
    const store = new SessionStore(root);
    const session = createSession(store);
    store.appendTerminalEvents(session.id, [output(2, 'legacy tail')]);
    store.flushAll();
    const indexPath = join(root, session.id, 'terminal', 'index.json');
    const current = JSON.parse(readFileSync(indexPath, 'utf8'));
    writeFileSync(indexPath, JSON.stringify({
      version: 1,
      chunks: current.chunks.map(({
        historyStart: _historyStart,
        historyEnd: _historyEnd,
        ...chunk
      }: Record<string, unknown>) => chunk),
    }));

    const reloaded = new SessionStore(root);
    expect(reloaded.readTerminalHistorySince(session.id, undefined, 1_000).content)
      .toBe('pre-promotion output\r\nlegacy tail');
    expect(JSON.parse(readFileSync(indexPath, 'utf8'))).toMatchObject({
      version: 2,
      nextHistoryPosition: 'pre-promotion output\r\nlegacy tail'.length,
    });
  });

  it.each([7, 30, 90, 180])(
    'applies a live %i-day terminal-only retention policy asynchronously',
    async (days) => {
      const root = temporaryRoot();
      const store = new SessionStore(root, { terminalLogRetentionDays: 0 });
      const session = createSession(store);
      const threadId = '55555555-5555-5555-5555-555555555555';
      store.bindAgentThread(session.id, 'provider', threadId, 'd'.repeat(64));
      store.appendThreadEvent(session.id, threadId, { type: 'retention-canary' });
      const operation = store.beginWorkspaceOperation(session.id, {
        operation: 'read',
        backend: 'sftp',
        target: { path: { scope: 'workspace', path: 'README.md' } },
      });
      store.finishWorkspaceOperation(operation, {
        outcome: 'succeeded',
        sideEffectCommitted: false,
      });
      const auditBefore = store.readAudit(session.id);
      const threadBefore = store.readThreadEvents(session.id, threadId);
      const operationsBefore = store.readWorkspaceOperations(session.id);
      const indexPath = join(root, session.id, 'terminal', 'index.json');
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      index.chunks[0].createdAt = new Date(Date.now() - (days + 1) * 86_400_000)
        .toISOString();
      writeFileSync(indexPath, JSON.stringify(index));

      store.setTerminalLogRetentionDays(days);
      let settled = false;
      const cleanup = store.enforceTerminalLogRetention().then(() => { settled = true; });
      expect(settled).toBe(false);
      await cleanup;

      expect(store.readTerminalHistory(session.id)).toBe('');
      expect(readdirSync(join(root, session.id, 'terminal')))
        .toEqual(['index.json']);
      expect(existsSync(join(root, session.id, 'ai'))).toBe(true);
      expect(existsSync(join(root, session.id, 'audit.jsonl'))).toBe(true);
      expect(store.readAudit(session.id)).toEqual(auditBefore);
      expect(store.readThreadEvents(session.id, threadId)).toEqual(threadBefore);
      expect(store.readWorkspaceOperations(session.id)).toEqual(operationsBefore);
    },
  );

  it('keeps old terminal chunks when days is zero but still enforces the capacity limit', async () => {
    const root = temporaryRoot();
    const unlimitedByTime = new SessionStore(root, {
      terminalLogRetentionDays: 0,
      maxTerminalLogBytes: 10_000,
    });
    const session = createSession(unlimitedByTime);
    const indexPath = join(root, session.id, 'terminal', 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.chunks[0].createdAt = new Date(0).toISOString();
    writeFileSync(indexPath, JSON.stringify(index));
    await unlimitedByTime.enforceTerminalLogRetention();
    expect(unlimitedByTime.readTerminalHistory(session.id)).toContain('pre-promotion');

    const capacityBound = new SessionStore(root, {
      terminalLogRetentionDays: 0,
      maxTerminalLogBytes: 1,
    });
    await capacityBound.enforceTerminalLogRetention();
    expect(capacityBound.readTerminalHistory(session.id)).toBe('');
  });

  it('never automatically cleans terminal chunks for a pinned Session', async () => {
    const root = temporaryRoot();
    const initial = new SessionStore(root);
    const session = createSession(initial);
    const metadataPath = join(root, session.id, 'session.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, pinned: true }));
    const indexPath = join(root, session.id, 'terminal', 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.chunks[0].createdAt = new Date(0).toISOString();
    writeFileSync(indexPath, JSON.stringify(index));

    const pinned = new SessionStore(root, {
      terminalLogRetentionDays: 7,
      maxTerminalLogBytes: 1,
    });
    await pinned.enforceTerminalLogRetention();

    expect(pinned.readTerminalHistory(session.id)).toContain('pre-promotion');
  });

  it('reloads durable metadata, marks interrupted sessions, and keeps audit history', () => {
    const root = temporaryRoot();
    const initialStore = new SessionStore(root);
    const session = createSession(initialStore);
    initialStore.flushAll();

    const reloaded = new SessionStore(root);
    const restored = reloaded.get(session.id);

    expect(restored.status).toBe('interrupted');
    expect(restored.connectionState).toBe('disconnected');
    expect(reloaded.readTerminalHistory(session.id)).toContain('pre-promotion output');
    expect(reloaded.readAudit(session.id).map((event) => event.type)).toEqual([
      'session_created',
      'session_disconnected',
    ]);
  });

  it('never lets automatic naming overwrite a manual Session name', () => {
    const store = new SessionStore(temporaryRoot());
    const session = createSession(store);

    const manual = store.rename(session.id, 'Production investigation', 'manual');
    const automatic = store.rename(session.id, 'Suggested title', 'automatic');

    expect(manual.nameSource).toBe('manual');
    expect(automatic.name).toBe('Production investigation');
    expect(store.readAudit(session.id).filter((event) => event.type === 'session_renamed'))
      .toHaveLength(1);
  });

  it('durably updates cwd and effective user without replacing the AI thread binding', () => {
    const root = temporaryRoot();
    const store = new SessionStore(root);
    const session = createSession(store);
    const threadId = '22222222-2222-2222-2222-222222222222';
    store.bindAgentThread(session.id, 'provider', threadId, 'a'.repeat(64));

    store.updateShellContext(session.id, { cwd: '/srv/project', effectiveUser: 'root' });

    const restored = new SessionStore(root).get(session.id);
    expect(restored.cwd).toBe('/srv/project');
    expect(restored.effectiveUser).toBe('root');
    expect(restored.aiThreadId).toBe(threadId);
    expect(restored.agentBackend).toEqual({ kind: 'generic-provider', providerId: 'provider' });
  });

  it('persists, audits, and clears an explicit same-host workspace binding', () => {
    const root = temporaryRoot();
    const store = new SessionStore(root);
    const session = createSession(store);

    const updated = store.setWorkspace(session.id, {
      backend: 'sftp',
      root: '/srv/project',
      hostId: 'host-1',
    });

    expect(updated.workspace).toEqual({
      backend: 'sftp',
      root: '/srv/project',
      hostId: 'host-1',
    });
    expect(JSON.parse(
      readFileSync(join(root, session.id, 'session.json'), 'utf8'),
    ).workspace).toEqual(updated.workspace);
    const cleared = store.setWorkspace(session.id, undefined);
    expect(cleared.workspace).toBeUndefined();
    expect(JSON.parse(
      readFileSync(join(root, session.id, 'session.json'), 'utf8'),
    ).workspace).toBeUndefined();
    expect(store.readAudit(session.id).filter((event) => event.type === 'workspace_changed'))
      .toMatchObject([
        {
          actor: 'user',
          details: {
            previousWorkspace: null,
            workspace: updated.workspace,
          },
        },
        {
          actor: 'user',
          details: {
            previousWorkspace: updated.workspace,
            workspace: null,
          },
        },
      ]);
  });

  it('persists typed Workspace operations without changing the terminal journal', () => {
    const root = temporaryRoot();
    const store = new SessionStore(root);
    const session = createSession(store);
    const terminalBefore = store.readTerminalHistory(session.id);
    const handle = store.beginWorkspaceOperation(session.id, {
      operation: 'read',
      backend: 'sftp',
      target: { path: { scope: 'workspace', path: 'src/main.ts' } },
    });

    store.finishWorkspaceOperation(handle, {
      outcome: 'succeeded',
      sideEffectCommitted: false,
      effect: { bytes: 128 },
    });

    expect(store.readWorkspaceOperations(session.id)).toMatchObject([
      { sequence: 1, recordType: 'intent', operation: 'read' },
      { sequence: 2, recordType: 'outcome', outcome: 'succeeded' },
    ]);
    expect(store.recoverWorkspaceOperations(session.id)[0]).toMatchObject({
      sideEffectCommitted: false,
    });
    expect(store.workspaceStorageProtection(session.id)).toEqual({
      root: resolve(root),
      operationJournalPath: join(
        resolve(root),
        session.id,
        'workspace',
        'operations.jsonl',
      ),
    });
    expect(store.readTerminalHistory(session.id)).toBe(terminalBefore);
    expect(new SessionStore(root).readWorkspaceOperations(session.id)).toHaveLength(2);
  });

  it('rejects workspace bindings that do not match the Session transport and Host', () => {
    const store = new SessionStore(temporaryRoot());
    const sshSession = createSession(store);
    const localSession = store.create({
      descriptor: {
        id: 'local-terminal',
        title: 'PowerShell',
        profileId: 'powershell',
        shellKind: 'powershell',
        transport: 'local',
      },
      startedAt: new Date().toISOString(),
      history: [],
      preludeTruncated: false,
      droppedPreludeBytes: 0,
    });

    expect(() => store.setWorkspace(sshSession.id, {
      backend: 'local',
      root: 'C:\\project',
    })).toThrow('SSH Session requires an SFTP workspace');
    expect(() => store.setWorkspace(sshSession.id, {
      backend: 'sftp',
      root: '/srv/project',
      hostId: 'another-host',
    })).toThrow('same Host');
    expect(() => store.setWorkspace(sshSession.id, {
      backend: 'sftp',
      root: 'srv/project',
      hostId: 'host-1',
    })).toThrow('same Host');
    expect(() => store.setWorkspace(localSession.id, {
      backend: 'sftp',
      root: '/srv/project',
      hostId: 'host-1',
    })).toThrow('Local Session requires a local workspace');
    expect(() => store.setWorkspace(localSession.id, {
      backend: 'local',
      root: 'C:\\project',
      hostId: 'host-1',
    })).toThrow('without a host binding');
  });

  it('rejects malformed or cross-host workspace bindings while loading metadata', () => {
    const invalidBindings = [
      { backend: 'sftp', root: 42, hostId: 'host-1' },
      { backend: 'sftp', root: '/srv/project', hostId: 'another-host' },
      { backend: 'sftp', root: 'srv/project', hostId: 'host-1' },
    ];

    for (const workspace of invalidBindings) {
      const root = temporaryRoot();
      const store = new SessionStore(root);
      const session = createSession(store);
      const metadataPath = join(root, session.id, 'session.json');
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      metadata.workspace = workspace;
      writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, 'utf8');

      expect(() => new SessionStore(root)).toThrow(/workspace|same Host/i);
    }
  });

  it('persists the local and upstream thread mapping for the isolated App Server backend', () => {
    const root = temporaryRoot();
    const store = new SessionStore(root);
    const session = createSession(store);
    const localThreadId = '22222222-2222-2222-2222-222222222222';

    store.bindAgentBackendThread(session.id, {
      kind: 'codex-app-server-isolated',
      policyVersion: 1,
    }, localThreadId);
    store.bindProviderThread(session.id, localThreadId, 'upstream-thread-opaque');

    const restored = new SessionStore(root).get(session.id);
    expect(restored.aiThreadId).toBe(localThreadId);
    expect(restored.agentBackend).toEqual({
      kind: 'codex-app-server-isolated',
      policyVersion: 1,
    });
    expect(restored.providerId).toBeUndefined();
    expect(restored.providerThreadId).toBe('upstream-thread-opaque');
  });

  it('reads bounded recent terminal and AI history previews', () => {
    const store = new SessionStore(temporaryRoot());
    const session = createSession(store);
    store.appendTerminalEvents(session.id, [output(2, `marker-${'x'.repeat(120)}`)]);
    const terminal = store.readRecentTerminalHistory(session.id, 32);
    expect(terminal.truncated).toBe(true);
    expect(terminal.content).toBe('x'.repeat(32));

    const threadId = '33333333-3333-3333-3333-333333333333';
    store.bindAgentThread(session.id, 'provider', threadId, 'b'.repeat(64));
    store.appendThreadEvent(session.id, threadId, {
      type: 'chat',
      item: {
        id: 'old',
        role: 'user',
        content: 'old'.repeat(500),
        createdAt: new Date(0).toISOString(),
      },
    });
    store.appendThreadEvent(session.id, threadId, {
      type: 'chat',
      item: {
        id: 'recent',
        role: 'assistant',
        content: 'recent answer',
        createdAt: new Date(1).toISOString(),
      },
    });
    const conversation = store.readRecentThreadEvents(session.id, threadId, 300);
    expect(conversation.truncated).toBe(true);
    expect(conversation.events).toHaveLength(1);
    expect(JSON.stringify(conversation.events[0])).toContain('recent answer');
  });

  it('refuses active deletion and removes the entire disconnected Session directory', async () => {
    const root = temporaryRoot();
    const store = new SessionStore(root);
    const session = createSession(store);
    await expect(store.remove(session.id)).rejects.toThrow('活动或正在运行');
    expect(existsSync(join(root, session.id))).toBe(true);

    store.markDisconnected(session.id, 0);
    const threadId = '44444444-4444-4444-4444-444444444444';
    store.bindAgentThread(session.id, 'provider', threadId, 'c'.repeat(64));
    store.appendThreadEvent(session.id, threadId, { type: 'test' });
    await store.remove(session.id);

    expect(store.list()).toEqual([]);
    expect(existsSync(join(root, session.id))).toBe(false);
    expect(readdirSync(root).filter((name) => name.includes(session.id))).toEqual([]);
  });

  it('restores the audit sequence from a bounded file tail instead of parsing full history', () => {
    const root = temporaryRoot();
    const store = new SessionStore(root);
    const session = createSession(store);
    for (let index = 0; index < 350; index += 1) {
      store.appendAudit(session.id, 'command_requested', 'ai', {
        index,
        padding: 'x'.repeat(1_024),
      });
    }
    const previousSequence = store.readAudit(session.id).at(-1)!.sequence;
    const fullAuditRead = vi.spyOn(SessionStore.prototype, 'readAudit');

    const restored = new SessionStore(root);

    expect(fullAuditRead).not.toHaveBeenCalled();
    fullAuditRead.mockRestore();
    const next = createSession(restored);
    expect(restored.readAudit(next.id)[0]!.sequence).toBeGreaterThan(previousSequence);
  });

  it('expands the audit tail window when the final valid record exceeds 256 KiB', () => {
    const root = temporaryRoot();
    const store = new SessionStore(root);
    const session = createSession(store);
    store.appendAudit(session.id, 'command_requested', 'ai', {
      command: 'x'.repeat(320 * 1024),
    });
    const previousSequence = store.readAudit(session.id).at(-1)!.sequence;
    const fullAuditRead = vi.spyOn(SessionStore.prototype, 'readAudit');

    const restored = new SessionStore(root);

    expect(fullAuditRead).not.toHaveBeenCalled();
    fullAuditRead.mockRestore();
    const next = createSession(restored);
    expect(restored.readAudit(next.id)[0]!.sequence).toBeGreaterThan(previousSequence);
  });
});
