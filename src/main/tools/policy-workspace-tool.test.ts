import { describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceBinding,
  WorkspaceTool,
  WorkspaceToolPermissions,
} from '../../shared/tools';
import {
  POLICY_WORKSPACE_AUDITOR,
  PolicyWorkspaceTool,
  type PolicyWorkspaceAuditDelegate,
} from './policy-workspace-tool';

const SHA = 'a'.repeat(64);

function workspace(): WorkspaceTool {
  return {
    listDirectory: vi.fn(async (path = '.') => ({ path, entries: [], truncated: false })),
    readFile: vi.fn(async (path) => ({ path, content: '', bytes: 0, sha256: SHA })),
    writeFile: vi.fn(async (path, content, expectedSha256) => ({
      path,
      bytes: content.length,
      sha256: expectedSha256 ?? SHA,
      created: expectedSha256 === null,
    })),
    applyPatch: vi.fn(async (path) => ({ path, bytes: 0, sha256: SHA, created: false })),
    search: vi.fn(async (query) => ({ query, matches: [], filesScanned: 0, truncated: false })),
    glob: vi.fn(async (pattern) => ({ pattern, paths: [], truncated: false })),
    stat: vi.fn(async (path) => ({ path, type: 'file' as const, size: 0 })),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function permissions(
  overrides: Partial<WorkspaceToolPermissions> = {},
): WorkspaceToolPermissions {
  return {
    enabled: true,
    mode: 'read-write',
    read: true,
    write: true,
    create: true,
    delete: true,
    readablePaths: ['C:\\workspace\\read'],
    writablePaths: ['C:\\workspace\\write'],
    fullAccess: false,
    ...overrides,
  };
}

const LOCAL_BINDING: WorkspaceBinding = {
  backend: 'local',
  root: 'C:\\workspace',
};

describe('PolicyWorkspaceTool', () => {
  it.each([
    ['listDirectory', (tool: WorkspaceTool) => tool.listDirectory('read/src')],
    ['readFile', (tool: WorkspaceTool) => tool.readFile('read/src/a.ts')],
    ['stat', (tool: WorkspaceTool) => tool.stat('read/src/a.ts')],
    ['search', (tool: WorkspaceTool) => tool.search('needle', { path: 'read/src' })],
    ['glob', (tool: WorkspaceTool) => tool.glob('**/*.ts', { path: 'read/src' })],
  ])('requires read capability and readable scope for %s', async (method, invoke) => {
    const delegate = workspace();
    const allowed = new PolicyWorkspaceTool(delegate, LOCAL_BINDING, permissions());
    await expect(invoke(allowed)).resolves.toBeDefined();
    expect(vi.mocked(delegate[method as keyof WorkspaceTool])).toHaveBeenCalledTimes(1);

    const noReadDelegate = workspace();
    const noRead = new PolicyWorkspaceTool(
      noReadDelegate,
      LOCAL_BINDING,
      permissions({ read: false }),
    );
    await expect(invoke(noRead)).rejects.toThrow(/capability policy/i);
    expect(vi.mocked(noReadDelegate[method as keyof WorkspaceTool])).not.toHaveBeenCalled();

    const outOfScopeDelegate = workspace();
    const outOfScope = new PolicyWorkspaceTool(
      outOfScopeDelegate,
      LOCAL_BINDING,
      permissions(),
    );
    const outsideInvocations: Record<string, () => Promise<unknown>> = {
      listDirectory: () => outOfScope.listDirectory('write'),
      readFile: () => outOfScope.readFile('write/a.ts'),
      stat: () => outOfScope.stat('write/a.ts'),
      search: () => outOfScope.search('needle', { path: 'write' }),
      glob: () => outOfScope.glob('**/*.ts', { path: 'write' }),
    };
    await expect(outsideInvocations[method]!()).rejects.toThrow(/readable paths/i);
    expect(vi.mocked(outOfScopeDelegate[method as keyof WorkspaceTool])).not.toHaveBeenCalled();
  });

  it('requires create and writable scope for new files and directories', async () => {
    const delegate = workspace();
    const tool = new PolicyWorkspaceTool(delegate, LOCAL_BINDING, permissions());
    await tool.writeFile('write/new.ts', 'new', null);
    await tool.mkdir('write/new-dir');
    expect(delegate.writeFile).toHaveBeenCalledTimes(1);
    expect(delegate.mkdir).toHaveBeenCalledTimes(1);

    for (const invoke of [
      (candidate: WorkspaceTool) => candidate.writeFile('write/new.ts', 'new', null),
      (candidate: WorkspaceTool) => candidate.mkdir('write/new-dir'),
    ]) {
      const deniedDelegate = workspace();
      const denied = new PolicyWorkspaceTool(
        deniedDelegate,
        LOCAL_BINDING,
        permissions({ create: false }),
      );
      await expect(invoke(denied)).rejects.toThrow(/capability policy/i);
      expect(deniedDelegate.writeFile).not.toHaveBeenCalled();
      expect(deniedDelegate.mkdir).not.toHaveBeenCalled();
    }

    const outOfScope = new PolicyWorkspaceTool(delegate, LOCAL_BINDING, permissions());
    await expect(outOfScope.mkdir('read/new-dir')).rejects.toThrow(/writable paths/i);
  });

  it('requires read plus write and both scopes for overwrite and patch', async () => {
    const delegate = workspace();
    const bothScopes = permissions({
      readablePaths: ['C:\\workspace\\shared'],
      writablePaths: ['C:\\workspace\\shared'],
    });
    const allowed = new PolicyWorkspaceTool(delegate, LOCAL_BINDING, bothScopes);
    await allowed.writeFile('shared/a.ts', 'new', SHA);
    await allowed.applyPatch('shared/a.ts', SHA, [{ search: 'a', replace: 'b' }]);
    expect(delegate.writeFile).toHaveBeenCalledTimes(1);
    expect(delegate.applyPatch).toHaveBeenCalledTimes(1);

    for (const missing of ['read', 'write'] as const) {
      const deniedDelegate = workspace();
      const denied = new PolicyWorkspaceTool(
        deniedDelegate,
        LOCAL_BINDING,
        { ...bothScopes, [missing]: false },
      );
      await expect(denied.writeFile('shared/a.ts', 'new', SHA)).rejects.toThrow(/capability/i);
      await expect(denied.applyPatch(
        'shared/a.ts',
        SHA,
        [{ search: 'a', replace: 'b' }],
      )).rejects.toThrow(/capability/i);
      expect(deniedDelegate.writeFile).not.toHaveBeenCalled();
      expect(deniedDelegate.applyPatch).not.toHaveBeenCalled();
    }

    const readableOnly = new PolicyWorkspaceTool(delegate, LOCAL_BINDING, permissions({
      readablePaths: ['C:\\workspace\\read'],
      writablePaths: ['C:\\workspace\\write'],
    }));
    await expect(readableOnly.applyPatch(
      'read/a.ts',
      SHA,
      [{ search: 'a', replace: 'b' }],
    )).rejects.toThrow(/writable paths/i);
    await expect(readableOnly.applyPatch(
      'write/a.ts',
      SHA,
      [{ search: 'a', replace: 'b' }],
    )).rejects.toThrow(/readable paths/i);
  });

  it('requires delete plus writable scope for deletion', async () => {
    const delegate = workspace();
    const allowed = new PolicyWorkspaceTool(delegate, LOCAL_BINDING, permissions());
    await allowed.delete('write/old.ts');
    expect(delegate.delete).toHaveBeenCalledTimes(1);

    const noDeleteDelegate = workspace();
    const noDelete = new PolicyWorkspaceTool(
      noDeleteDelegate,
      LOCAL_BINDING,
      permissions({ delete: false }),
    );
    await expect(noDelete.delete('write/old.ts')).rejects.toThrow(/capability/i);
    expect(noDeleteDelegate.delete).not.toHaveBeenCalled();
    await expect(allowed.delete('read/old.ts')).rejects.toThrow(/writable paths/i);
  });

  it('requires write, create, delete, and writable scope at both rename endpoints', async () => {
    const delegate = workspace();
    const allowed = new PolicyWorkspaceTool(delegate, LOCAL_BINDING, permissions());
    await allowed.rename('write/from.ts', 'write/to.ts');
    expect(delegate.rename).toHaveBeenCalledTimes(1);

    for (const missing of ['write', 'create', 'delete'] as const) {
      const deniedDelegate = workspace();
      const denied = new PolicyWorkspaceTool(
        deniedDelegate,
        LOCAL_BINDING,
        permissions({ [missing]: false }),
      );
      await expect(denied.rename('write/from.ts', 'write/to.ts')).rejects.toThrow(/capability/i);
      expect(deniedDelegate.rename).not.toHaveBeenCalled();
    }
    await expect(allowed.rename('read/from.ts', 'write/to.ts')).rejects.toThrow(/writable paths/i);
    await expect(allowed.rename('write/from.ts', 'read/to.ts')).rejects.toThrow(/writable paths/i);
  });

  it('uses segment-aware Windows scope matching for relative and absolute paths', async () => {
    const delegate = workspace();
    const tool = new PolicyWorkspaceTool(delegate, LOCAL_BINDING, permissions());
    await tool.readFile('read\\relative.ts');
    await tool.readFile('C:\\workspace\\read\\absolute.ts');
    await expect(tool.readFile('C:\\workspace\\reader\\sibling.ts'))
      .rejects.toThrow(/readable paths/i);
    await expect(tool.readFile('..\\workspace-other\\read\\escape.ts'))
      .rejects.toThrow(/readable paths/i);
    expect(delegate.readFile).toHaveBeenCalledTimes(2);
  });

  it('uses POSIX segment matching for SFTP paths', async () => {
    const delegate = workspace();
    const tool = new PolicyWorkspaceTool(
      delegate,
      { backend: 'sftp', root: '/srv/work', hostId: 'host-1' },
      permissions({
        readablePaths: ['/srv/work/src'],
        writablePaths: ['/srv/work/src'],
      }),
    );
    await tool.readFile('src/a.ts');
    await tool.readFile('/srv/work/src/b.ts');
    await expect(tool.readFile('/srv/work/src-other/c.ts')).rejects.toThrow(/readable paths/i);
    await expect(tool.readFile('../outside.ts')).rejects.toThrow(/readable paths/i);
    expect(delegate.readFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    '\\\\?\\C:\\workspace\\read\\x.ts',
    'C:read\\x.ts',
    '\\read\\x.ts',
    'read\\file.txt:secret',
    'read\\CON.txt',
    'read\\trailing.\\x.ts',
    'read\\control\u0000.ts',
  ])('rejects unsafe raw Windows path %j before delegation', async (path) => {
    const delegate = workspace();
    const tool = new PolicyWorkspaceTool(delegate, LOCAL_BINDING, permissions());
    await expect(tool.readFile(path)).rejects.toThrow(/Workspace path/i);
    expect(delegate.readFile).not.toHaveBeenCalled();
  });

  it('full access skips ranges but never skips individual capabilities or mode', async () => {
    const delegate = workspace();
    const full = new PolicyWorkspaceTool(delegate, LOCAL_BINDING, permissions({
      mode: 'full-access',
      fullAccess: true,
      readablePaths: [],
      writablePaths: [],
    }));
    await full.readFile('D:\\outside\\read.ts');
    await full.mkdir('D:\\outside\\new-dir');
    expect(delegate.readFile).toHaveBeenCalledTimes(1);
    expect(delegate.mkdir).toHaveBeenCalledTimes(1);

    const noCreateDelegate = workspace();
    const noCreate = new PolicyWorkspaceTool(noCreateDelegate, LOCAL_BINDING, permissions({
      mode: 'full-access', fullAccess: true, create: false,
    }));
    await expect(noCreate.mkdir('D:\\outside\\new-dir')).rejects.toThrow(/capability/i);
    expect(noCreateDelegate.mkdir).not.toHaveBeenCalled();

    const forgedReadOnlyDelegate = workspace();
    const forgedReadOnly = new PolicyWorkspaceTool(
      forgedReadOnlyDelegate,
      LOCAL_BINDING,
      permissions({ mode: 'read-only', fullAccess: true, create: true }),
    );
    await expect(forgedReadOnly.mkdir('D:\\outside\\new-dir')).rejects.toThrow(/capability/i);
    expect(forgedReadOnlyDelegate.mkdir).not.toHaveBeenCalled();

    const forgedRangeDelegate = workspace();
    const forgedRange = new PolicyWorkspaceTool(
      forgedRangeDelegate,
      LOCAL_BINDING,
      permissions({ mode: 'read-write', fullAccess: true }),
    );
    await expect(forgedRange.readFile('D:\\outside\\read.ts')).rejects.toThrow(/readable paths/i);
    expect(forgedRangeDelegate.readFile).not.toHaveBeenCalled();
  });

  it('audits every policy rejection without forwarding query, content, or patch text', async () => {
    const audit = vi.fn<PolicyWorkspaceAuditDelegate[typeof POLICY_WORKSPACE_AUDITOR]>();
    const delegate = Object.assign(workspace(), {
      [POLICY_WORKSPACE_AUDITOR]: audit,
    });
    const tool = new PolicyWorkspaceTool(delegate, LOCAL_BINDING, permissions());

    await expect(tool.search('CANARY-policy-query', { path: 'write' }))
      .rejects.toThrow(/readable paths/i);
    await expect(tool.writeFile('read/new.txt', 'CANARY-policy-content', null))
      .rejects.toThrow(/writable paths/i);
    await expect(tool.applyPatch('read/a.ts', SHA, [{
      search: 'CANARY-policy-patch-search',
      replace: 'CANARY-policy-patch-replace',
    }])).rejects.toThrow(/writable paths/i);

    expect(audit).toHaveBeenCalledTimes(3);
    expect(audit.mock.calls.map(([request]) => request)).toEqual([
      { operation: 'search', target: { path: 'write' } },
      { operation: 'write', target: { path: 'read/new.txt' } },
      { operation: 'patch', target: { path: 'read/a.ts' } },
    ]);
    const auditJson = JSON.stringify(audit.mock.calls);
    expect(auditJson).not.toContain('CANARY-policy-query');
    expect(auditJson).not.toContain('CANARY-policy-content');
    expect(auditJson).not.toContain('CANARY-policy-patch-search');
    expect(auditJson).not.toContain('CANARY-policy-patch-replace');
  });

  it.each([
    ['NUL', 'read/CANARY-invalid\0name.ts'],
    ['device', 'read/CON.txt'],
    ['overlong', `read/CANARY-overlong-${'x'.repeat(4_097)}`],
  ])('still invokes the audit hook for an invalid %s path', async (_label, path) => {
    const audit = vi.fn<PolicyWorkspaceAuditDelegate[typeof POLICY_WORKSPACE_AUDITOR]>();
    const delegate = Object.assign(workspace(), {
      [POLICY_WORKSPACE_AUDITOR]: audit,
    });
    const tool = new PolicyWorkspaceTool(delegate, LOCAL_BINDING, permissions());

    await expect(tool.readFile(path)).rejects.toThrow(/Workspace path/i);
    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith({ operation: 'read', target: { path } });
    expect(delegate.readFile).not.toHaveBeenCalled();
  });
});
