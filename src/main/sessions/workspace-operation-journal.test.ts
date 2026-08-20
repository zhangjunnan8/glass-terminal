import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkspaceOperationJournal,
  type WorkspaceOperationIntent,
  type WorkspaceOperationOutcome,
} from './workspace-operation-journal';

interface Fixture {
  base: string;
  root: string;
  sessionId: string;
  sessionPath: string;
}

const temporaryRoots: string[] = [];

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'ai-terminal-workspace-journal-test-'));
  temporaryRoots.push(base);
  const root = join(base, 'sessions');
  const sessionId = randomUUID();
  const sessionPath = join(root, sessionId);
  mkdirSync(sessionPath, { recursive: true, mode: 0o700 });
  return { base, root, sessionId, sessionPath };
}

function readIntent(): WorkspaceOperationIntent {
  return {
    operation: 'read',
    backend: 'local',
    target: { path: { scope: 'workspace', path: 'src/main.ts' } },
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  }
});

describe('WorkspaceOperationJournal', () => {
  it('writes only allowlisted metadata to JSONL and keeps the bounded diff body separate', () => {
    const data = fixture();
    const journal = new WorkspaceOperationJournal(data.root);
    const secret = 'CANARY-new-file-body-must-not-enter-jsonl';
    const handle = journal.begin(data.sessionId, {
      operation: 'patch',
      backend: 'sftp',
      target: { path: { scope: 'workspace', path: 'src/app.ts' } },
      expected: {
        exists: true,
        type: 'file',
        sha256: 'a'.repeat(64),
      },
      publication: {
        policy: 'strict',
        publishMode: 'posix-rename',
        serverCapabilities: {
          detection: 'advertised',
          hardlink: true,
          fsync: true,
          posixRename: true,
        },
        concurrencyGuarantee: 'atomic publish; best-effort hash recheck; strict CAS unsupported',
        durability: 'fsync',
      },
    }, {
      body: `--- a/src/app.ts\n+++ b/src/app.ts\n+${secret}\n`,
      additions: 1,
      deletions: 0,
      truncated: false,
    });

    journal.finish(handle, {
      outcome: 'succeeded',
      sideEffectCommitted: true,
      effect: {
        afterSha256: 'b'.repeat(64),
        bytes: 48,
        created: false,
      },
    });

    const workspacePath = join(data.sessionPath, 'workspace');
    const logPath = join(workspacePath, 'operations.jsonl');
    const diffPath = join(workspacePath, 'diffs', `${handle.operationId}.patch`);
    const jsonl = readFileSync(logPath, 'utf8');
    expect(jsonl).not.toContain(secret);
    expect(jsonl).not.toContain('--- a/');
    expect(readFileSync(diffPath, 'utf8')).toContain(secret);
    expect(journal.read(data.sessionId)).toMatchObject([
      {
        sequence: 1,
        recordType: 'intent',
        operationId: handle.operationId,
        operation: 'patch',
        target: { path: { scope: 'workspace', path: 'src/app.ts' } },
        publication: {
          policy: 'strict',
          publishMode: 'posix-rename',
          serverCapabilities: {
            detection: 'advertised', hardlink: true, fsync: true, posixRename: true,
          },
          concurrencyGuarantee: 'atomic publish; best-effort hash recheck; strict CAS unsupported',
          durability: 'fsync',
        },
        diff: { bytes: expect.any(Number), additions: 1, deletions: 0 },
      },
      {
        sequence: 2,
        recordType: 'outcome',
        operationId: handle.operationId,
        outcome: 'succeeded',
        sideEffectCommitted: true,
      },
    ]);
    if (process.platform !== 'win32') {
      expect(statSync(workspacePath).mode & 0o777).toBe(0o700);
      expect(statSync(join(workspacePath, 'diffs')).mode & 0o777).toBe(0o700);
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
      expect(statSync(diffPath).mode & 0o777).toBe(0o600);
    }
  });

  it('records read/search-style outcomes without accepting queries, previews, or side effects', () => {
    const data = fixture();
    const journal = new WorkspaceOperationJournal(data.root);
    const handle = journal.begin(data.sessionId, {
      operation: 'search',
      backend: 'local',
      target: { path: { scope: 'workspace', path: '.' } },
    });

    expect(() => journal.finish(handle, {
      outcome: 'succeeded',
      sideEffectCommitted: true,
    })).toThrow('sideEffectCommitted=false');
    journal.finish(handle, {
      outcome: 'succeeded',
      sideEffectCommitted: false,
      effect: { count: 4, truncated: true },
    });

    expect(journal.recover(data.sessionId)[0]).toMatchObject({
      intent: {
        operation: 'search',
        target: { path: { scope: 'workspace', path: '.' } },
      },
      outcome: { outcome: 'succeeded', sideEffectCommitted: false },
      sideEffectCommitted: false,
    });
  });

  it('rejects unknown raw fields instead of serializing their sensitive values', () => {
    const data = fixture();
    const journal = new WorkspaceOperationJournal(data.root);
    const secretQuery = 'CANARY-raw-search-query';
    expect(() => journal.begin(data.sessionId, {
      ...readIntent(),
      query: secretQuery,
    } as unknown as WorkspaceOperationIntent)).toThrow('unsupported field');

    const handle = journal.begin(data.sessionId, readIntent());
    const secretError = 'CANARY-raw-provider-error';
    expect(() => journal.finish(handle, {
      outcome: 'failed',
      sideEffectCommitted: false,
      failure: { code: 'io', stage: 'dispatch', retrySafe: true },
      error: secretError,
    } as unknown as WorkspaceOperationOutcome)).toThrow('unsupported field');

    const jsonl = readFileSync(
      join(data.sessionPath, 'workspace', 'operations.jsonl'),
      'utf8',
    );
    expect(jsonl).not.toContain(secretQuery);
    expect(jsonl).not.toContain(secretError);
    expect(journal.recover(data.sessionId)[0]).toMatchObject({
      outcome: null,
      sideEffectCommitted: false,
    });
  });

  it('rejects malformed or inconsistent remote publication metadata', () => {
    const data = fixture();
    const journal = new WorkspaceOperationJournal(data.root);
    const base = {
      operation: 'write' as const,
      backend: 'sftp' as const,
      target: { path: { scope: 'workspace' as const, path: 'new.txt' } },
      expected: { exists: false },
    };
    const compatibleDirect = {
      policy: 'compatible' as const,
      publishMode: 'direct-exclusive' as const,
      serverCapabilities: {
        detection: 'advertised' as const,
        hardlink: false,
        fsync: false,
        posixRename: false,
      },
      concurrencyGuarantee: 'exclusive no-overwrite; interrupted write may leave a partial file' as const,
      durability: 'close-only' as const,
    };

    expect(() => journal.begin(data.sessionId, {
      ...base,
      publication: { ...compatibleDirect, policy: 'strict' },
    }, {
      body: '--- a/new.txt\n+++ b/new.txt\n+new\n',
      additions: 1,
      deletions: 0,
      truncated: false,
    })).toThrow(/publication|policy|publish|capability/i);
    expect(() => journal.begin(data.sessionId, {
      operation: 'write',
      backend: 'local',
      target: { path: { scope: 'workspace', path: 'new.txt' } },
      publication: compatibleDirect,
    } as WorkspaceOperationIntent, {
      body: '--- a/new.txt\n+++ b/new.txt\n+new\n',
      additions: 1,
      deletions: 0,
      truncated: false,
    })).toThrow(/publication|SFTP/i);
  });

  it('stores explicit external and rejected scopes without absolute roots or raw spellings', () => {
    const data = fixture();
    const journal = new WorkspaceOperationJournal(data.root);
    const rootId = 'b'.repeat(64);
    const pathHash = 'c'.repeat(64);
    const authorized = journal.begin(data.sessionId, {
      operation: 'stat',
      backend: 'local',
      target: { path: { scope: 'authorized', rootId, path: 'src/main.ts' } },
    });
    journal.finish(authorized, { outcome: 'succeeded', sideEffectCommitted: false });
    const rejected = journal.begin(data.sessionId, {
      operation: 'read',
      backend: 'local',
      target: { path: { scope: 'rejected', pathHash } },
    }, undefined, 'policy_workspace_tool');
    journal.finish(rejected, {
      outcome: 'failed',
      sideEffectCommitted: false,
      failure: { code: 'permission', stage: 'prepare', retrySafe: true },
    });

    expect(journal.read(data.sessionId)).toMatchObject([
      {
        recordType: 'intent',
        source: 'agent_file_service',
        target: { path: { scope: 'authorized', rootId, path: 'src/main.ts' } },
      },
      { recordType: 'outcome' },
      {
        recordType: 'intent',
        source: 'policy_workspace_tool',
        target: { path: { scope: 'rejected', pathHash } },
      },
      { recordType: 'outcome' },
    ]);
    expect(() => journal.begin(data.sessionId, {
      operation: 'read',
      backend: 'local',
      target: {
        path: {
          scope: 'filesystem',
          rootId,
          path: '../absolute-or-parent',
        },
      },
    })).toThrow(/relative path/i);
    expect(() => journal.begin(
      data.sessionId,
      readIntent(),
      undefined,
      'untyped-source' as 'agent_file_service',
    )).toThrow(/source/i);
  });

  it('allows a diff-less write only for a safe prepare failure', () => {
    const data = fixture();
    const journal = new WorkspaceOperationJournal(data.root);
    const safeFailure = journal.begin(data.sessionId, {
      operation: 'write',
      backend: 'local',
      target: { path: { scope: 'workspace', path: 'blocked.txt' } },
    });
    expect(() => journal.finish(safeFailure, {
      outcome: 'succeeded',
      sideEffectCommitted: true,
    })).toThrow(/diff artifact/i);
    expect(() => journal.finish(safeFailure, {
      outcome: 'failed',
      sideEffectCommitted: null,
      failure: { code: 'io', stage: 'dispatch', retrySafe: false },
    })).toThrow(/diff artifact/i);
    journal.finish(safeFailure, {
      outcome: 'failed',
      sideEffectCommitted: false,
      failure: { code: 'permission', stage: 'prepare', retrySafe: true },
    });
    expect(journal.recover(data.sessionId)[0]).toMatchObject({
      outcome: {
        outcome: 'failed',
        sideEffectCommitted: false,
        failure: { stage: 'prepare', retrySafe: true },
      },
    });
  });

  it('restores sequence state and represents an unmatched mutation as unknown after restart', () => {
    const data = fixture();
    const initial = new WorkspaceOperationJournal(data.root);
    const handle = initial.begin(data.sessionId, {
      operation: 'delete',
      backend: 'sftp',
      target: { path: { scope: 'workspace', path: 'generated' } },
      recursive: true,
      plan: { items: 7 },
    });

    const restarted = new WorkspaceOperationJournal(data.root);
    expect(restarted.recover(data.sessionId)).toMatchObject([{
      intent: { sequence: 1, operation: 'delete' },
      outcome: null,
      sideEffectCommitted: null,
    }]);

    restarted.finish(handle, {
      outcome: 'failed',
      sideEffectCommitted: null,
      effect: { itemsPlanned: 7, itemsCommitted: 0 },
      failure: {
        code: 'remote_disconnected',
        stage: 'dispatch',
        retrySafe: false,
      },
    });
    expect(new WorkspaceOperationJournal(data.root).read(data.sessionId).map((record) => (
      record.sequence
    ))).toEqual([1, 2]);
  });

  it('truncates only an incomplete final record and continues with a contiguous sequence', () => {
    const data = fixture();
    const initial = new WorkspaceOperationJournal(data.root);
    initial.begin(data.sessionId, readIntent());
    const logPath = join(data.sessionPath, 'workspace', 'operations.jsonl');
    const validBytes = statSync(logPath).size;
    appendFileSync(logPath, '{"version":1,"sequence":2');
    expect(statSync(logPath).size).toBeGreaterThan(validBytes);

    const restarted = new WorkspaceOperationJournal(data.root);
    expect(restarted.read(data.sessionId)).toHaveLength(1);
    expect(statSync(logPath).size).toBe(validBytes);
    const next = restarted.begin(data.sessionId, {
      operation: 'stat',
      backend: 'local',
      target: { path: { scope: 'workspace', path: 'src/main.ts' } },
    });
    expect(next.intentSequence).toBe(2);
  });

  it('fails closed on a corrupt complete record rather than skipping audit history', () => {
    const data = fixture();
    const journal = new WorkspaceOperationJournal(data.root);
    journal.begin(data.sessionId, readIntent());
    appendFileSync(
      join(data.sessionPath, 'workspace', 'operations.jsonl'),
      '{"unexpected":"complete-corrupt-line"}\n',
    );

    expect(() => new WorkspaceOperationJournal(data.root).read(data.sessionId))
      .toThrow(/record|version|corrupt/i);
  });

  it('reserves bounded outcome space and rejects a new intent before the hard log quota', () => {
    const data = fixture();
    const journal = new WorkspaceOperationJournal(data.root, {
      maxRecordBytes: 512,
      maxLogBytes: 1_200,
      maxTotalBytes: 3_000,
    });
    const first = journal.begin(data.sessionId, readIntent());

    expect(() => journal.begin(data.sessionId, {
      operation: 'list',
      backend: 'local',
      target: { path: { scope: 'workspace', path: 'src' } },
    })).toThrow(/full|quota/i);
    journal.finish(first, {
      outcome: 'succeeded',
      sideEffectCommitted: false,
      effect: { bytes: 12 },
    });
    expect(journal.read(data.sessionId)).toHaveLength(2);
  });

  it('rejects a diff above the 64 KiB hard bound before creating journal storage', () => {
    const data = fixture();
    const journal = new WorkspaceOperationJournal(data.root);
    expect(() => journal.begin(data.sessionId, {
      operation: 'write',
      backend: 'local',
      target: { path: { scope: 'workspace', path: 'large.txt' } },
      expected: { exists: false },
    }, {
      body: 'x'.repeat((64 * 1024) + 1),
      additions: 1,
      deletions: 0,
      truncated: true,
    })).toThrow('65536-byte limit');
    expect(existsSync(join(data.sessionPath, 'workspace'))).toBe(false);
  });

  it('rejects a symlink or junction in the protected journal path', () => {
    const data = fixture();
    const redirected = join(data.base, 'redirected-workspace');
    mkdirSync(redirected);
    symlinkSync(
      redirected,
      join(data.sessionPath, 'workspace'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => new WorkspaceOperationJournal(data.root).begin(data.sessionId, readIntent()))
      .toThrow(/symlink|reparse/i);
  });

  it('rejects a hard-linked operations file', () => {
    const data = fixture();
    const workspacePath = join(data.sessionPath, 'workspace');
    mkdirSync(join(workspacePath, 'diffs'), { recursive: true });
    const outside = join(data.sessionPath, 'outside.jsonl');
    writeFileSync(outside, '');
    linkSync(outside, join(workspacePath, 'operations.jsonl'));

    expect(() => new WorkspaceOperationJournal(data.root).begin(data.sessionId, readIntent()))
      .toThrow(/singly-linked|regular/i);
  });
});
