import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
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
});
