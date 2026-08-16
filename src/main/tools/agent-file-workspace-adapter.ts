import { resolve } from 'node:path';
import { posix } from 'node:path';
import type { WebContents } from 'electron';
import type { WorkspaceBinding, WorkspaceTool } from '../../shared/tools';
import type { AgentFileService } from '../agent/agent-file-service';

/**
 * Temporary compatibility adapter while the existing AgentFileService is
 * decomposed into local/SFTP filesystem backends. Harness code only sees the
 * WorkspaceTool contract through the ToolGateway.
 */
export class AgentFileWorkspaceAdapter implements WorkspaceTool {
  constructor(
    private readonly files: AgentFileService,
    private readonly owner: WebContents,
    private readonly terminalId: string,
    private readonly binding: WorkspaceBinding,
  ) {}

  async listDirectory(path = '.') {
    const result = await this.files.list(
      this.owner,
      this.terminalId,
      path,
      this.binding.root,
    );
    const joinPath = this.binding.backend === 'sftp'
      ? (name: string) => posix.join(result.path, name)
      : (name: string) => resolve(result.path, name);
    return {
      ...result,
      entries: result.entries.map((entry) => ({
        ...entry,
        path: joinPath(entry.name),
      })),
    };
  }

  readFile(path: string) {
    return this.files.readText(this.owner, this.terminalId, path, this.binding.root);
  }

  writeFile(path: string, content: string, expectedSha256: string | null) {
    return this.files.writeText(
      this.owner,
      this.terminalId,
      path,
      content,
      expectedSha256,
      this.binding.root,
    );
  }

  applyPatch(path: string, expectedSha256: string, patches: Array<{
    search: string;
    replace: string;
  }>) {
    return this.files.applyPatch(
      this.owner,
      this.terminalId,
      path,
      expectedSha256,
      patches,
      this.binding.root,
    );
  }

  async search(): Promise<never> {
    throw new Error('workspace_search is not implemented by the compatibility backend.');
  }

  async glob(): Promise<never> {
    throw new Error('workspace_glob is not implemented by the compatibility backend.');
  }

  async stat(): Promise<never> {
    throw new Error('workspace_stat is not implemented by the compatibility backend.');
  }

  async mkdir(): Promise<never> {
    throw new Error('workspace_mkdir is not implemented by the compatibility backend.');
  }

  async rename(): Promise<never> {
    throw new Error('workspace_rename is not implemented by the compatibility backend.');
  }

  async delete(): Promise<never> {
    throw new Error('workspace_delete is not implemented by the compatibility backend.');
  }
}
