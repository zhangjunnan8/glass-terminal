import { resolve } from 'node:path';
import { posix } from 'node:path';
import type { WebContents } from 'electron';
import type {
  WorkspaceBinding,
  WorkspaceTool,
  WorkspaceToolPermissions,
} from '../../shared/tools';
import type {
  AgentFilePathAuthorization,
  AgentFileService,
} from '../agent/agent-file-service';
import {
  POLICY_WORKSPACE_AUDITOR,
  type PolicyWorkspaceAuditRequest,
} from './policy-workspace-tool';

/**
 * Temporary compatibility adapter while the existing AgentFileService is
 * decomposed into local/SFTP filesystem backends. Harness code only sees the
 * WorkspaceTool contract through the ToolGateway.
 */
export class AgentFileWorkspaceAdapter implements WorkspaceTool {
  private readonly authorization: AgentFilePathAuthorization;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly files: AgentFileService,
    private readonly owner: WebContents,
    private readonly terminalId: string,
    private readonly binding: WorkspaceBinding,
    permissions?: WorkspaceToolPermissions,
    /** Fail-closed, main-process revocation check for this turn-local capability. */
    private readonly assertLive?: () => void,
  ) {
    // Capture a turn-local immutable-by-construction snapshot. Callers may
    // mutate SessionToolContext objects after binding, but that must not widen
    // an already-created WorkspaceTool's filesystem authority.
    this.authorization = permissions
      ? {
        readablePaths: [...permissions.readablePaths],
        writablePaths: [...permissions.writablePaths],
        fullAccess: permissions.fullAccess,
        ...(assertLive ? { assertLive } : {}),
      }
      : {
        readablePaths: [binding.root],
        writablePaths: [binding.root],
        fullAccess: false,
        ...(assertLive ? { assertLive } : {}),
      };
  }

  [POLICY_WORKSPACE_AUDITOR](request: PolicyWorkspaceAuditRequest): void {
    this.assertToolLive();
    this.files.recordPolicyRejection(
      this.owner,
      this.terminalId,
      request.operation,
      request.target,
      this.binding.root,
      this.authorization,
      request.options,
    );
  }

  async listDirectory(path = '.') {
    this.assertToolLive();
    const result = await this.track(this.files.list(
      this.owner,
      this.terminalId,
      path,
      this.binding.root,
      this.authorization,
    ));
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
    this.assertToolLive();
    return this.track(this.files.readText(
      this.owner,
      this.terminalId,
      path,
      this.binding.root,
      this.authorization,
    ));
  }

  writeFile(path: string, content: string, expectedSha256: string | null) {
    this.assertToolLive();
    return this.track(this.files.writeText(
      this.owner,
      this.terminalId,
      path,
      content,
      expectedSha256,
      this.binding.root,
      this.authorization,
    ));
  }

  applyPatch(path: string, expectedSha256: string, patches: Array<{
    search: string;
    replace: string;
  }>) {
    this.assertToolLive();
    return this.track(this.files.applyPatch(
      this.owner,
      this.terminalId,
      path,
      expectedSha256,
      patches,
      this.binding.root,
      this.authorization,
    ));
  }

  search(query: string, options?: {
    path?: string;
    maxResults?: number;
    resultOffset?: number;
  }) {
    this.assertToolLive();
    return this.track(this.files.search(
      this.owner,
      this.terminalId,
      query,
      options,
      this.binding.root,
      this.authorization,
    ));
  }

  glob(pattern: string, options?: {
    path?: string;
    maxResults?: number;
    resultOffset?: number;
  }) {
    this.assertToolLive();
    return this.track(this.files.glob(
      this.owner,
      this.terminalId,
      pattern,
      options,
      this.binding.root,
      this.authorization,
    ));
  }

  stat(path: string) {
    this.assertToolLive();
    return this.track(this.files.statPath(
      this.owner,
      this.terminalId,
      path,
      this.binding.root,
      this.authorization,
    ));
  }

  mkdir(path: string) {
    this.assertToolLive();
    return this.track(this.files.mkdirPath(
      this.owner,
      this.terminalId,
      path,
      this.binding.root,
      this.authorization,
    ));
  }

  rename(source: string, destination: string) {
    this.assertToolLive();
    return this.track(this.files.renamePath(
      this.owner,
      this.terminalId,
      source,
      destination,
      this.binding.root,
      this.authorization,
    ));
  }

  delete(path: string, options?: { recursive?: boolean }) {
    this.assertToolLive();
    return this.track(this.files.deletePath(
      this.owner,
      this.terminalId,
      path,
      options,
      this.binding.root,
      this.authorization,
    ));
  }

  /** Wait until every operation dispatched through this Adapter has settled. */
  async waitForInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    const result = Promise.resolve(operation).then((value) => {
      this.assertToolLive();
      return value;
    });
    let settlement!: Promise<void>;
    settlement = result.then(
      () => { this.inFlight.delete(settlement); },
      () => { this.inFlight.delete(settlement); },
    );
    this.inFlight.add(settlement);
    return result;
  }

  private assertToolLive(): void {
    this.assertLive?.();
  }
}
