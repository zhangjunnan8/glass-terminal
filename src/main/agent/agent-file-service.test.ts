import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as iconv from 'iconv-lite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type {
  FilesystemBackend,
  RemoteFilesystem,
  RemoteFilesystemProvider,
  RemoteFileStat,
} from '../filesystem/remote-filesystem';
import { LocalFilesystemBackend } from '../filesystem/local-filesystem';
import type { SessionManager } from '../sessions/session-manager';
import { SessionStore } from '../sessions/session-store';
import { WorkspaceOperationJournal } from '../sessions/workspace-operation-journal';
import type { TerminalService } from '../terminal/terminal-service';
import {
  AGENT_FILE_LIMITS,
  AgentFileService,
  WorkspaceOperationAuditPersistenceError,
} from './agent-file-service';

const roots: string[] = [];
const TEST_SESSION_ID = '11111111-1111-4111-8111-111111111111';

function createSessionManager(
  sessionForTerminal: () => unknown,
  protectedRoot = join(tmpdir(), 'ai-terminal-test-protected-storage'),
): SessionManager {
  let sequence = 0;
  return {
    sessionForTerminal,
    beginWorkspaceOperation: vi.fn((sessionId: string) => {
      sequence += 1;
      return {
        sessionId,
        operationId: `22222222-2222-4222-8222-${String(sequence).padStart(12, '0')}`,
        intentSequence: sequence,
      };
    }),
    finishWorkspaceOperation: vi.fn(),
    workspaceStorageProtection: vi.fn((sessionId: string) => ({
      root: protectedRoot,
      operationJournalPath: join(
        protectedRoot,
        sessionId,
        'workspace',
        'operations.jsonl',
      ),
    })),
  } as unknown as SessionManager;
}

function createServiceHarness(root: string): {
  service: AgentFileService;
  sessions: SessionManager;
} {
  const sessions = createSessionManager(() => ({
      id: TEST_SESSION_ID,
      transport: 'local',
      cwd: root,
      workspace: { backend: 'local', root },
    }));
  return {
    service: new AgentFileService({} as TerminalService, sessions),
    sessions,
  };
}

function createService(root: string): AgentFileService {
  return createServiceHarness(root).service;
}

function createJournaledService(
  container: string,
  workspaceRoot: string,
  localFilesystem: FilesystemBackend = new LocalFilesystemBackend(),
): {
  service: AgentFileService;
  journal: WorkspaceOperationJournal;
  auditRoot: string;
} {
  const auditRoot = join(container, 'sessions');
  mkdirSync(join(auditRoot, TEST_SESSION_ID), { recursive: true });
  const journal = new WorkspaceOperationJournal(auditRoot);
  const sessions = {
    sessionForTerminal: () => ({
      id: TEST_SESSION_ID,
      transport: 'local',
      workspace: { backend: 'local', root: workspaceRoot },
    }),
    beginWorkspaceOperation: journal.begin.bind(journal),
    finishWorkspaceOperation: journal.finish.bind(journal),
    workspaceStorageProtection: () => ({
      root: auditRoot,
      operationJournalPath: join(
        auditRoot,
        TEST_SESSION_ID,
        'workspace',
        'operations.jsonl',
      ),
    }),
  } as unknown as SessionManager;
  return {
    service: new AgentFileService(
      {} as TerminalService,
      sessions,
      {} as RemoteFilesystemProvider,
      localFilesystem,
    ),
    journal,
    auditRoot,
  };
}

function remoteStat(type: RemoteFileStat['type'], size = 0): RemoteFileStat {
  return {
    mode: type === 'file' ? 0o644 : type === 'directory' ? 0o755 : 0o777,
    size,
    type,
    modifiedAt: '2026-08-16T00:00:00.000Z',
  };
}

