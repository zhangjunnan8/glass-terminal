import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { WorkspaceBinding, WorkspaceToolPermissions } from '../../shared/tools';
import type { AgentFileService } from '../agent/agent-file-service';
import { AgentFileWorkspaceAdapter } from './agent-file-workspace-adapter';
import { POLICY_WORKSPACE_AUDITOR } from './policy-workspace-tool';

describe('AgentFileWorkspaceAdapter', () => {
  it('forwards search and glob through the bound terminal and immutable Workspace Root', async () => {
    const owner = {} as WebContents;
    const binding: WorkspaceBinding = { backend: 'local', root: 'C:\\project' };
    const searchResult = {
      query: 'needle',
      matches: [{ path: 'C:\\project\\a.ts', line: 1, column: 2, preview: 'needle' }],
      filesScanned: 1,
      truncated: false,
    };
    const globResult = {
      pattern: '**/*.ts',
      paths: ['C:\\project\\a.ts'],
      truncated: false,
    };
    const files = {
      search: vi.fn().mockResolvedValue(searchResult),
      glob: vi.fn().mockResolvedValue(globResult),
    } as unknown as AgentFileService;
    const adapter = new AgentFileWorkspaceAdapter(files, owner, 'terminal-1', binding);
    const authorization = {
      readablePaths: ['C:\\project'],
      writablePaths: ['C:\\project'],
      fullAccess: false,
    };

    await expect(adapter.search('needle', { path: 'src', maxResults: 7 }))
      .resolves.toEqual(searchResult);
    await expect(adapter.glob('**/*.ts', { maxResults: 9 }))
      .resolves.toEqual(globResult);

    expect(files.search).toHaveBeenCalledWith(
      owner,
      'terminal-1',
      'needle',
      { path: 'src', maxResults: 7 },
      'C:\\project',
      authorization,
    );
    expect(files.glob).toHaveBeenCalledWith(
      owner,
      'terminal-1',
      '**/*.ts',
      { maxResults: 9 },
      'C:\\project',
      authorization,
    );
  });

  it('forwards mkdir, rename, and delete without using Terminal commands', async () => {
    const owner = {} as WebContents;
    const binding: WorkspaceBinding = {
      backend: 'sftp',
      root: '/srv/project',
      hostId: 'host-1',
    };
    const files = {
      mkdirPath: vi.fn().mockResolvedValue(undefined),
      renamePath: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentFileService;
    const adapter = new AgentFileWorkspaceAdapter(files, owner, 'terminal-ssh', binding);
    const authorization = {
      readablePaths: ['/srv/project'],
      writablePaths: ['/srv/project'],
      fullAccess: false,
    };

    await adapter.mkdir('tmp');
    await adapter.rename('tmp', 'cache');
    await adapter.delete('cache', { recursive: true });

    expect(files.mkdirPath).toHaveBeenCalledWith(
      owner,
      'terminal-ssh',
      'tmp',
      '/srv/project',
      authorization,
    );
    expect(files.renamePath).toHaveBeenCalledWith(
      owner,
      'terminal-ssh',
      'tmp',
      'cache',
      '/srv/project',
      authorization,
    );
    expect(files.deletePath).toHaveBeenCalledWith(
      owner,
      'terminal-ssh',
      'cache',
      { recursive: true },
      '/srv/project',
      authorization,
    );
  });

  it('captures an isolated permission snapshot for every backend operation', async () => {
    const owner = {} as WebContents;
    const binding: WorkspaceBinding = { backend: 'local', root: 'C:\\project' };
    const permissions: WorkspaceToolPermissions = {
      enabled: true,
      mode: 'read-write',
      read: true,
      write: true,
      create: true,
      delete: true,
      readablePaths: ['C:\\readable'],
      writablePaths: ['C:\\writable'],
      fullAccess: true,
    };
    const files = {
      readText: vi.fn().mockResolvedValue({}),
      writeText: vi.fn().mockResolvedValue({}),
      applyPatch: vi.fn().mockResolvedValue({}),
      statPath: vi.fn().mockResolvedValue({}),
    } as unknown as AgentFileService;
    const adapter = new AgentFileWorkspaceAdapter(
      files,
      owner,
      'terminal-1',
      binding,
      permissions,
    );

    permissions.readablePaths[0] = 'C:\\changed';
    permissions.writablePaths.push('C:\\injected');
    permissions.fullAccess = false;

    await adapter.readFile('C:\\readable\\a.txt');
    await adapter.writeFile('C:\\writable\\b.txt', 'body', null);
    await adapter.applyPatch('C:\\writable\\b.txt', 'a'.repeat(64), [{
      search: 'body', replace: 'next',
    }]);
    await adapter.stat('C:\\readable\\a.txt');

    const expected = {
      readablePaths: ['C:\\readable'],
      writablePaths: ['C:\\writable'],
      fullAccess: true,
    };
    expect(files.readText).toHaveBeenCalledWith(
      owner, 'terminal-1', 'C:\\readable\\a.txt', 'C:\\project', expected,
    );
    expect(files.writeText).toHaveBeenCalledWith(
      owner, 'terminal-1', 'C:\\writable\\b.txt', 'body', null, 'C:\\project', expected,
    );
    expect(files.applyPatch).toHaveBeenCalledWith(
      owner,
      'terminal-1',
      'C:\\writable\\b.txt',
      'a'.repeat(64),
      [{ search: 'body', replace: 'next' }],
      'C:\\project',
      expected,
    );
    expect(files.statPath).toHaveBeenCalledWith(
      owner, 'terminal-1', 'C:\\readable\\a.txt', 'C:\\project', expected,
    );
  });

  it('forwards a policy rejection to the main-only audit hook with the captured scope', () => {
    const owner = {} as WebContents;
    const binding: WorkspaceBinding = { backend: 'local', root: 'C:\\project' };
    const permissions = {
      enabled: true,
      mode: 'read-write' as const,
      read: true,
      write: true,
      create: true,
      delete: true,
      readablePaths: ['C:\\project\\read'],
      writablePaths: ['C:\\project\\write'],
      fullAccess: false,
    };
    const files = {
      recordPolicyRejection: vi.fn(),
    } as unknown as AgentFileService;
    const adapter = new AgentFileWorkspaceAdapter(
      files,
      owner,
      'terminal-1',
      binding,
      permissions,
    );

    adapter[POLICY_WORKSPACE_AUDITOR]({
      operation: 'delete',
      target: { path: 'write/old' },
      options: { recursive: true },
    });

    expect(files.recordPolicyRejection).toHaveBeenCalledWith(
      owner,
      'terminal-1',
      'delete',
      { path: 'write/old' },
      'C:\\project',
      {
        readablePaths: ['C:\\project\\read'],
        writablePaths: ['C:\\project\\write'],
        fullAccess: false,
      },
      { recursive: true },
    );
  });

  it('checks turn liveness before delegation or policy-rejection auditing', async () => {
    const owner = {} as WebContents;
    const binding: WorkspaceBinding = { backend: 'local', root: 'C:\\project' };
    const stale = new Error('Workspace tool grant is no longer active.');
    const assertLive = vi.fn(() => { throw stale; });
    const files = {
      readText: vi.fn(),
      recordPolicyRejection: vi.fn(),
    } as unknown as AgentFileService;
    const adapter = new AgentFileWorkspaceAdapter(
      files,
      owner,
      'terminal-1',
      binding,
      undefined,
      assertLive,
    );

    expect(() => adapter.readFile('secret-raw-name.txt')).toThrow(stale);
    expect(() => adapter[POLICY_WORKSPACE_AUDITOR]({
      operation: 'read',
      target: { path: 'secret-raw-name.txt' },
    })).toThrow(stale);

    expect(assertLive).toHaveBeenCalledTimes(2);
    expect(files.readText).not.toHaveBeenCalled();
    expect(files.recordPolicyRejection).not.toHaveBeenCalled();
  });

  it('rechecks liveness before delivering an in-flight result and exposes a settlement barrier', async () => {
    let live = true;
    let resolveRead!: (value: {
      path: string;
      content: string;
      bytes: number;
      sha256: string;
    }) => void;
    const readText = vi.fn(() => new Promise<{
      path: string;
      content: string;
      bytes: number;
      sha256: string;
    }>((resolve) => { resolveRead = resolve; }));
    const adapter = new AgentFileWorkspaceAdapter(
      { readText } as unknown as AgentFileService,
      {} as WebContents,
      'terminal-1',
      { backend: 'local', root: 'C:\\project' },
      undefined,
      () => {
        if (!live) throw new Error('Workspace tool grant is no longer active.');
      },
    );

    const pending = adapter.readFile('inside.txt');
    live = false;
    let drained = false;
    const drain = adapter.waitForInFlight().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    resolveRead({
      path: 'C:\\project\\inside.txt',
      content: 'inside',
      bytes: 6,
      sha256: 'a'.repeat(64),
    });

    await expect(pending).rejects.toThrow('no longer active');
    await drain;
    expect(drained).toBe(true);
  });
});
