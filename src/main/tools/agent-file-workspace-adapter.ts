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

  search(query: string, options?: { path?: string; maxResults?: number }) {
    return this.files.search(
      this.owner,
      this.terminalId,
      query,
      options,
      this.binding.root,
    );
  }

  glob(pattern: string, options?: { path?: string; maxResults?: number }) {
    return this.files.glob(
      this.owner,
      this.terminalId,
      pattern,
      options,
      this.binding.root,
    );
  }

  stat(path: string) {
    return this.files.statPath(this.owner, this.terminalId, path, this.binding.root);
  }

  mkdir(path: string) {
    return this.files.mkdirPath(this.owner, this.terminalId, path, this.binding.root);
  }

  rename(source: string, destination: string) {
    return this.files.renamePath(
      this.owner,
      this.terminalId,
      source,
      destination,
      this.binding.root,
    );
  }

  delete(path: string, options?: { recursive?: boolean }) {
    return this.files.deletePath(
      this.owner,
      this.terminalId,
      path,
      options,
      this.binding.root,
    );
  }
}