function fakeRemoteFilesystem(
  overrides: Partial<RemoteFilesystem> = {},
): RemoteFilesystem {
  return {
    serverCapabilities: () => ({
      detection: 'advertised',
      hardlink: true,
      fsync: true,
      posixRename: true,
      detectedAt: '2026-08-21T00:00:00.000Z',
    }),
    realpath: vi.fn(async (path: string) => path),
    stat: vi.fn(async () => undefined),
    lstat: vi.fn(async () => undefined),
    readFile: vi.fn(async () => Buffer.alloc(0)),
    writeFile: vi.fn(async () => undefined),
    writeFileDurable: vi.fn(async () => ({ fsynced: true })),
    listDirectory: vi.fn(async () => []),
    rename: vi.fn(async () => undefined),
    atomicReplace: vi.fn(async () => undefined),
    hardlink: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rmdir: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createSshService(
  filesystem: RemoteFilesystem,
  remoteWritePolicy: 'strict' | 'compatible' = 'strict',
) {
  const withFilesystem = vi.fn(async <T>(
    _owner: WebContents,
    _terminalId: string,
    operation: (remote: RemoteFilesystem) => Promise<T>,
    _expectedHostId?: string,
  ) => operation(filesystem));
  const provider = { withFilesystem } as unknown as RemoteFilesystemProvider;
  const openSftp = vi.fn(() => {
    throw new Error('AgentFileService must not open SFTP directly.');
  });
  const sessions = createSessionManager(() => ({
      id: TEST_SESSION_ID,
      transport: 'ssh',
      hostId: 'host-1',
      cwd: '/work',
      workspace: {
        backend: 'sftp',
        root: '/work',
        hostId: 'host-1',
        remoteWritePolicy,
      },
    }));
  return {
    service: new AgentFileService(
      { openSftp } as unknown as TerminalService,
      sessions,
      provider,
    ),
    withFilesystem,
    openSftp,
    sessions,
  };
}

describe('AgentFileService local workspace boundary', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads, conflict-checks, patches, and atomically writes UTF-8 files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-files-'));
    roots.push(root);
    writeFileSync(join(root, 'demo.ts'), 'const value = 1;\n', 'utf8');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    const initial = await service.readText(owner, 'terminal', 'demo.ts');
    expect(initial.content).toBe('const value = 1;\n');
    await expect(service.writeText(owner, 'terminal', 'demo.ts', 'unsafe', null))
      .rejects.toThrow('expectedSha256');

    const patched = await service.applyPatch(
      owner,
      'terminal',
      'demo.ts',
      initial.sha256,
      [{ search: 'value = 1', replace: 'value = 2' }],
    );
    expect(patched.created).toBe(false);
    expect(readFileSync(join(root, 'demo.ts'), 'utf8')).toBe('const value = 2;\n');

    const created = await service.writeText(owner, 'terminal', 'new.ts', 'export {};\n', null);
    expect(created.created).toBe(true);
    expect(readFileSync(join(root, 'new.ts'), 'utf8')).toBe('export {};\n');
  });

  it('reads and patches GBK-encoded Chinese files, preserving the original encoding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-gbk-'));
    roots.push(root);
    const original = '策略文件：单价 = 11.05\n';
    const path = join(root, 'script.ps1');
    writeFileSync(path, iconv.encode(original, 'gb18030'));
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    const initial = await service.readText(owner, 'terminal', 'script.ps1');
    expect(initial.content).toBe(original);

    const patched = await service.applyPatch(
      owner,
      'terminal',
      'script.ps1',
      initial.sha256,
      [{ search: '11.05', replace: '12.30' }],
    );
    expect(patched.created).toBe(false);

    // 写回必须保持 GBK 编码：磁盘字节与 gb18030 编码一致，而不是被转成 UTF-8。
    const onDisk = readFileSync(path);
    expect(onDisk.equals(iconv.encode('策略文件：单价 = 12.30\n', 'gb18030'))).toBe(true);
    expect(onDisk.toString('utf8')).not.toContain('策略文件');
    const after = await service.readText(owner, 'terminal', 'script.ps1');
    expect(after.content).toBe('策略文件：单价 = 12.30\n');
  });

  it('strips and restores a UTF-8 BOM across reads and patches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-utf8bom-'));
    roots.push(root);
    const path = join(root, 'bom.txt');
    const body = '配置：alpha\n';
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]));
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    const initial = await service.readText(owner, 'terminal', 'bom.txt');
    expect(initial.content).toBe(body);

    const patched = await service.applyPatch(owner, 'terminal', 'bom.txt', initial.sha256, [
      { search: 'alpha', replace: 'beta' },
    ]);
    expect(patched.created).toBe(false);
    const onDisk = readFileSync(path);
    expect(onDisk.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect(onDisk.subarray(3).toString('utf8')).toBe('配置：beta\n');
  });

  it('reads and patches UTF-16LE files, preserving BOM and byte order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-utf16-'));
    roots.push(root);
    const path = join(root, 'unicode.txt');
    const body = 'Hello 世界\n';
    writeFileSync(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]));
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    const initial = await service.readText(owner, 'terminal', 'unicode.txt');
    expect(initial.content).toBe(body);

    const patched = await service.applyPatch(owner, 'terminal', 'unicode.txt', initial.sha256, [
      { search: '世界', replace: 'world' },
    ]);
    expect(patched.created).toBe(false);
    const onDisk = readFileSync(path);
    expect(onDisk.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))).toBe(true);
    expect(onDisk.subarray(2).toString('utf16le')).toBe('Hello world\n');
  });

  it('emits exactly one intent and outcome for each top-level Workspace operation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-audit-pairs-'));
    roots.push(root);
    writeFileSync(join(root, 'existing.txt'), 'needle old\n', 'utf8');
    const { service, sessions } = createServiceHarness(root);
    const owner = { id: 1 } as WebContents;
    const expected = createHash('sha256').update('needle old\n').digest('hex');

    await service.list(owner, 'terminal');
    await service.readText(owner, 'terminal', 'existing.txt');
    await service.statPath(owner, 'terminal', 'existing.txt');
    await service.search(owner, 'terminal', 'CANARY-query-not-in-intent');
    await service.glob(owner, 'terminal', '**/CANARY-pattern-not-in-intent');
    await service.writeText(
      owner,
      'terminal',
      'new.txt',
      'CANARY-content-only-in-diff',
      null,
    );
    await service.applyPatch(owner, 'terminal', 'existing.txt', expected, [{
      search: 'old',
      replace: 'CANARY-patch-replace-only-in-diff',
    }]);
    await service.mkdirPath(owner, 'terminal', 'created');
    await service.renamePath(owner, 'terminal', 'created', 'renamed');
    await service.deletePath(owner, 'terminal', 'renamed');

    const begin = vi.mocked(sessions.beginWorkspaceOperation);
    const finish = vi.mocked(sessions.finishWorkspaceOperation);
    expect(begin.mock.calls.map((call) => call[1].operation)).toEqual([
      'list',
      'read',
      'stat',
      'search',
      'glob',
      'write',
      'patch',
      'mkdir',
      'rename',
      'delete',
    ]);
    expect(finish).toHaveBeenCalledTimes(10);
    expect(begin.mock.calls.filter((call) => call[2] !== undefined).map((call) => (
      call[1].operation
    ))).toEqual(['write', 'patch']);
    const intentJson = JSON.stringify(begin.mock.calls.map((call) => call[1]));
    expect(intentJson).not.toContain('CANARY-query-not-in-intent');
    expect(intentJson).not.toContain('CANARY-pattern-not-in-intent');
    expect(intentJson).not.toContain('CANARY-content-only-in-diff');
    expect(intentJson).not.toContain('CANARY-patch-replace-only-in-diff');
  });

  it('fails all five mutation kinds before touching the filesystem when durable begin fails', async () => {
    const owner = { id: 1 } as WebContents;
    const cases: Array<{
      name: string;
      prepare(root: string): Promise<() => Promise<unknown>> | (() => Promise<unknown>);
      verify(root: string): void;
    }> = [
      {
        name: 'write',
        prepare: async (root) => {
          const { service, sessions } = createServiceHarness(root);
          vi.mocked(sessions.beginWorkspaceOperation).mockImplementation(() => {
            throw new Error('CANARY-audit-begin-unavailable');
          });
          return () => service.writeText(owner, 'terminal', 'target.txt', 'new', null);
        },
        verify: (root) => {
          expect(existsSync(join(root, 'target.txt'))).toBe(false);
          expect(readdirSync(root)).toEqual([]);
        },
      },
      {
        name: 'patch',
        prepare: async (root) => {
          writeFileSync(join(root, 'target.txt'), 'old', 'utf8');
          const { service, sessions } = createServiceHarness(root);
          vi.mocked(sessions.beginWorkspaceOperation).mockImplementation(() => {
            throw new Error('CANARY-audit-begin-unavailable');
          });
          const expectedSha256 = createHash('sha256').update('old').digest('hex');
          return () => service.applyPatch(owner, 'terminal', 'target.txt', expectedSha256, [{
            search: 'old', replace: 'new',
          }]);
        },
        verify: (root) => {
          expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('old');
          expect(readdirSync(root)).toEqual(['target.txt']);
        },
      },
      {
        name: 'mkdir',
        prepare: async (root) => {
          const { service, sessions } = createServiceHarness(root);
          vi.mocked(sessions.beginWorkspaceOperation).mockImplementation(() => {
            throw new Error('CANARY-audit-begin-unavailable');
          });
          return () => service.mkdirPath(owner, 'terminal', 'target');
        },
        verify: (root) => expect(existsSync(join(root, 'target'))).toBe(false),
      },
      {
        name: 'rename',
        prepare: async (root) => {
          writeFileSync(join(root, 'source.txt'), 'keep', 'utf8');
          const { service, sessions } = createServiceHarness(root);
          vi.mocked(sessions.beginWorkspaceOperation).mockImplementation(() => {
            throw new Error('CANARY-audit-begin-unavailable');
          });
          return () => service.renamePath(owner, 'terminal', 'source.txt', 'destination.txt');
        },
        verify: (root) => {
          expect(readFileSync(join(root, 'source.txt'), 'utf8')).toBe('keep');
          expect(existsSync(join(root, 'destination.txt'))).toBe(false);
        },
      },
      {
        name: 'delete',
        prepare: async (root) => {
          writeFileSync(join(root, 'target.txt'), 'keep', 'utf8');
          const { service, sessions } = createServiceHarness(root);
          vi.mocked(sessions.beginWorkspaceOperation).mockImplementation(() => {
            throw new Error('CANARY-audit-begin-unavailable');
          });
          return () => service.deletePath(owner, 'terminal', 'target.txt');
        },
        verify: (root) => expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('keep'),
      },
    ];

    for (const testCase of cases) {
      const root = mkdtempSync(join(tmpdir(), `ai-terminal-audit-${testCase.name}-`));
      roots.push(root);
      const invoke = await testCase.prepare(root);
      await expect(invoke()).rejects.toThrow('CANARY-audit-begin-unavailable');
      testCase.verify(root);
    }
  });

  it('reports a committed non-retryable result when outcome persistence fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-audit-outcome-'));
    roots.push(root);
    const { service, sessions } = createServiceHarness(root);
    vi.mocked(sessions.finishWorkspaceOperation).mockImplementation(() => {
      throw new Error('CANARY-outcome-storage-failure');
    });

    let caught: unknown;
    try {
      await service.writeText(
        { id: 1 } as WebContents,
        'terminal',
        'committed.txt',
        'committed',
        null,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceOperationAuditPersistenceError);
    expect(caught).toMatchObject({
      code: 'WORKSPACE_AUDIT_OUTCOME_UNAVAILABLE',
      retrySafe: false,
      sideEffectCommitted: true,
    });
    expect((caught as Error).message).toContain('do not retry without re-reading');
    expect((caught as Error).message).not.toContain('CANARY-outcome-storage-failure');
    expect(readFileSync(join(root, 'committed.txt'), 'utf8')).toBe('committed');
  });

  it('records local create publication followed by temp cleanup failure as committed cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-local-create-cleanup-'));
    roots.push(root);
    const { service, sessions } = createServiceHarness(root);
    const cleanupError = Object.assign(new Error('temporary cleanup failed'), { code: 'EACCES' });
    const hooks = service as unknown as {
      removeLocalTemporary(path: string): Promise<void>;
    };
    const removeTemporary = vi.spyOn(hooks, 'removeLocalTemporary')
      .mockRejectedValueOnce(cleanupError)
      .mockImplementation(async (path) => {
        rmSync(path, { force: true });
      });

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'created.txt',
      'created',
      null,
    )).rejects.toBe(cleanupError);

    expect(readFileSync(join(root, 'created.txt'), 'utf8')).toBe('created');
    expect(removeTemporary).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sessions.finishWorkspaceOperation).mock.calls[0]![1]).toEqual({
      outcome: 'failed',
      sideEffectCommitted: true,
      failure: { code: 'permission', stage: 'cleanup', retrySafe: false },
    });
  });

  it('best-effort cleans a partially-created local temp and marks cleanup failure unsafe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-local-temp-cleanup-'));
    roots.push(root);
    const { service, sessions } = createServiceHarness(root);
    const writeError = Object.assign(new Error('partial temp write failed'), { code: 'EIO' });
    const hooks = service as unknown as {
      writeLocalTemporary(path: string, bytes: Buffer, mode: number): Promise<void>;
      removeLocalTemporary(path: string): Promise<void>;
    };
    vi.spyOn(hooks, 'writeLocalTemporary').mockImplementation(async (path) => {
      writeFileSync(path, 'partial', 'utf8');
      throw writeError;
    });
    const removeTemporary = vi.spyOn(hooks, 'removeLocalTemporary')
      .mockRejectedValue(Object.assign(new Error('cleanup denied'), { code: 'EACCES' }));

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'target.txt',
      'target',
      null,
    )).rejects.toBe(writeError);

    expect(existsSync(join(root, 'target.txt'))).toBe(false);
    expect(removeTemporary).toHaveBeenCalledOnce();
    expect(readdirSync(root)).toEqual([expect.stringMatching(/^\.ai-terminal-.*\.tmp$/u)]);
    expect(vi.mocked(sessions.finishWorkspaceOperation).mock.calls[0]![1]).toEqual({
      outcome: 'failed',
      sideEffectCommitted: false,
      failure: { code: 'unknown', stage: 'cleanup', retrySafe: false },
    });
  });

  it('keeps queries, patterns, bodies, patch text, rejected spellings, and raw errors out of JSONL', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-audit-jsonl-'));
    roots.push(container);
    const root = join(container, 'workspace-root');
    mkdirSync(root);
    writeFileSync(join(root, 'existing.txt'), 'CANARY-secret-patch-search\n', 'utf8');
    writeFileSync(join(root, 'provider-error.txt'), 'unread', 'utf8');
    const backend = new LocalFilesystemBackend();
    const rawReadFile = backend.readFile.bind(backend);
    vi.spyOn(backend, 'readFile').mockImplementation(async (path, maxBytes) => {
      if (path.endsWith('provider-error.txt')) {
        throw new Error('CANARY-raw-provider-error-with-host.example');
      }
      return rawReadFile(path, maxBytes);
    });
    const { service, journal, auditRoot } = createJournaledService(container, root, backend);
    const owner = { id: 1 } as WebContents;
    const expected = createHash('sha256')
      .update('CANARY-secret-patch-search\n')
      .digest('hex');

    await service.search(owner, 'terminal', 'CANARY-secret-query');
    await service.glob(owner, 'terminal', '**/CANARY-secret-pattern');
    await service.writeText(
      owner,
      'terminal',
      'new.txt',
      'CANARY-secret-write-body',
      null,
    );
    await service.applyPatch(owner, 'terminal', 'existing.txt', expected, [{
      search: 'CANARY-secret-patch-search',
      replace: 'CANARY-secret-patch-replace',
    }]);
    await expect(service.readText(owner, 'terminal', 'provider-error.txt'))
      .rejects.toThrow('CANARY-raw-provider-error-with-host.example');
    service.recordPolicyRejection(
      owner,
      'terminal',
      'read',
      { path: 'CANARY-invalid-nul\0tail' },
      root,
      { readablePaths: [root], writablePaths: [root], fullAccess: false },
    );
    service.recordPolicyRejection(
      owner,
      'terminal',
      'write',
      { path: `CANARY-overlong-${'x'.repeat(4_097)}` },
      root,
      { readablePaths: [root], writablePaths: [root], fullAccess: false },
    );

    const logPath = join(
      auditRoot,
      TEST_SESSION_ID,
      'workspace',
      'operations.jsonl',
    );
    const jsonl = readFileSync(logPath, 'utf8');
    for (const canary of [
      'CANARY-secret-query',
      'CANARY-secret-pattern',
      'CANARY-secret-write-body',
      'CANARY-secret-patch-search',
      'CANARY-secret-patch-replace',
      'CANARY-raw-provider-error-with-host.example',
      'CANARY-invalid-nul',
      'CANARY-overlong',
    ]) expect(jsonl).not.toContain(canary);
    expect(jsonl).not.toContain('--- a/');

    const records = journal.read(TEST_SESSION_ID);
    expect(records).toHaveLength(14);
    expect(records.filter((record) => record.recordType === 'intent').map((record) => (
      record.operation
    ))).toEqual(['search', 'glob', 'write', 'patch', 'read', 'read', 'write']);
    const rejected = records.filter((record) => (
      record.recordType === 'intent' && record.source === 'policy_workspace_tool'
    ));
    expect(rejected).toHaveLength(2);
    for (const record of rejected) {
      if (record.recordType !== 'intent' || !('path' in record.target)) continue;
      expect(record.target.path).toEqual({
        scope: 'rejected',
        pathHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    }

    const patchIntents = records.filter((record) => (
      record.recordType === 'intent'
      && (record.operation === 'write' || record.operation === 'patch')
    ));
    expect(patchIntents).toHaveLength(3);
    expect(patchIntents.filter((record) => record.recordType === 'intent' && record.diff))
      .toHaveLength(2);
    const diffBodies = readdirSync(join(auditRoot, TEST_SESSION_ID, 'workspace', 'diffs'))
      .map((name) => readFileSync(
        join(auditRoot, TEST_SESSION_ID, 'workspace', 'diffs', name),
        'utf8',
      ))
      .join('\n');
    expect(diffBodies).toContain('CANARY-secret-write-body');
    expect(diffBodies).toContain('CANARY-secret-patch-replace');
  });

  it('normalizes local diff header separators without changing backend paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-local-diff-label-'));
    roots.push(root);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'demo.ts'), 'old\n', 'utf8');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;
    const current = await service.readText(owner, 'terminal', 'src/demo.ts');

    const result = await service.applyPatch(
      owner,
      'terminal',
      'src/demo.ts',
      current.sha256,
      [{ search: 'old', replace: 'new' }],
    );
    expect(result.diff).toContain('--- a/workspace/src/demo.ts');
    expect(result.diff).not.toContain('src\\demo.ts');
    expect(result.path).toBe(join(root, 'src', 'demo.ts'));
  });

  it('requires an explicit compatible Workspace Root instead of falling back to cwd', async () => {
    const owner = { id: 1 } as WebContents;
    const noWorkspace = new AgentFileService({} as TerminalService, {
      sessionForTerminal: () => ({
        id: 'session-id', transport: 'local', cwd: process.cwd(),
      }),
    } as unknown as SessionManager);
    await expect(noWorkspace.bindWorkspaceRoot(owner, 'terminal'))
      .rejects.toThrow('请先设置 Workspace Root');

    const wrongBackend = new AgentFileService({} as TerminalService, {
      sessionForTerminal: () => ({
        id: 'session-id',
        transport: 'local',
        workspace: { backend: 'sftp', root: '/work', hostId: 'host-1' },
      }),
    } as unknown as SessionManager);
    await expect(wrongBackend.bindWorkspaceRoot(owner, 'terminal')).rejects.toThrow(/backend/i);

    const withFilesystem = vi.fn();
    const wrongHost = new AgentFileService(
      {} as TerminalService,
      {
        sessionForTerminal: () => ({
          id: 'session-id',
          transport: 'ssh',
          hostId: 'host-1',
          workspace: { backend: 'sftp', root: '/work', hostId: 'host-2' },
        }),
      } as unknown as SessionManager,
      { withFilesystem } as unknown as RemoteFilesystemProvider,
    );
    await expect(wrongHost.bindWorkspaceRoot(owner, 'terminal')).rejects.toThrow(/Host/);
    expect(withFilesystem).not.toHaveBeenCalled();
  });

  it('rejects a persisted local Workspace Root that now resolves through a link', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-linked-workspace-root-'));
    roots.push(container);
    const actual = join(container, 'actual');
    const linked = join(container, 'linked');
    mkdirSync(actual);
    symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const service = createService(linked);

    await expect(service.bindWorkspaceRoot(
      { id: 1 } as WebContents,
      'terminal',
    )).rejects.toThrow('替换或重定向');
  });

  it('rejects a persisted SFTP Workspace Root that realpaths elsewhere', async () => {
    const filesystem = fakeRemoteFilesystem({
      realpath: vi.fn(async (path: string) => path === '/work' ? '/actual-work' : path),
      stat: vi.fn(async () => remoteStat('directory')),
    });
    const { service, withFilesystem } = createSshService(filesystem);

    await expect(service.bindWorkspaceRoot(
      { id: 1 } as WebContents,
      'terminal',
    )).rejects.toThrow('替换或重定向');
    expect(withFilesystem).toHaveBeenCalledTimes(1);
  });

  it('keeps file access bound to session.workspace when cwd changes and rejects root overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-workspace-root-'));
    const other = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-cwd-'));
    roots.push(root, other);
    writeFileSync(join(root, 'bound.txt'), 'workspace', 'utf8');
    writeFileSync(join(other, 'bound.txt'), 'cwd', 'utf8');
    const session = {
      id: 'session-id',
      transport: 'local' as const,
      cwd: root,
      workspace: { backend: 'local' as const, root },
    };
    const service = new AgentFileService(
      {} as TerminalService,
      createSessionManager(() => session),
    );
    const owner = { id: 1 } as WebContents;

    expect(await service.bindWorkspaceRoot(owner, 'terminal')).toBe(root);
    session.cwd = other;
    await expect(service.readText(owner, 'terminal', 'bound.txt')).resolves.toMatchObject({
      content: 'workspace',
    });
    await expect(service.readText(owner, 'terminal', 'bound.txt', other))
      .rejects.toThrow(/Workspace Root.*不一致/);
  });

  it('rejects traversal, ambiguous patches, and oversized content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-files-'));
    roots.push(root);
    writeFileSync(join(root, 'repeat.txt'), 'same\nsame\n', 'utf8');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;
    const initial = await service.readText(owner, 'terminal', 'repeat.txt');

    await expect(service.readText(owner, 'terminal', '../outside.txt'))
      .rejects.toThrow('超出当前会话工作目录');
    await expect(service.applyPatch(owner, 'terminal', 'repeat.txt', initial.sha256, [{
      search: 'same',
      replace: 'changed',
    }])).rejects.toThrow('不唯一');
    await expect(service.writeText(
      owner,
      'terminal',
      'large.txt',
      'x'.repeat(AGENT_FILE_LIMITS.maxBytes + 1),
      null,
    )).rejects.toThrow('超过');
  });

  it.runIf(process.platform === 'win32')(
    'rejects Windows alternate streams and reserved device names',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-windows-paths-'));
      roots.push(root);
      const service = createService(root);
      const owner = { id: 1 } as WebContents;

      await expect(service.writeText(owner, 'terminal', 'visible.txt:hidden', 'x', null))
        .rejects.toThrow('备用数据流');
      await expect(service.writeText(owner, 'terminal', 'CON.txt', 'x', null))
        .rejects.toThrow('Windows 保留名称');
    },
  );

  it.runIf(process.platform === 'win32')(
    'records a policy-rejected Windows device path only as an opaque hash',
    () => {
      const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-device-audit-'));
      roots.push(container);
      const root = join(container, 'workspace-root');
      mkdirSync(root);
      const { service, journal } = createJournaledService(container, root);

      service.recordPolicyRejection(
        { id: 1 } as WebContents,
        'terminal',
        'read',
        { path: 'CON.txt' },
        root,
        { readablePaths: [root], writablePaths: [root], fullAccess: false },
      );

      expect(journal.read(TEST_SESSION_ID)[0]).toMatchObject({
        recordType: 'intent',
        source: 'policy_workspace_tool',
        target: {
          path: {
            scope: 'rejected',
            pathHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
        },
      });
      expect(JSON.stringify(journal.read(TEST_SESSION_ID))).not.toContain('CON.txt');
    },
  );

  it('does not follow a linked directory outside the formal Session cwd', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-boundary-'));
    roots.push(container);
    const root = join(container, 'workspace');
    const outside = join(container, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf8');
    symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    await expect(service.statPath(owner, 'terminal', 'linked')).resolves.toMatchObject({
      type: 'symlink',
      path: join(root, 'linked'),
    });
    await expect(service.readText(owner, 'terminal', 'linked/secret.txt'))
      .rejects.toThrow('超出当前会话工作目录');
    await expect(service.writeText(owner, 'terminal', 'linked/new.txt', 'unsafe', null))
      .rejects.toThrow('符号链接');
  });

  it('fails closed if the bound workspace root is later replaced by a link', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-root-swap-'));
    roots.push(container);
    const root = join(container, 'workspace');
    const movedRoot = join(container, 'workspace-old');
    const outside = join(container, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf8');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;
    const boundRoot = await service.bindWorkspaceRoot(owner, 'terminal');

    renameSync(root, movedRoot);
    symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(service.readText(owner, 'terminal', 'secret.txt', boundRoot))
      .rejects.toThrow('根目录已被替换或重定向');
  });

  it('lists only the current workspace directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-files-'));
    roots.push(root);
    writeFileSync(join(root, 'one.txt'), '1', 'utf8');
    writeFileSync(join(root, 'two.txt'), '22', 'utf8');
    const result = await createService(root).list({ id: 1 } as WebContents, 'terminal');
    expect(result.path).toBe(root);
    expect(result.entries.map((entry) => entry.name).sort()).toEqual(['one.txt', 'two.txt']);
    expect(result.truncated).toBe(false);
  });

  it('routes local bind, read, list, and stat through the injected backend', async () => {
    const root = resolve('virtual-local-workspace');
    const file = resolve(root, 'demo.ts');
    const localFilesystem = fakeRemoteFilesystem({
      realpath: vi.fn(async (path: string) => path),
      stat: vi.fn(async (path: string) => (
        path === root ? remoteStat('directory') : remoteStat('file', 5)
      )),
      lstat: vi.fn(async (path: string) => (
        path === root ? remoteStat('directory') : remoteStat('file', 5)
      )),
      readFile: vi.fn(async () => Buffer.from('hello')),
      listDirectory: vi.fn(async () => [{
        name: 'demo.ts', path: file, stat: remoteStat('file', 5),
      }]),
    });
    const sessions = createSessionManager(() => ({
        id: TEST_SESSION_ID,
        transport: 'local',
        workspace: { backend: 'local', root },
      }));
    const service = new AgentFileService(
      {} as TerminalService,
      sessions,
      {} as RemoteFilesystemProvider,
      localFilesystem,
    );
    const owner = { id: 1 } as WebContents;

    await expect(service.bindWorkspaceRoot(owner, 'terminal')).resolves.toBe(root);
    await expect(service.readText(owner, 'terminal', 'demo.ts')).resolves.toMatchObject({
      path: file, content: 'hello', bytes: 5,
    });
    await expect(service.list(owner, 'terminal')).resolves.toMatchObject({
      path: root,
      entries: [{ name: 'demo.ts', type: 'file', size: 5 }],
    });
    await expect(service.statPath(owner, 'terminal', 'demo.ts')).resolves.toEqual({
      path: file,
      ...remoteStat('file', 5),
    });
    expect(localFilesystem.readFile).toHaveBeenCalledWith(file, AGENT_FILE_LIMITS.maxBytes);
    expect(localFilesystem.listDirectory).toHaveBeenCalledWith(root);
    expect(localFilesystem.lstat).toHaveBeenCalledWith(file);
  });

  it('uses one RemoteFilesystem abstraction with the expected Host and atomic overwrite', async () => {
    const current = Buffer.from('old\n');
    const standardRename = vi.fn(async () => undefined);
    const atomicRename = vi.fn(async () => undefined);
    const hardlink = vi.fn(async () => undefined);
    const unlink = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work'
          ? remoteStat('directory')
          : path.endsWith('/new.ts')
            ? undefined
            : remoteStat('file', current.length)
      )),
      readFile: vi.fn(async () => current),
      rename: standardRename,
      atomicReplace: atomicRename,
      hardlink,
      unlink,
    });
    const { service, withFilesystem, openSftp } = createSshService(filesystem);
    const owner = { id: 1 } as WebContents;

    await expect(service.writeText(owner, 'terminal', 'new.ts', 'new\n', null, '/work'))
      .resolves.toMatchObject({ created: true, path: '/work/new.ts' });
    expect(withFilesystem).toHaveBeenNthCalledWith(
      1,
      owner,
      'terminal',
      expect.any(Function),
      'host-1',
    );
    expect(hardlink).toHaveBeenCalledWith(
      expect.stringMatching(/^\/work\/\.ai-terminal-/u),
      '/work/new.ts',
    );
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/work\/\.ai-terminal-/u));
    expect(standardRename).not.toHaveBeenCalled();
    expect(atomicRename).not.toHaveBeenCalled();

    await expect(service.writeText(
      owner,
      'terminal',
      'existing.ts',
      'changed\n',
      createHash('sha256').update(current).digest('hex'),
      '/work',
    )).resolves.toMatchObject({ created: false, path: '/work/existing.ts' });
    expect(withFilesystem).toHaveBeenNthCalledWith(
      2,
      owner,
      'terminal',
      expect.any(Function),
      'host-1',
    );
    expect(atomicRename).toHaveBeenCalledTimes(1);
    expect(openSftp).not.toHaveBeenCalled();
  });

  it('fails a strict remote create closed when no hardlink publish is advertised', async () => {
    const writeFileDurable = vi.fn(async () => ({ fsynced: false }));
    const filesystem = fakeRemoteFilesystem({
      serverCapabilities: () => ({
        detection: 'advertised',
        hardlink: false,
        fsync: false,
        posixRename: true,
        detectedAt: '2026-08-21T00:00:00.000Z',
      }),
      lstat: vi.fn(async (path: string) => (
        path === '/work' ? remoteStat('directory') : undefined
      )),
      writeFileDurable,
    });
    const { service, sessions } = createSshService(filesystem);

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'new.txt',
      'new',
      null,
    )).rejects.toThrow('hardlink@openssh.com');

    expect(writeFileDurable).not.toHaveBeenCalled();
    const intent = vi.mocked(sessions.beginWorkspaceOperation).mock.calls[0]![1];
    expect(intent).toMatchObject({
      publication: {
        policy: 'strict',
        publishMode: 'rejected',
        serverCapabilities: {
          detection: 'advertised', hardlink: false, fsync: false, posixRename: true,
        },
        concurrencyGuarantee: 'strict CAS unsupported',
        durability: 'close-only',
      },
    });
    expect(vi.mocked(sessions.finishWorkspaceOperation).mock.calls[0]![1]).toEqual({
      outcome: 'failed',
      sideEffectCommitted: false,
      failure: { code: 'atomicity_unsupported', stage: 'prepare', retrySafe: true },
    });
  });

  it('uses an exclusive direct write for compatible create and exposes its partial-file risk', async () => {
    const writeFileDurable = vi.fn(async () => ({ fsynced: false }));
    const filesystem = fakeRemoteFilesystem({
      serverCapabilities: () => ({
        detection: 'advertised',
        hardlink: false,
        fsync: false,
        posixRename: false,
        detectedAt: '2026-08-21T00:00:00.000Z',
      }),
      lstat: vi.fn(async (path: string) => (
        path === '/work' ? remoteStat('directory') : undefined
      )),
      writeFileDurable,
    });
    const { service } = createSshService(filesystem, 'compatible');

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'new.txt',
      'new',
      null,
    )).resolves.toMatchObject({
      created: true,
      publication: {
        policy: 'compatible',
        publishMode: 'direct-exclusive',
        concurrencyGuarantee: 'exclusive no-overwrite; interrupted write may leave a partial file',
        durability: 'close-only',
      },
    });
    expect(writeFileDurable).toHaveBeenCalledWith('/work/new.txt', Buffer.from('new'), undefined, true);
  });

  it('records a failed compatible direct create as possibly partial', async () => {
    const interrupted = Object.assign(new Error('connection lost during write'), {
      code: 'ECONNRESET',
    });
    const filesystem = fakeRemoteFilesystem({
      serverCapabilities: () => ({
        detection: 'advertised',
        hardlink: false,
        fsync: false,
        posixRename: false,
        detectedAt: '2026-08-21T00:00:00.000Z',
      }),
      lstat: vi.fn(async (path: string) => (
        path === '/work' ? remoteStat('directory') : undefined
      )),
      writeFileDurable: vi.fn(async () => { throw interrupted; }),
    });
    const { service, sessions } = createSshService(filesystem, 'compatible');

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'new.txt',
      'new',
      null,
    )).rejects.toBe(interrupted);
    expect(vi.mocked(sessions.finishWorkspaceOperation).mock.calls[0]![1]).toEqual({
      outcome: 'failed',
      sideEffectCommitted: null,
      failure: { code: 'remote_disconnected', stage: 'commit', retrySafe: false },
    });
  });

  it('fails a strict overwrite closed without posix rename and uses standard rename only in compatible mode', async () => {
    const current = Buffer.from('old\n');
    const rename = vi.fn(async () => undefined);
    const writeFileDurable = vi.fn(async () => ({ fsynced: false }));
    const filesystem = fakeRemoteFilesystem({
      serverCapabilities: () => ({
        detection: 'advertised',
        hardlink: true,
        fsync: false,
        posixRename: false,
        detectedAt: '2026-08-21T00:00:00.000Z',
      }),
      lstat: vi.fn(async (path: string) => (
        path === '/work' ? remoteStat('directory') : remoteStat('file', current.length)
      )),
      readFile: vi.fn(async () => current),
      writeFileDurable,
      rename,
    });
    const expected = createHash('sha256').update(current).digest('hex');
    const strict = createSshService(filesystem);

    await expect(strict.service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'existing.txt',
      'new\n',
      expected,
    )).rejects.toThrow('posix-rename@openssh.com');
    expect(writeFileDurable).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();

    const compatible = createSshService(filesystem, 'compatible');
    await expect(compatible.service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'existing.txt',
      'new\n',
      expected,
    )).resolves.toMatchObject({
      publication: {
        policy: 'compatible',
        publishMode: 'standard-rename',
        concurrencyGuarantee: 'best-effort hash recheck; atomic replace and strict CAS unsupported',
      },
    });
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/^\/work\/\.ai-terminal-/u),
      '/work/existing.txt',
    );
  });

  it('treats a concurrent hardlink target as a clean create conflict and removes the temp', async () => {
    const conflict = Object.assign(new Error('already exists'), { code: 'EEXIST' });
    const unlink = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work' ? remoteStat('directory') : undefined
      )),
      hardlink: vi.fn(async () => { throw conflict; }),
      unlink,
    });
    const { service, sessions } = createSshService(filesystem);

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'new.txt',
      'new',
      null,
    )).rejects.toBe(conflict);
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/work\/\.ai-terminal-/u));
    expect(vi.mocked(sessions.finishWorkspaceOperation).mock.calls[0]![1]).toEqual({
      outcome: 'failed',
      sideEffectCommitted: false,
      failure: { code: 'conflict', stage: 'dispatch', retrySafe: true },
    });
  });

  it('records a hardlink publish followed by failed temp cleanup as committed', async () => {
    const cleanup = Object.assign(new Error('cleanup disconnected'), { code: 'ECONNRESET' });
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work' || path.includes('/.ai-terminal-')
          ? remoteStat(path === '/work' ? 'directory' : 'file', 3)
          : undefined
      )),
      unlink: vi.fn(async () => { throw cleanup; }),
    });
    const { service, sessions } = createSshService(filesystem);

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'new.txt',
      'new',
      null,
    )).rejects.toBe(cleanup);
    expect(vi.mocked(sessions.finishWorkspaceOperation).mock.calls[0]![1]).toEqual({
      outcome: 'failed',
      sideEffectCommitted: true,
      failure: { code: 'remote_disconnected', stage: 'cleanup', retrySafe: false },
    });
  });

  it('revalidates the final remote path and rejects a symlink swapped in before publish', async () => {
    let targetChecks = 0;
    const hardlink = vi.fn(async () => undefined);
    const unlink = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => {
        if (path === '/work') return remoteStat('directory');
        if (path === '/work/new.txt') {
          targetChecks += 1;
          return targetChecks === 1 ? undefined : remoteStat('symlink');
        }
        if (path.includes('/.ai-terminal-')) return remoteStat('file', 3);
        return undefined;
      }),
      hardlink,
      unlink,
    });
    const { service } = createSshService(filesystem);

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'new.txt',
      'new',
      null,
    )).rejects.toThrow('写入期间创建');
    expect(hardlink).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/work\/\.ai-terminal-/u));
  });

  it('rejects a remote final-component symlink before reading or replacing it', async () => {
    const readFile = vi.fn();
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work' ? remoteStat('directory') : remoteStat('symlink')
      )),
      readFile,
    });
    const { service } = createSshService(filesystem);

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'linked.ts',
      'unsafe',
      'a'.repeat(64),
      '/work',
    )).rejects.toThrow('符号链接');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('returns remote stat metadata through the Host-bound filesystem', async () => {
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work' ? remoteStat('directory') : remoteStat('file', 42)
      )),
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const owner = { id: 1 } as WebContents;

    await expect(service.statPath(owner, 'terminal', 'demo.ts')).resolves.toEqual({
      path: '/work/demo.ts',
      ...remoteStat('file', 42),
    });
    expect(withFilesystem).toHaveBeenCalledWith(
      owner,
      'terminal',
      expect.any(Function),
      'host-1',
    );
  });

  it('treats a leading backslash as a legal SSH filename, not a Windows absolute path', async () => {
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work' ? remoteStat('directory') : remoteStat('file', 7)
      )),
    });
    const { service } = createSshService(filesystem);

    await expect(service.statPath(
      { id: 1 } as WebContents,
      'terminal',
      '\\lead.txt',
    )).resolves.toMatchObject({ path: '/work/\\lead.txt', type: 'file' });
  });

  it('still detects an SSH rename into a child whose filename begins with backslash', async () => {
    const rename = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => {
        if (path === '/work' || path === '/work/source') return remoteStat('directory');
        return undefined;
      }),
      rename,
    });
    const { service } = createSshService(filesystem);

    await expect(service.renamePath(
      { id: 1 } as WebContents,
      'terminal',
      'source',
      'source/\\lead',
    )).rejects.toThrow('自身内部');
    expect(rename).not.toHaveBeenCalled();
  });

  it('searches and globs local UTF-8 files deterministically without following symlinks', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-search-'));
    roots.push(container);
    const root = join(container, 'workspace');
    const outside = join(container, 'outside');
    mkdirSync(join(root, 'src', 'nested'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'src', 'a.ts'), 'const engine = "TensorRT";\nTensorRT();\n', 'utf8');
    writeFileSync(join(root, 'src', 'nested', 'b.ts'), 'const literal = "a+b";\n', 'utf8');
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(outside, 'outside.ts'), 'TensorRT outside', 'utf8');
    symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    const search = await service.search(owner, 'terminal', 'TensorRT');
    expect(search).toMatchObject({ query: 'TensorRT', filesScanned: 3, truncated: false });
    expect(search.matches.map((match) => [match.path, match.line, match.column])).toEqual([
      [join(root, 'src', 'a.ts'), 1, 17],
      [join(root, 'src', 'a.ts'), 2, 1],
    ]);
    expect(search.matches.every((match) => !match.path.includes('linked'))).toBe(true);

    const glob = await service.glob(owner, 'terminal', '**/*.ts');
    expect(glob).toEqual({
      pattern: '**/*.ts',
      paths: [join(root, 'src', 'a.ts'), join(root, 'src', 'nested', 'b.ts')],
      truncated: false,
    });
    await expect(service.search(owner, 'terminal', 'a+b', { path: 'src' }))
      .resolves.toMatchObject({ matches: [{ path: join(root, 'src', 'nested', 'b.ts') }] });
  });

  it('reports result and oversized-file bounds as truncated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-search-bounds-'));
    roots.push(root);
    writeFileSync(join(root, 'a.txt'), 'needle needle\n', 'utf8');
    writeFileSync(join(root, 'oversized.txt'), 'x'.repeat(AGENT_FILE_LIMITS.maxBytes + 1), 'utf8');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    await expect(service.search(owner, 'terminal', 'needle', { maxResults: 1 }))
      .resolves.toMatchObject({
        matches: [{ path: join(root, 'a.txt') }],
        truncated: true,
      });
    await expect(service.search(owner, 'terminal', 'not-present'))
      .resolves.toMatchObject({ matches: [], truncated: true });
    await expect(service.glob(owner, 'terminal', '**', { maxResults: 1 }))
      .resolves.toMatchObject({ paths: [join(root, 'a.txt')], truncated: true });
  });

  it('supports safe local mkdir, rename, and bounded recursive deletion', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-mutations-'));
    roots.push(container);
    const root = join(container, 'workspace');
    const outside = join(container, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep', 'utf8');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    await service.mkdirPath(owner, 'terminal', 'created');
    expect(statSync(join(root, 'created')).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(join(root, 'created')).mode & 0o777).toBe(0o700);
    }
    writeFileSync(join(root, 'created', 'from.txt'), 'value', 'utf8');
    await service.renamePath(owner, 'terminal', 'created/from.txt', 'created/to.txt');
    expect(existsSync(join(root, 'created', 'to.txt'))).toBe(true);

    mkdirSync(join(root, 'created', 'nested'));
    writeFileSync(join(root, 'created', 'nested', 'child.txt'), 'child', 'utf8');
    symlinkSync(outside, join(root, 'created', 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await service.deletePath(owner, 'terminal', 'created', { recursive: true });
    expect(existsSync(join(root, 'created'))).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    await expect(service.deletePath(owner, 'terminal', '.', { recursive: true }))
      .rejects.toThrow('Workspace Root');
  });

  it('rejects mutation through a linked parent and leaves the target untouched', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-mutation-link-'));
    roots.push(container);
    const root = join(container, 'workspace');
    const real = join(root, 'real');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'keep.txt'), 'keep', 'utf8');
    symlinkSync(real, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    await expect(service.mkdirPath(owner, 'terminal', 'linked/new'))
      .rejects.toThrow('符号链接');
    await expect(service.deletePath(owner, 'terminal', 'linked/keep.txt'))
      .rejects.toThrow('符号链接');
    const expected = createHash('sha256').update('keep').digest('hex');
    await expect(service.writeText(owner, 'terminal', 'linked/keep.txt', 'changed', expected))
      .rejects.toThrow('符号链接');
    await expect(service.writeText(owner, 'terminal', 'linked/new.txt', 'new', null))
      .rejects.toThrow('符号链接');
    expect(readFileSync(join(real, 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(real, 'new.txt'))).toBe(false);
  });

  it('keeps remote search and glob on one Host-bound filesystem lease per call', async () => {
    const stats = new Map<string, RemoteFileStat>([
      ['/work', remoteStat('directory')],
      ['/work/src', remoteStat('directory')],
      ['/work/src/a.ts', remoteStat('file', 13)],
      ['/work/src/b.txt', remoteStat('file', 4)],
      ['/work/linked', remoteStat('symlink')],
      ['/work/dir\\name.ts', remoteStat('file', 6)],
    ]);
    const contents = new Map<string, Buffer>([
      ['/work/src/a.ts', Buffer.from('needle\nneedle')],
      ['/work/src/b.txt', Buffer.from([0, 1, 2, 3])],
      ['/work/dir\\name.ts', Buffer.from('remote')],
    ]);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => stats.get(path)),
      stat: vi.fn(async (path: string) => stats.get(path)),
      readFile: vi.fn(async (path: string) => contents.get(path) ?? Buffer.alloc(0)),
      listDirectory: vi.fn(async (path: string) => {
        const prefix = `${path}/`;
        return [...stats.entries()]
          .filter(([candidate]) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
          .map(([candidate, stat]) => ({
            name: candidate.slice(prefix.length), path: candidate, stat,
          }));
      }),
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const owner = { id: 1 } as WebContents;

    await expect(service.search(owner, 'terminal', 'needle', { maxResults: 5 }))
      .resolves.toMatchObject({
        matches: [
          { path: '/work/src/a.ts', line: 1 },
          { path: '/work/src/a.ts', line: 2 },
        ],
        truncated: false,
      });
    expect(withFilesystem).toHaveBeenCalledTimes(1);
    await expect(service.glob(owner, 'terminal', '**/*.ts'))
      .resolves.toMatchObject({ paths: ['/work/dir\\name.ts', '/work/src/a.ts'] });
    expect(withFilesystem).toHaveBeenCalledTimes(2);
    await expect(service.glob(owner, 'terminal', 'dir\\*.ts'))
      .resolves.toMatchObject({ paths: ['/work/dir\\name.ts'] });
    expect(withFilesystem).toHaveBeenCalledTimes(3);
  });

  it('applies a remote patch in one lease, publishes exclusively, and returns a relative diff', async () => {
    const current = Buffer.from('const value = 1;\n');
    const writeFileDurable = vi.fn(async () => ({ fsynced: true }));
    const atomicReplace = vi.fn(async () => undefined);
    const unlink = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work' || path === '/work/src'
          ? remoteStat('directory')
          : remoteStat('file', current.length)
      )),
      stat: vi.fn(async () => remoteStat('file', current.length)),
      readFile: vi.fn(async () => current),
      writeFileDurable,
      atomicReplace,
      unlink,
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const expected = createHash('sha256').update(current).digest('hex');
    const result = await service.applyPatch(
      { id: 1 } as WebContents,
      'terminal',
      'src/demo.ts',
      expected,
      [{ search: 'value = 1', replace: 'value = 2' }],
    );

    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ additions: 1, deletions: 1, diffTruncated: false });
    expect(result.diff).toContain('--- a/workspace/src/demo.ts');
    expect(result.diff).not.toContain('/work/');
    expect(writeFileDurable).toHaveBeenCalledWith(
      expect.stringMatching(/^\/work\/src\/\.ai-terminal-/u),
      Buffer.from('const value = 2;\n'),
      0o644,
      true,
    );
    expect(atomicReplace).toHaveBeenCalledTimes(1);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('detects a remote write race on the second hash check and cleans its temp file', async () => {
    const original = Buffer.from('old\n');
    const changed = Buffer.from('raced\n');
    const readFile = vi.fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(changed);
    const unlink = vi.fn(async () => undefined);
    const atomicReplace = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work' ? remoteStat('directory') : remoteStat('file', original.length)
      )),
      stat: vi.fn(async () => remoteStat('file', original.length)),
      readFile,
      unlink,
      atomicReplace,
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const expected = createHash('sha256').update(original).digest('hex');

    await expect(service.applyPatch(
      { id: 1 } as WebContents,
      'terminal',
      'demo.ts',
      expected,
      [{ search: 'old', replace: 'new' }],
    )).rejects.toThrow('文件已变化');
    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(atomicReplace).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('.ai-terminal-'));
  });

  it('records a rejected remote final publish as ambiguous and non-retryable', async () => {
    const current = Buffer.from('old\n');
    const disconnect = Object.assign(
      new Error('CANARY-raw-sftp-error host.example'),
      { code: 'ECONNRESET' },
    );
    const atomicReplace = vi.fn(async () => {
      throw disconnect;
    });
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work' ? remoteStat('directory') : remoteStat('file', current.length)
      )),
      readFile: vi.fn(async () => current),
      atomicReplace,
    });
    const { service, sessions, withFilesystem } = createSshService(filesystem);
    const expected = createHash('sha256').update(current).digest('hex');

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'existing.txt',
      'new\n',
      expected,
    )).rejects.toBe(disconnect);

    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(sessions.beginWorkspaceOperation).toHaveBeenCalledTimes(1);
    expect(sessions.finishWorkspaceOperation).toHaveBeenCalledTimes(1);
    const outcome = vi.mocked(sessions.finishWorkspaceOperation).mock.calls[0]![1];
    expect(outcome).toEqual({
      outcome: 'failed',
      sideEffectCommitted: null,
      failure: {
        code: 'remote_disconnected',
        stage: 'commit',
        retrySafe: false,
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('CANARY-raw-sftp-error');
    expect(JSON.stringify(outcome)).not.toContain('host.example');
  });

  it('looks for a partially-created remote temp after write rejection and bounds cleanup failure', async () => {
    const writeError = Object.assign(new Error('remote temp write rejected'), { code: 'EIO' });
    const cleanupError = Object.assign(new Error('remote cleanup disconnected'), {
      code: 'ECONNRESET',
    });
    const writeFileDurable = vi.fn(async () => {
      throw writeError;
    });
    const unlink = vi.fn(async () => {
      throw cleanupError;
    });
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => {
        if (path === '/work') return remoteStat('directory');
        if (path.includes('/.ai-terminal-')) return remoteStat('file', 7);
        return undefined;
      }),
      writeFileDurable,
      unlink,
    });
    const { service, sessions, withFilesystem } = createSshService(filesystem);

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'new.txt',
      'new',
      null,
    )).rejects.toBe(writeError);

    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(writeFileDurable).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('/.ai-terminal-'));
    expect(vi.mocked(sessions.finishWorkspaceOperation).mock.calls[0]![1]).toEqual({
      outcome: 'failed',
      sideEffectCommitted: false,
      failure: { code: 'unknown', stage: 'cleanup', retrySafe: false },
    });
  });

  it('uses one remote lease for each mkdir, rename, and delete mutation', async () => {
    const mkdir = vi.fn(async () => undefined);
    const rename = vi.fn(async () => undefined);
    const unlink = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => {
        if (path === '/work') return remoteStat('directory');
        if (path === '/work/from' || path === '/work/file') return remoteStat('file', 1);
        return undefined;
      }),
      mkdir,
      rename,
      unlink,
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const owner = { id: 1 } as WebContents;

    await service.mkdirPath(owner, 'terminal', 'new');
    await service.renamePath(owner, 'terminal', 'from', 'to');
    await service.deletePath(owner, 'terminal', 'file');

    expect(withFilesystem).toHaveBeenCalledTimes(3);
    expect(mkdir).toHaveBeenCalledWith('/work/new', 0o700);
    expect(rename).toHaveBeenCalledWith('/work/from', '/work/to');
    expect(unlink).toHaveBeenCalledWith('/work/file');
  });

  it('preflights a remote recursive delete fully before mutating and uses one lease', async () => {
    const stats = new Map<string, RemoteFileStat>([
      ['/work', remoteStat('directory')],
      ['/work/tree', remoteStat('directory')],
      ['/work/tree/a.txt', remoteStat('file', 1)],
      ['/work/tree/nested', remoteStat('directory')],
      ['/work/tree/nested/b.txt', remoteStat('file', 1)],
      ['/work/tree/outside-link', remoteStat('symlink')],
    ]);
    const children = (path: string) => {
      const prefix = `${path}/`;
      return [...stats.entries()]
        .filter(([candidate]) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
        .map(([candidate, stat]) => ({ name: candidate.slice(prefix.length), path: candidate, stat }));
    };
    const unlink = vi.fn(async (_path: string) => undefined);
    const rmdir = vi.fn(async (_path: string) => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => stats.get(path)),
      listDirectory: vi.fn(async (path: string) => children(path)),
      unlink,
      rmdir,
    });
    const { service, withFilesystem } = createSshService(filesystem);

    await service.deletePath(
      { id: 1 } as WebContents,
      'terminal',
      'tree',
      { recursive: true },
    );

    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(unlink.mock.calls.map(([path]) => path)).toEqual([
      '/work/tree/a.txt',
      '/work/tree/nested/b.txt',
      '/work/tree/outside-link',
    ]);
    expect(rmdir.mock.calls.map(([path]) => path)).toEqual([
      '/work/tree/nested',
      '/work/tree',
    ]);
  });

  it('records the confirmed lower bound when a remote recursive delete partially commits', async () => {
    const stats = new Map<string, RemoteFileStat>([
      ['/work', remoteStat('directory')],
      ['/work/tree', remoteStat('directory')],
      ['/work/tree/a.txt', remoteStat('file', 1)],
      ['/work/tree/b.txt', remoteStat('file', 1)],
    ]);
    const disconnect = Object.assign(new Error('raw partial failure'), { code: 'ECONNRESET' });
    const unlink = vi.fn(async (path: string) => {
      if (path.endsWith('/b.txt')) throw disconnect;
    });
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => stats.get(path)),
      listDirectory: vi.fn(async (path: string) => {
        if (path !== '/work/tree') return [];
        return [
          { name: 'a.txt', path: '/work/tree/a.txt', stat: remoteStat('file', 1) },
          { name: 'b.txt', path: '/work/tree/b.txt', stat: remoteStat('file', 1) },
        ];
      }),
      unlink,
    });
    const { service, sessions, withFilesystem } = createSshService(filesystem);

    await expect(service.deletePath(
      { id: 1 } as WebContents,
      'terminal',
      'tree',
      { recursive: true },
    )).rejects.toBe(disconnect);

    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(sessions.beginWorkspaceOperation).toHaveBeenCalledTimes(1);
    expect(sessions.finishWorkspaceOperation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sessions.finishWorkspaceOperation).mock.calls[0]![1]).toEqual({
      outcome: 'failed',
      sideEffectCommitted: true,
      effect: { itemsPlanned: 3, itemsCommitted: 1 },
      failure: {
        code: 'remote_disconnected',
        stage: 'commit',
        retrySafe: false,
      },
    });
  });

  it('has zero mutation side effects when recursive delete preflight fails', async () => {
    const unlink = vi.fn(async () => undefined);
    const rmdir = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => {
        if (path === '/work' || path === '/work/tree') return remoteStat('directory');
        if (path === '/work/tree/a.txt') return remoteStat('file', 1);
        return undefined;
      }),
      listDirectory: vi.fn(async () => [
        { name: 'a.txt', path: '/work/tree/a.txt', stat: remoteStat('file', 1) },
        { name: 'bad/name', path: '/outside', stat: remoteStat('file', 1) },
      ]),
      unlink,
      rmdir,
    });
    const { service, withFilesystem } = createSshService(filesystem);

    await expect(service.deletePath(
      { id: 1 } as WebContents,
      'terminal',
      'tree',
      { recursive: true },
    )).rejects.toThrow('不安全的目录条目');
    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
  });

  it('has zero mutation side effects when recursive delete exceeds its depth budget', async () => {
    const stats = new Map<string, RemoteFileStat>([
      ['/work', remoteStat('directory')],
      ['/work/tree', remoteStat('directory')],
    ]);
    let parent = '/work/tree';
    for (let depth = 0; depth <= AGENT_FILE_LIMITS.maxRecursiveDeleteDepth; depth += 1) {
      parent = `${parent}/d${depth}`;
      stats.set(parent, remoteStat('directory'));
    }
    const unlink = vi.fn(async (_path: string) => undefined);
    const rmdir = vi.fn(async (_path: string) => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => stats.get(path)),
      listDirectory: vi.fn(async (path: string) => {
        const prefix = `${path}/`;
        return [...stats.entries()]
          .filter(([candidate]) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
          .map(([candidate, attributes]) => ({
            name: candidate.slice(prefix.length), path: candidate, stat: attributes,
          }));
      }),
      unlink,
      rmdir,
    });
    const { service, withFilesystem } = createSshService(filesystem);

    await expect(service.deletePath(
      { id: 1 } as WebContents,
      'terminal',
      'tree',
      { recursive: true },
    )).rejects.toThrow('层限制');
    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
  });

  it('does not mutate when an empty-directory listing exhausts the delete deadline', async () => {
    let clock = 0;
    const unlink = vi.fn(async (_path: string) => undefined);
    const rmdir = vi.fn(async (_path: string) => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work' || path === '/work/empty' ? remoteStat('directory') : undefined
      )),
      listDirectory: vi.fn(async () => {
        clock = AGENT_FILE_LIMITS.maxRecursiveDeleteDurationMs;
        return [];
      }),
      unlink,
      rmdir,
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      await expect(service.deletePath(
        { id: 1 } as WebContents,
        'terminal',
        'empty',
        { recursive: true },
      )).rejects.toThrow('预检超时');
    } finally {
      dateNow.mockRestore();
    }
    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
  });

  it('detects a local write race on the second bounded hash check and removes its temp file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-local-race-'));
    roots.push(root);
    const path = join(root, 'demo.txt');
    writeFileSync(path, 'old\n', 'utf8');
    const backend = new LocalFilesystemBackend();
    vi.spyOn(backend, 'readFile')
      .mockResolvedValueOnce(Buffer.from('old\n'))
      .mockResolvedValueOnce(Buffer.from('raced\n'));
    const sessions = createSessionManager(() => ({
        id: TEST_SESSION_ID,
        transport: 'local',
        workspace: { backend: 'local', root },
      }));
    const service = new AgentFileService(
      {} as TerminalService,
      sessions,
      {} as RemoteFilesystemProvider,
      backend,
    );
    const expected = createHash('sha256').update('old\n').digest('hex');

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'demo.txt',
      'new\n',
      expected,
    )).rejects.toThrow('文件已变化');
    expect(readFileSync(path, 'utf8')).toBe('old\n');
    expect(readdirSync(root)).toEqual(['demo.txt']);
  });

  it('does not publish a deferred local write after its authorization is revoked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-local-revoke-'));
    roots.push(root);
    const path = join(root, 'demo.txt');
    writeFileSync(path, 'old\n', 'utf8');
    const { service } = createServiceHarness(root);
    const hooks = service as unknown as {
      writeLocalTemporary(path: string, bytes: Buffer, mode: number): Promise<void>;
    };
    const writeLocalTemporary = hooks.writeLocalTemporary.bind(service);
    let releaseTemporary!: () => void;
    let markTemporaryReady!: () => void;
    const temporaryRelease = new Promise<void>((resolve) => { releaseTemporary = resolve; });
    const temporaryReady = new Promise<void>((resolve) => { markTemporaryReady = resolve; });
    vi.spyOn(hooks, 'writeLocalTemporary').mockImplementation(async (...args) => {
      await writeLocalTemporary(...args);
      markTemporaryReady();
      await temporaryRelease;
    });
    let live = true;
    const authorization = {
      readablePaths: [root],
      writablePaths: [root],
      fullAccess: false,
      assertLive: () => {
        if (!live) throw new Error('Workspace tool grant is no longer active.');
      },
    };
    const expected = createHash('sha256').update('old\n').digest('hex');

    const pending = service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'demo.txt',
      'new\n',
      expected,
      root,
      authorization,
    );
    await temporaryReady;
    live = false;
    releaseTemporary();

    await expect(pending).rejects.toThrow('no longer active');
    expect(readFileSync(path, 'utf8')).toBe('old\n');
    expect(readdirSync(root)).toEqual(['demo.txt']);
  });

  it('allows an explicitly canonicalized local scope outside Workspace Root and rejects its sibling', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-local-scope-'));
    roots.push(container);
    const workspace = join(container, 'workspace');
    const granted = join(container, 'granted');
    const sibling = join(container, 'sibling');
    mkdirSync(workspace);
    mkdirSync(granted);
    mkdirSync(sibling);
    writeFileSync(join(granted, 'allowed.txt'), 'allowed', 'utf8');
    writeFileSync(join(sibling, 'denied.txt'), 'denied', 'utf8');
    const service = createService(workspace);
    const owner = { id: 1 } as WebContents;

    await expect(service.readText(owner, 'terminal', join(granted, 'allowed.txt')))
      .rejects.toThrow('已授权范围');
    const canonical = await service.canonicalizeAccessRoot(owner, 'terminal', granted);
    const authorization = {
      readablePaths: [canonical],
      writablePaths: [canonical],
      fullAccess: false,
    };
    await expect(service.readText(
      owner,
      'terminal',
      join(granted, 'allowed.txt'),
      workspace,
      authorization,
    )).resolves.toMatchObject({ content: 'allowed', path: join(granted, 'allowed.txt') });
    const outsideWrite = await service.writeText(
      owner,
      'terminal',
      join(granted, 'created.txt'),
      'created',
      null,
      workspace,
      authorization,
    );
    expect(outsideWrite.diff).toMatch(
      /^\+\+\+ b\/authorized\/[0-9a-f]{16}\/created\.txt$/mu,
    );
    expect(outsideWrite.diff).not.toContain('../');
    expect(outsideWrite.diff.split('\n').slice(0, 2).join('\n')).not.toContain('\\');
    await expect(service.readText(
      owner,
      'terminal',
      join(sibling, 'denied.txt'),
      workspace,
      authorization,
    )).rejects.toThrow('已授权范围');
  });

  it('enforces readable, writable, and overwrite-intersection scopes independently', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-capability-scope-'));
    roots.push(container);
    const workspace = join(container, 'workspace');
    const readable = join(container, 'readable');
    const writable = join(container, 'writable');
    const shared = join(container, 'shared');
    for (const directory of [workspace, readable, writable, shared]) mkdirSync(directory);
    writeFileSync(join(readable, 'read.txt'), 'read', 'utf8');
    writeFileSync(join(writable, 'existing.txt'), 'old', 'utf8');
    writeFileSync(join(shared, 'shared.txt'), 'old', 'utf8');
    const service = createService(workspace);
    const owner = { id: 1 } as WebContents;
    const authorization = {
      readablePaths: [readable, shared],
      writablePaths: [writable, shared],
      fullAccess: false,
    };

    await expect(service.readText(
      owner, 'terminal', join(readable, 'read.txt'), workspace, authorization,
    )).resolves.toMatchObject({ content: 'read' });
    await expect(service.readText(
      owner, 'terminal', join(writable, 'existing.txt'), workspace, authorization,
    )).rejects.toThrow('已授权范围');

    await service.writeText(
      owner, 'terminal', join(writable, 'created.txt'), 'new', null, workspace, authorization,
    );
    expect(readFileSync(join(writable, 'created.txt'), 'utf8')).toBe('new');
    const writableHash = createHash('sha256').update('old').digest('hex');
    await expect(service.writeText(
      owner,
      'terminal',
      join(writable, 'existing.txt'),
      'changed',
      writableHash,
      workspace,
      authorization,
    )).rejects.toThrow('读写交集');
    expect(readFileSync(join(writable, 'existing.txt'), 'utf8')).toBe('old');

    const sharedHash = createHash('sha256').update('old').digest('hex');
    await service.applyPatch(
      owner,
      'terminal',
      join(shared, 'shared.txt'),
      sharedHash,
      [{ search: 'old', replace: 'patched' }],
      workspace,
      authorization,
    );
    expect(readFileSync(join(shared, 'shared.txt'), 'utf8')).toBe('patched');
    await service.mkdirPath(
      owner, 'terminal', join(writable, 'created-dir'), workspace, authorization,
    );
    await service.deletePath(
      owner, 'terminal', join(writable, 'created.txt'), {}, workspace, authorization,
    );
    expect(existsSync(join(writable, 'created.txt'))).toBe(false);
  });

  it('does not read a destination that races a create-only grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-create-only-race-'));
    roots.push(root);
    const target = join(root, 'raced.txt');
    writeFileSync(target, 'secret', 'utf8');
    const backend = new LocalFilesystemBackend();
    const originalLstat = backend.lstat.bind(backend);
    vi.spyOn(backend, 'lstat').mockImplementation(async (path: string) => (
      path === target ? undefined : originalLstat(path)
    ));
    const readFile = vi.spyOn(backend, 'readFile');
    const service = new AgentFileService(
      {} as TerminalService,
      createSessionManager(() => ({
          id: TEST_SESSION_ID,
          transport: 'local',
          workspace: { backend: 'local', root },
        })),
      {} as RemoteFilesystemProvider,
      backend,
    );

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      target,
      'replacement',
      null,
      root,
      { readablePaths: [], writablePaths: [root], fullAccess: false },
    )).rejects.toBeDefined();
    expect(readFile).not.toHaveBeenCalled();
    expect(readFileSync(target, 'utf8')).toBe('secret');
    expect(readdirSync(root)).toEqual(['raced.txt']);
  });

  it('supports Full Access outside Workspace Root but protects Workspace ancestors', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-full-access-'));
    roots.push(container);
    const workspace = join(container, 'workspace');
    const outside = join(container, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(join(outside, 'outside.txt'), 'outside', 'utf8');
    const service = createService(workspace);
    const owner = { id: 1 } as WebContents;
    const fullAccess = { readablePaths: [], writablePaths: [], fullAccess: true };

    await expect(service.readText(
      owner, 'terminal', join(outside, 'outside.txt'), workspace, fullAccess,
    )).resolves.toMatchObject({ content: 'outside' });
    const outsideWrite = await service.writeText(
      owner, 'terminal', join(outside, 'created.txt'), 'created', null, workspace, fullAccess,
    );
    expect(readFileSync(join(outside, 'created.txt'), 'utf8')).toBe('created');
    expect(outsideWrite.diff).toMatch(/^\+\+\+ b\/filesystem\/[0-9a-f]{16}\//mu);
    expect(outsideWrite.diff).not.toContain('../');
    expect(outsideWrite.diff).not.toMatch(/^--- a\/[A-Za-z]:/mu);
    expect(outsideWrite.diff).not.toMatch(/^--- a\/\\\\/mu);
    await expect(service.deletePath(
      owner, 'terminal', workspace, { recursive: true }, workspace, fullAccess,
    )).rejects.toThrow('Workspace Root');
    await expect(service.deletePath(
      owner, 'terminal', container, { recursive: true }, workspace, fullAccess,
    )).rejects.toThrow('Workspace Root');
    expect(existsSync(workspace)).toBe(true);
  });

  it('durably audits a rejected Workspace Root mutation', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-root-mutation-audit-'));
    roots.push(container);
    const workspace = join(container, 'workspace-root');
    mkdirSync(workspace);
    const auditRoot = join(container, 'sessions');
    const store = new SessionStore(auditRoot);
    const session = store.create({
      descriptor: {
        id: 'terminal',
        title: 'Local',
        profileId: 'powershell',
        shellKind: 'powershell',
        transport: 'local',
      },
      startedAt: new Date().toISOString(),
      history: [],
      preludeTruncated: false,
      droppedPreludeBytes: 0,
    });
    store.setWorkspace(session.id, { backend: 'local', root: workspace });
    const sessions = {
      sessionForTerminal: () => store.get(session.id),
      beginWorkspaceOperation: store.beginWorkspaceOperation.bind(store),
      finishWorkspaceOperation: store.finishWorkspaceOperation.bind(store),
      workspaceStorageProtection: store.workspaceStorageProtection.bind(store),
    } as unknown as SessionManager;
    const service = new AgentFileService({} as TerminalService, sessions);
    const owner = { id: 1 } as WebContents;
    const fullAccess = { readablePaths: [], writablePaths: [], fullAccess: true };

    await expect(service.deletePath(
      owner,
      'terminal',
      '.',
      { recursive: true },
      workspace,
      fullAccess,
    )).rejects.toThrow('Workspace Root');

    expect(existsSync(workspace)).toBe(true);
    expect(store.readWorkspaceOperations(session.id)).toMatchObject([
      {
        recordType: 'intent',
        operation: 'delete',
        target: {
          path: {
            scope: 'rejected',
            pathHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
        },
      },
      {
        recordType: 'outcome',
        outcome: 'failed',
        sideEffectCommitted: false,
        failure: { stage: 'prepare', retrySafe: true },
      },
    ]);
    const jsonl = readFileSync(
      join(auditRoot, session.id, 'workspace', 'operations.jsonl'),
      'utf8',
    );
    expect(jsonl).not.toContain(workspace);
    expect(jsonl).not.toContain(JSON.stringify(workspace).slice(1, -1));
  });

  it('protects Session and audit storage from every local Full Access mutation', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-protected-session-storage-'));
    roots.push(container);
    const workspace = join(container, 'workspace-root');
    mkdirSync(workspace);
    const { service, journal, auditRoot } = createJournaledService(container, workspace);
    const owner = { id: 1 } as WebContents;
    const fullAccess = { readablePaths: [], writablePaths: [], fullAccess: true };

    // Establish the authoritative journal before testing self-targeting paths.
    await service.list(owner, 'terminal', '.', workspace, fullAccess);
    const sessionPath = join(auditRoot, TEST_SESSION_ID);
    const metadataPath = join(sessionPath, 'session.json');
    const protectedSource = join(sessionPath, 'protected-source.txt');
    const operationLog = join(sessionPath, 'workspace', 'operations.jsonl');
    writeFileSync(metadataPath, 'metadata-sentinel', 'utf8');
    writeFileSync(protectedSource, 'source-sentinel', 'utf8');
    const renameSource = join(workspace, 'rename-source.txt');
    writeFileSync(renameSource, 'workspace-source', 'utf8');
    const protectedNewFile = join(auditRoot, 'another-session', 'new.txt');
    const protectedDiff = join(sessionPath, 'workspace', 'diffs', 'forbidden.patch');
    const protectedNewDirectory = join(auditRoot, 'another-session', 'new-dir');
    const protectedRenameDestination = join(auditRoot, 'another-session', 'renamed.txt');

    await expect(service.writeText(
      owner,
      'terminal',
      protectedNewFile,
      'blocked-write',
      null,
      workspace,
      fullAccess,
    )).rejects.toThrow(/Session.*审计存储/u);
    const logBeforeDiffTarget = readFileSync(operationLog);
    await expect(service.writeText(
      owner,
      'terminal',
      protectedDiff,
      'blocked-diff-write',
      null,
      workspace,
      fullAccess,
    )).rejects.toThrow(/Session.*审计存储/u);
    expect(readFileSync(operationLog)).toEqual(logBeforeDiffTarget);
    await expect(service.applyPatch(
      owner,
      'terminal',
      metadataPath,
      createHash('sha256').update('metadata-sentinel').digest('hex'),
      [{ search: 'metadata', replace: 'changed' }],
      workspace,
      fullAccess,
    )).rejects.toThrow(/Session.*审计存储/u);
    await expect(service.mkdirPath(
      owner,
      'terminal',
      protectedNewDirectory,
      workspace,
      fullAccess,
    )).rejects.toThrow(/Session.*审计存储/u);
    await expect(service.renamePath(
      owner,
      'terminal',
      protectedSource,
      join(workspace, 'renamed-out.txt'),
      workspace,
      fullAccess,
    )).rejects.toThrow(/Session.*审计存储/u);
    await expect(service.renamePath(
      owner,
      'terminal',
      renameSource,
      protectedRenameDestination,
      workspace,
      fullAccess,
    )).rejects.toThrow(/Session.*审计存储/u);
    await expect(service.deletePath(
      owner,
      'terminal',
      metadataPath,
      {},
      workspace,
      fullAccess,
    )).rejects.toThrow(/Session.*审计存储/u);

    expect(existsSync(protectedNewFile)).toBe(false);
    expect(existsSync(protectedDiff)).toBe(false);
    expect(existsSync(protectedNewDirectory)).toBe(false);
    expect(readFileSync(metadataPath, 'utf8')).toBe('metadata-sentinel');
    expect(readFileSync(protectedSource, 'utf8')).toBe('source-sentinel');
    expect(readFileSync(renameSource, 'utf8')).toBe('workspace-source');
    expect(existsSync(join(workspace, 'renamed-out.txt'))).toBe(false);
    expect(existsSync(protectedRenameDestination)).toBe(false);

    const logBeforeSelfTarget = readFileSync(operationLog);
    const logSha256 = createHash('sha256').update(logBeforeSelfTarget).digest('hex');
    await expect(service.writeText(
      owner,
      'terminal',
      operationLog,
      'blocked-self-write',
      logSha256,
      workspace,
      fullAccess,
    )).rejects.toThrow(/Session.*审计存储/u);
    await expect(service.applyPatch(
      owner,
      'terminal',
      operationLog,
      logSha256,
      [{ search: 'never-read', replace: 'never-written' }],
      workspace,
      fullAccess,
    )).rejects.toThrow(/Session.*审计存储/u);
    expect(readFileSync(operationLog)).toEqual(logBeforeSelfTarget);

    const logBeforeAncestor = readFileSync(operationLog);
    await expect(service.deletePath(
      owner,
      'terminal',
      auditRoot,
      { recursive: true },
      workspace,
      fullAccess,
    )).rejects.toThrow(/Session.*审计存储/u);
    expect(readFileSync(operationLog)).toEqual(logBeforeAncestor);
    expect(existsSync(auditRoot)).toBe(true);

    const records = journal.read(TEST_SESSION_ID);
    const intents = records.filter((record) => record.recordType === 'intent');
    const outcomes = records.filter((record) => record.recordType === 'outcome');
    expect(intents.map((record) => record.operation)).toEqual([
      'list',
      'write',
      'patch',
      'mkdir',
      'rename',
      'rename',
      'delete',
    ]);
    expect(outcomes).toHaveLength(7);
    for (const outcome of outcomes.slice(1)) {
      expect(outcome).toMatchObject({
        outcome: 'failed',
        sideEffectCommitted: false,
        failure: { stage: 'prepare', retrySafe: true },
      });
    }
    const jsonl = readFileSync(operationLog, 'utf8');
    expect(jsonl).not.toContain(auditRoot);
    expect(jsonl).not.toContain('session.json');
    expect(jsonl).not.toContain('operations.jsonl');
    expect(jsonl).not.toContain('forbidden.patch');
    const protectedCoordinates = intents.slice(1).flatMap((record) => {
      if (!('source' in record.target)) return [record.target.path];
      return [record.target.source, record.target.destination];
    }).filter((coordinate) => coordinate.scope === 'rejected');
    expect(protectedCoordinates).toHaveLength(6);
  });

  it('protects the physical Session root when its configured path has a linked ancestor', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-canonical-session-root-'));
    roots.push(container);
    const physicalParent = join(container, 'physical-parent');
    const linkedParent = join(container, 'linked-parent');
    const workspace = join(container, 'workspace-root');
    mkdirSync(physicalParent);
    mkdirSync(workspace);
    symlinkSync(
      physicalParent,
      linkedParent,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const lexicalSessionsRoot = join(linkedParent, 'sessions');
    const store = new SessionStore(lexicalSessionsRoot);
    const session = store.create({
      descriptor: {
        id: 'terminal',
        title: 'Local',
        profileId: 'powershell',
        shellKind: 'powershell',
        transport: 'local',
      },
      startedAt: new Date().toISOString(),
      history: [],
      preludeTruncated: false,
      droppedPreludeBytes: 0,
    });
    store.setWorkspace(session.id, { backend: 'local', root: workspace });
    const sessions = {
      sessionForTerminal: () => store.get(session.id),
      beginWorkspaceOperation: store.beginWorkspaceOperation.bind(store),
      finishWorkspaceOperation: store.finishWorkspaceOperation.bind(store),
      workspaceStorageProtection: store.workspaceStorageProtection.bind(store),
    } as unknown as SessionManager;
    const service = new AgentFileService({} as TerminalService, sessions);
    const owner = { id: 1 } as WebContents;
    const fullAccess = { readablePaths: [], writablePaths: [], fullAccess: true };

    await service.list(owner, 'terminal', '.', workspace, fullAccess);
    const protection = store.workspaceStorageProtection(session.id);
    const physicalSessionsRoot = realpathSync(resolve(physicalParent, 'sessions'));
    expect(protection).toEqual({
      root: physicalSessionsRoot,
      operationJournalPath: join(
        physicalSessionsRoot,
        session.id,
        'workspace',
        'operations.jsonl',
      ),
    });
    const protectedTarget = join(
      physicalSessionsRoot,
      session.id,
      'canonical-alias-target.txt',
    );
    writeFileSync(protectedTarget, 'sentinel', 'utf8');

    await expect(service.writeText(
      owner,
      'terminal',
      protectedTarget,
      'changed',
      createHash('sha256').update('sentinel').digest('hex'),
      workspace,
      fullAccess,
    )).rejects.toThrow(/Session.*审计存储/u);

    expect(readFileSync(protectedTarget, 'utf8')).toBe('sentinel');
    expect(store.readWorkspaceOperations(session.id)).toMatchObject([
      { recordType: 'intent', operation: 'list' },
      { recordType: 'outcome', outcome: 'succeeded' },
      {
        recordType: 'intent',
        operation: 'write',
        target: {
          path: {
            scope: 'rejected',
            pathHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
        },
      },
      {
        recordType: 'outcome',
        outcome: 'failed',
        sideEffectCommitted: false,
      },
    ]);
    const jsonl = readFileSync(protection.operationJournalPath, 'utf8');
    expect(jsonl).not.toContain(physicalSessionsRoot);
    expect(jsonl).not.toContain('canonical-alias-target.txt');
    expect(store.recoverWorkspaceOperations(session.id)[1]).toMatchObject({
      sideEffectCommitted: false,
    });
  });

  it('allows rename only when both endpoints are within writable scopes', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-rename-scopes-'));
    roots.push(container);
    const workspace = join(container, 'workspace');
    const left = join(container, 'left');
    const right = join(container, 'right');
    const denied = join(container, 'denied');
    for (const directory of [workspace, left, right, denied]) mkdirSync(directory);
    writeFileSync(join(left, 'source.txt'), 'source', 'utf8');
    const service = createService(workspace);
    const owner = { id: 1 } as WebContents;
    const authorization = {
      readablePaths: [],
      writablePaths: [left, right],
      fullAccess: false,
    };

    await service.renamePath(
      owner,
      'terminal',
      join(left, 'source.txt'),
      join(right, 'destination.txt'),
      workspace,
      authorization,
    );
    expect(readFileSync(join(right, 'destination.txt'), 'utf8')).toBe('source');
    await expect(service.renamePath(
      owner,
      'terminal',
      join(right, 'destination.txt'),
      join(denied, 'destination.txt'),
      workspace,
      authorization,
    )).rejects.toThrow('已授权范围');
  });

  it('keeps remote scopes and Full Access on the current Host with one SFTP lease per call', async () => {
    const readFile = vi.fn(async (path: string) => Buffer.from(path));
    const filesystem = fakeRemoteFilesystem({
      stat: vi.fn(async (path: string) => (
        path.endsWith('.txt') ? remoteStat('file', Buffer.byteLength(path)) : remoteStat('directory')
      )),
      lstat: vi.fn(async (path: string) => (
        path.endsWith('.txt') ? remoteStat('file', Buffer.byteLength(path)) : remoteStat('directory')
      )),
      readFile,
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const owner = { id: 1 } as WebContents;
    const scoped = {
      readablePaths: ['/granted'],
      writablePaths: ['/granted'],
      fullAccess: false,
    };

    await expect(service.readText(
      owner, 'terminal', '/granted/allowed.txt', '/work', scoped,
    )).resolves.toMatchObject({ content: '/granted/allowed.txt' });
    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(withFilesystem.mock.calls[0]?.[3]).toBe('host-1');
    await expect(service.readText(
      owner, 'terminal', '/sibling/denied.txt', '/work', scoped,
    )).rejects.toThrow('已授权范围');
    expect(withFilesystem).toHaveBeenCalledTimes(1);

    await expect(service.readText(
      owner,
      'terminal',
      '/elsewhere/full.txt',
      '/work',
      { readablePaths: [], writablePaths: [], fullAccess: true },
    )).resolves.toMatchObject({ content: '/elsewhere/full.txt' });
    expect(withFilesystem).toHaveBeenCalledTimes(2);
    expect(withFilesystem.mock.calls[1]?.[3]).toBe('host-1');
  });

  it('canonicalizes a remote grant in one Host-bound lease and protects POSIX root', async () => {
    const unlink = vi.fn(async () => undefined);
    const rmdir = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      realpath: vi.fn(async (path: string) => path === '/grant-link' ? '/canonical/grant' : path),
      stat: vi.fn(async (path: string) => (
        path === '/canonical/grant' ? remoteStat('directory') : undefined
      )),
      lstat: vi.fn(async () => remoteStat('directory')),
      unlink,
      rmdir,
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const owner = { id: 1 } as WebContents;

    await expect(service.canonicalizeAccessRoot(owner, 'terminal', '/grant-link'))
      .resolves.toBe('/canonical/grant');
    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(withFilesystem.mock.calls[0]?.[3]).toBe('host-1');
    await expect(service.canonicalizeAccessRoot(owner, 'terminal', 'relative'))
      .rejects.toThrow('绝对路径');
    expect(withFilesystem).toHaveBeenCalledTimes(1);

    await expect(service.deletePath(
      owner,
      'terminal',
      '/',
      { recursive: true },
      '/work',
      { readablePaths: [], writablePaths: [], fullAccess: true },
    )).rejects.toThrow('文件系统根目录');
    expect(withFilesystem).toHaveBeenCalledTimes(2);
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
  });

  it('protects the local filesystem root before invoking mutation primitives', async () => {
    const filesystemRoot = parse(resolve(process.cwd())).root;
    const workspace = resolve(filesystemRoot, 'safe-workspace');
    const rmdir = vi.fn(async () => undefined);
    const backend = {
      ...fakeRemoteFilesystem({
        realpath: vi.fn(async (path: string) => path),
        lstat: vi.fn(async () => remoteStat('directory')),
        rmdir,
      }),
    } as FilesystemBackend;
    const service = new AgentFileService(
      {} as TerminalService,
      createSessionManager(() => ({
          id: TEST_SESSION_ID,
          transport: 'local',
          workspace: { backend: 'local', root: workspace },
        })),
      {} as RemoteFilesystemProvider,
      backend,
    );

    await expect(service.deletePath(
      { id: 1 } as WebContents,
      'terminal',
      filesystemRoot,
      { recursive: true },
      workspace,
      { readablePaths: [], writablePaths: [], fullAccess: true },
    )).rejects.toThrow('文件系统根目录');
    expect(rmdir).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')(
    'keeps Windows device, drive-relative, and ADS spellings blocked in Full Access',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-full-windows-'));
      roots.push(root);
      const service = createService(root);
      const owner = { id: 1 } as WebContents;
      const fullAccess = { readablePaths: [], writablePaths: [], fullAccess: true };

      await expect(service.statPath(owner, 'terminal', '\\\\?\\C:\\Windows', root, fullAccess))
        .rejects.toThrow('设备命名空间');
      await expect(service.statPath(owner, 'terminal', 'C:relative.txt', root, fullAccess))
        .rejects.toThrow('驱动器相对');
      await expect(service.statPath(owner, 'terminal', '\\Windows', root, fullAccess))
        .rejects.toThrow('驱动器根相对');
      await expect(service.writeText(
        owner, 'terminal', join(root, 'visible.txt:hidden'), 'x', null, root, fullAccess,
      )).rejects.toThrow('备用数据流');
    },
  );
});
