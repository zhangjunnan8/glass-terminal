import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { WorkspaceBinding } from '../../shared/tools';
import type { AgentFileService } from '../agent/agent-file-service';
import { AgentFileWorkspaceAdapter } from './agent-file-workspace-adapter';

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
    );
    expect(files.glob).toHaveBeenCalledWith(
      owner,
      'terminal-1',
      '**/*.ts',
      { maxResults: 9 },
      'C:\\project',
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

    await adapter.mkdir('tmp');
    await adapter.rename('tmp', 'cache');
    await adapter.delete('cache', { recursive: true });

    expect(files.mkdirPath).toHaveBeenCalledWith(
      owner,
      'terminal-ssh',
      'tmp',
      '/srv/project',
    );
    expect(files.renamePath).toHaveBeenCalledWith(
      owner,
      'terminal-ssh',
      'tmp',
      'cache',
      '/srv/project',
    );
    expect(files.deletePath).toHaveBeenCalledWith(
      owner,
      'terminal-ssh',
      'cache',
      { recursive: true },
      '/srv/project',
    );
  });
});
