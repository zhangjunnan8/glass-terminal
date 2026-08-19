import { createHash, randomUUID } from 'node:crypto';
import * as iconv from 'iconv-lite';
import {
  link,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { posix } from 'node:path';
import type { WebContents } from 'electron';
import type {
  WorkspaceBinding,
  WorkspaceGlobResult,
  WorkspaceSearchResult,
  WorkspaceStatResult,
} from '../../shared/tools';
import { LocalFilesystemBackend } from '../filesystem/local-filesystem';
import {
  RemoteFilesystemProvider,
  type FilesystemBackend,
  type RemoteFilesystem,
  type RemoteFileStat,
} from '../filesystem/remote-filesystem';
import { createWorkspaceDiff } from '../filesystem/workspace-diff';
import {
  DEFAULT_WORKSPACE_TRAVERSAL_LIMITS,
  globWorkspace,
  searchWorkspace,
} from '../filesystem/workspace-operations';
import {
  assertSafeWindowsRequestedPath,
  assertSafeWindowsResolvedPath,
} from '../filesystem/workspace-path-security';
import type { SessionManager } from '../sessions/session-manager';
import type {
  WorkspaceDiffArtifact,
  WorkspaceOperation,
  WorkspaceOperationCanonicalPath,
  WorkspaceOperationEffect,
  WorkspaceOperationFailure,
  WorkspaceOperationHandle,
  WorkspaceOperationIntent,
  WorkspaceOperationOutcome,
  WorkspaceOperationSource,
} from '../sessions/workspace-operation-journal';
import type { TerminalService } from '../terminal/terminal-service';

const MAX_AGENT_FILE_BYTES = 512 * 1024;
const MAX_AGENT_DIRECTORY_ENTRIES = 500;
const MAX_PATCH_OPERATIONS = 64;
const MAX_AGENT_PATH_CHARS = 4_096;
const MAX_PATCH_INPUT_BYTES = 1024 * 1024;
const MAX_RECURSIVE_DELETE_DEPTH = 32;
const MAX_RECURSIVE_DELETE_ENTRIES = 10_000;
const MAX_RECURSIVE_DELETE_DURATION_MS = 10_000;
const AUDITED_MUTATIONS = new Set<WorkspaceOperation>([
  'write',
  'patch',
  'mkdir',
  'rename',
  'delete',
]);

export interface AgentFileReadResult {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
}

export interface AgentFileWriteResult {
  path: string;
  bytes: number;
  sha256: string;
  created: boolean;
  diff: string;
  additions: number;
  deletions: number;
  diffTruncated: boolean;
}

export interface AgentFileListEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
}

export interface AgentFilePatch {
  search: string;
  replace: string;
}

export interface AgentFileSearchOptions {
  path?: string;
  maxResults?: number;
}

export interface AgentFileDeleteOptions {
  recursive?: boolean;
}

export type AgentFilePolicyAuditTarget =
  | { path: string }
  | { source: string; destination: string };

export class WorkspaceOperationAuditPersistenceError extends Error {
  readonly code = 'WORKSPACE_AUDIT_OUTCOME_UNAVAILABLE';
  readonly retrySafe = false;

  constructor(
    readonly sideEffectCommitted: boolean | null,
    cause: unknown,
  ) {
    super(
      sideEffectCommitted === true
        ? 'Workspace side effect committed but audit outcome is unavailable; do not retry without re-reading.'
        : sideEffectCommitted === null
          ? 'Workspace side effect may have committed but audit outcome is unavailable; do not retry without re-reading.'
          : 'Workspace operation outcome audit is unavailable; retry is blocked until auditing recovers.',
      { cause },
    );
    this.name = 'WorkspaceOperationAuditPersistenceError';
  }
}

/**
 * Canonical path grants captured when a WorkspaceTool is bound to a turn.
 *
 * AgentFileService deliberately receives this snapshot on every operation so
 * direct/manual WorkspaceTool invocation cannot bypass the same path ranges
 * enforced by the ToolGateway. Omitted authorization preserves the legacy,
 * Workspace-Root-only boundary.
 */
export interface AgentFilePathAuthorization {
  readonly readablePaths: readonly string[];
  readonly writablePaths: readonly string[];
  readonly fullAccess: boolean;
  /** Turn-local main-process lease; never persisted or exposed to the model. */
  readonly assertLive?: () => void;
}

type AgentFileAccessRequirement = 'read' | 'write' | 'read-write';

interface NormalizedPathAuthorization {
  readablePaths: string[];
  writablePaths: string[];
  fullAccess: boolean;
  assertLive?: () => void;
}

type ResolvedTarget =
  | {
    transport: 'local';
    sessionId: string;
    /** Selected capability root, or the local volume/share root in Full Access. */
    root: string;
    workspaceRoot: string;
    requestedPath: string;
    authorization: NormalizedPathAuthorization;
  }
  | {
    transport: 'ssh';
    sessionId: string;
    /** Selected capability root, or POSIX / in Full Access. */
    root: string;
    workspaceRoot: string;
    requestedPath: string;
    hostId: string;
    authorization: NormalizedPathAuthorization;
  };

interface PreparedWorkspaceTarget {
  root: string;
  path: string;
  stat: RemoteFileStat | undefined;
}

interface DeletePlanOperation {
  path: string;
  type: 'file' | 'directory';
}

interface BoundWorkspaceSession {
  sessionId: string;
  transport: 'local' | 'ssh';
  hostId?: string;
  workspace: WorkspaceBinding;
}

interface OperationAuditTracker {
  readonly sessionId: string;
  intent: WorkspaceOperationIntent;
  handle?: WorkspaceOperationHandle;
  beginAttempted: boolean;
  finished: boolean;
  filesystemMutationStarted: boolean;
  cleanupFailed: boolean;
  targetDispatched: boolean;
  targetCommitted: boolean;
  confirmedCommits: number;
  plannedItems?: number;
  auditSuppressed: boolean;
  revokedBeforeIntent: boolean;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Detected text encoding of a workspace file. Windows 中文环境的文本文件大量为
 * ANSI/GBK 编码；读取时回退解码、写回时保持原编码，避免把 GBK 文件悄悄转成
 * UTF-8（那会让依赖代码页的解释器读乱码）。
 */
type TextFileEncoding = 'utf-8' | 'gb18030';

function decodeFileText(buffer: Buffer, label: string): { text: string; encoding: TextFileEncoding } {
  if (buffer.includes(0)) throw new Error(`${label} 不是受支持的文本文件。`);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    try {
      return { text: iconv.decode(buffer, 'gb18030'), encoding: 'gb18030' };
    } catch {
      throw new Error(`${label} 不是受支持的 UTF-8/GBK 文本文件。`);
    }
  }
}

function encodeFileText(text: string, encoding: TextFileEncoding): Buffer {
  if (text.includes('\0')) throw new Error('文件内容不能包含 NUL 字节。');
  const bytes = encoding === 'gb18030'
    ? iconv.encode(text, 'gb18030')
    : Buffer.from(text, 'utf8');
  if (bytes.length > MAX_AGENT_FILE_BYTES) {
    throw new Error(
      `单次文件写入为 ${bytes.length} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节限制；`
      + '请拆分为较小文件或使用精确补丁。',
    );
  }
  return bytes;
}

function boundedContent(content: string): Buffer {
  return encodeFileText(content, 'utf-8');
}

function assertBoundedPath(requestedPath: string): void {
  if (
    !requestedPath
    || requestedPath.includes('\0')
    || requestedPath.length > MAX_AGENT_PATH_CHARS
  ) throw new Error(`文件路径无效或超过 ${MAX_AGENT_PATH_CHARS} 字符限制。`);
}

function assertNoWindowsRootRelativePath(requestedPath: string): void {
  // `\foo` and `/foo` are rooted on whichever drive happens to be current;
  // unlike C:\foo or a UNC path they are not stable, fully qualified grants.
  if (/^[\\/](?![\\/])/u.test(requestedPath)) {
    throw new Error('文件路径不能使用 Windows 驱动器根相对形式。');
  }
}

function assertWithinRoot(root: string, target: string, platform: 'local' | 'ssh'): void {
  const relativePath = platform === 'ssh'
    ? posix.relative(root, target)
    : relative(root, target);
  if (
    relativePath === '..'
    || relativePath.startsWith(platform === 'ssh' ? '../' : `..${process.platform === 'win32' ? '\\' : '/'}`)
    || (platform === 'ssh' ? posix.isAbsolute(relativePath) : isAbsolute(relativePath))
  ) throw new Error('文件路径超出当前会话工作目录。');
}

function normalizedRemotePath(path: string): string {
  const normalized = posix.normalize(path);
  return normalized === '/' ? normalized : normalized.replace(/\/+$/u, '');
}

function assertBoundRootUnchanged(
  boundRoot: string,
  canonicalRoot: string,
  platform: 'local' | 'ssh',
): void {
  const bound = platform === 'ssh'
    ? normalizedRemotePath(boundRoot)
    : normalize(resolve(boundRoot));
  const canonical = platform === 'ssh'
    ? normalizedRemotePath(canonicalRoot)
    : normalize(resolve(canonicalRoot));
  const same = platform === 'local' && process.platform === 'win32'
    ? bound.toLocaleLowerCase('en-US') === canonical.toLocaleLowerCase('en-US')
    : bound === canonical;
  if (!same) throw new Error('绑定的文件访问根目录已被替换或重定向；请关闭后重新授权。');
}

function assertWorkspaceMatchesSession(
  transport: 'local' | 'ssh',
  hostId: string | undefined,
  workspace: WorkspaceBinding,
): void {
  if (transport === 'ssh') {
    if (workspace.backend !== 'sftp') {
      throw new Error('SSH Session 的 Workspace backend 必须是 sftp。');
    }
    if (!hostId || !workspace.hostId || workspace.hostId !== hostId) {
      throw new Error('SSH Terminal 与 Workspace 必须绑定到同一 Host。');
    }
    return;
  }
  if (workspace.backend !== 'local') {
    throw new Error('本地 Session 的 Workspace backend 必须是 local。');
  }
  if (workspace.hostId !== undefined) {
    throw new Error('本地 Workspace 不能绑定远程 Host。');
  }
}

function workspaceRootsMatch(
  configuredRoot: string,
  suppliedRoot: string,
  transport: 'local' | 'ssh',
): boolean {
  if (transport === 'ssh') {
    return normalizedRemotePath(configuredRoot) === normalizedRemotePath(suppliedRoot);
  }
  const configured = normalize(resolve(configuredRoot));
  const supplied = normalize(resolve(suppliedRoot));
  return process.platform === 'win32'
    ? configured.toLocaleLowerCase('en-US') === supplied.toLocaleLowerCase('en-US')
    : configured === supplied;
}

export class AgentFileService {
  constructor(
    private readonly terminals: TerminalService,
    private readonly sessions: SessionManager,
    private readonly remoteFilesystems = new RemoteFilesystemProvider(terminals),
    private readonly localFilesystem: FilesystemBackend = new LocalFilesystemBackend(),
  ) {}

  async bindWorkspaceRoot(owner: WebContents, terminalId: string): Promise<string> {
    const session = this.sessions.sessionForTerminal(owner, terminalId);
    if (!session) throw new Error('文件工具需要正式会话。');
    const workspace = session.workspace;
    if (!workspace) throw new Error('请先设置 Workspace Root。');
    assertWorkspaceMatchesSession(session.transport, session.hostId, workspace);
    if (session.transport === 'ssh') {
      if (!posix.isAbsolute(workspace.root)) {
        throw new Error('远程 Workspace Root 必须是绝对路径。');
      }
      return this.remoteFilesystems.withFilesystem(owner, terminalId, async (filesystem) => {
        const root = await filesystem.realpath(workspace.root);
        assertBoundRootUnchanged(workspace.root, root, 'ssh');
        const attributes = await filesystem.stat(root);
        if (attributes?.type !== 'directory') {
          throw new Error('Workspace Root 不是可访问的目录。');
        }
        return root;
      }, workspace.hostId);
    }
    if (process.platform === 'win32') assertSafeWindowsRequestedPath(workspace.root);
    if (!isAbsolute(workspace.root)) throw new Error('本地 Workspace Root 必须是绝对路径。');
    const root = await this.localFilesystem.realpath(workspace.root);
    assertBoundRootUnchanged(workspace.root, root, 'local');
    if ((await this.localFilesystem.stat(root))?.type !== 'directory') {
      throw new Error('Workspace Root 不是可访问的目录。');
    }
    return root;
  }

  /**
   * Canonicalize an existing directory for a later path grant while retaining
   * the owning Session/terminal/Host identity. This is intentionally separate
   * from normal Workspace operations: the path is not authorized until the
   * caller stores the returned canonical root in a permission snapshot.
   */
  async canonicalizeAccessRoot(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
  ): Promise<string> {
    assertBoundedPath(requestedPath);
    const { transport, hostId, workspace } = this.requireBoundWorkspace(owner, terminalId);
    if (transport === 'ssh') {
      if (!posix.isAbsolute(requestedPath)) {
        throw new Error('远程授权路径必须是绝对路径。');
      }
      const path = posix.normalize(requestedPath);
      return this.remoteFilesystems.withFilesystem(owner, terminalId, async (filesystem) => {
        const canonical = await filesystem.realpath(path);
        if (!posix.isAbsolute(canonical)) throw new Error('远程授权路径解析结果不是绝对路径。');
        if ((await filesystem.stat(canonical))?.type !== 'directory') {
          throw new Error('授权路径不是可访问的目录。');
        }
        return normalizedRemotePath(canonical);
      }, workspace.hostId ?? hostId);
    }
    if (process.platform === 'win32') {
      assertSafeWindowsRequestedPath(requestedPath);
      assertNoWindowsRootRelativePath(requestedPath);
    }
    if (!isAbsolute(requestedPath)) throw new Error('本地授权路径必须是绝对路径。');
    const canonical = await this.localFilesystem.realpath(resolve(requestedPath));
    if (!isAbsolute(canonical)) throw new Error('本地授权路径解析结果不是绝对路径。');
    if (process.platform === 'win32') {
      assertSafeWindowsRequestedPath(canonical);
      assertSafeWindowsResolvedPath(parse(canonical).root, canonical);
    }
    if ((await this.localFilesystem.stat(canonical))?.type !== 'directory') {
      throw new Error('授权路径不是可访问的目录。');
    }
    return normalize(canonical);
  }

  /** Main-process hook used only when PolicyWorkspaceTool rejects before delegation. */
  recordPolicyRejection(
    owner: WebContents,
    terminalId: string,
    operation: WorkspaceOperation,
    requestedTarget: AgentFilePolicyAuditTarget,
    workspaceRoot: string,
    authorization: AgentFilePathAuthorization,
    options: { recursive?: boolean } = {},
  ): void {
    const tracker = this.createAuditTracker(
      owner,
      terminalId,
      operation,
      requestedTarget,
      workspaceRoot,
      authorization,
      options,
    );
    if (tracker.auditSuppressed) return;
    this.beginOperationAudit(tracker, undefined, 'policy_workspace_tool');
    this.finishOperationAudit(tracker, {
      outcome: 'failed',
      sideEffectCommitted: false,
      failure: { code: 'permission', stage: 'prepare', retrySafe: true },
    });
  }

  async readText(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<AgentFileReadResult> {
    const tracker = this.createAuditTracker(
      owner,
      terminalId,
      'read',
      { path: requestedPath },
      workspaceRoot,
      authorization,
    );
    this.beginOperationAudit(tracker);
    let result: AgentFileReadResult;
    try {
      result = await this.readTextUnjournaled(
        owner,
        terminalId,
        requestedPath,
        workspaceRoot,
        authorization,
      );
    } catch (error) {
      return this.throwAfterFailedOperation(tracker, error);
    }
    this.finishSuccessfulOperation(tracker, { bytes: result.bytes });
    return result;
  }

  private async readTextUnjournaled(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<AgentFileReadResult> {
    const target = this.resolveTarget(
      owner,
      terminalId,
      requestedPath,
      workspaceRoot,
      authorization,
      'read',
    );
    if (target.transport === 'local') {
      const { root } = await this.prepareAccessRoots(this.localFilesystem, target);
      const path = await this.localFilesystem.realpath(target.requestedPath);
      assertWithinRoot(root, path, 'local');
      const attributes = await this.localFilesystem.stat(path);
      if (attributes?.type !== 'file') throw new Error('目标不是普通文件。');
      if (attributes.size > MAX_AGENT_FILE_BYTES) {
        throw new Error(`文件为 ${attributes.size} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节读取限制。`);
      }
      const buffer = await this.localFilesystem.readFile(path, MAX_AGENT_FILE_BYTES);
      if (buffer.length > MAX_AGENT_FILE_BYTES) {
        throw new Error(`文件读取结果为 ${buffer.length} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节限制。`);
      }
      const decoded = decodeFileText(buffer, path);
      return { path, content: decoded.text, bytes: buffer.length, sha256: sha256(buffer) };
    }
    return this.withRemoteFilesystem(owner, terminalId, target, async (filesystem) => {
      const { root } = await this.prepareAccessRoots(filesystem, target);
      const path = await filesystem.realpath(target.requestedPath);
      assertWithinRoot(root, path, 'ssh');
      const attributes = await filesystem.stat(path);
      if (attributes?.type !== 'file') throw new Error('目标不是普通文件。');
      if (attributes.size > MAX_AGENT_FILE_BYTES) {
        throw new Error(`文件为 ${attributes.size} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节读取限制。`);
      }
      const buffer = await filesystem.readFile(path, MAX_AGENT_FILE_BYTES);
      if (buffer.length > MAX_AGENT_FILE_BYTES) {
        throw new Error(`文件读取结果为 ${buffer.length} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节限制。`);
      }
      const decoded = decodeFileText(buffer, path);
      return { path, content: decoded.text, bytes: buffer.length, sha256: sha256(buffer) };
    });
  }

  async list(
    owner: WebContents,
    terminalId: string,
    requestedPath = '.',
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<{ path: string; entries: AgentFileListEntry[]; truncated: boolean }> {
    const tracker = this.createAuditTracker(
      owner,
      terminalId,
      'list',
      { path: requestedPath },
      workspaceRoot,
      authorization,
    );
    this.beginOperationAudit(tracker);
    let result: { path: string; entries: AgentFileListEntry[]; truncated: boolean };
    try {
      result = await this.listUnjournaled(
        owner,
        terminalId,
        requestedPath,
        workspaceRoot,
        authorization,
      );
    } catch (error) {
      return this.throwAfterFailedOperation(tracker, error);
    }
    this.finishSuccessfulOperation(tracker, {
      count: result.entries.length,
      truncated: result.truncated,
    });
    return result;
  }

  private async listUnjournaled(
    owner: WebContents,
    terminalId: string,
    requestedPath = '.',
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<{ path: string; entries: AgentFileListEntry[]; truncated: boolean }> {
    const target = this.resolveTarget(
      owner,
      terminalId,
      requestedPath,
      workspaceRoot,
      authorization,
      'read',
    );
    if (target.transport === 'local') {
      const { root } = await this.prepareAccessRoots(this.localFilesystem, target);
      const path = await this.localFilesystem.realpath(target.requestedPath);
      assertWithinRoot(root, path, 'local');
      const entries = await this.localFilesystem.listDirectory(path);
      const limited = entries.slice(0, MAX_AGENT_DIRECTORY_ENTRIES);
      const mapped = limited.map((entry) => ({
        name: entry.name,
        type: entry.stat.type,
        size: entry.stat.size,
      }));
      return { path, entries: mapped, truncated: entries.length > limited.length };
    }
    return this.withRemoteFilesystem(owner, terminalId, target, async (filesystem) => {
      const { root } = await this.prepareAccessRoots(filesystem, target);
      const path = await filesystem.realpath(target.requestedPath);
      assertWithinRoot(root, path, 'ssh');
      const entries = await filesystem.listDirectory(path);
      return {
        path,
        entries: entries.slice(0, MAX_AGENT_DIRECTORY_ENTRIES).map((entry) => ({
          name: entry.name,
          type: entry.stat.type,
          size: entry.stat.size,
        })),
        truncated: entries.length > MAX_AGENT_DIRECTORY_ENTRIES,
      };
    });
  }

  async statPath(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<WorkspaceStatResult> {
    const tracker = this.createAuditTracker(
      owner,
      terminalId,
      'stat',
      { path: requestedPath },
      workspaceRoot,
      authorization,
    );
    this.beginOperationAudit(tracker);
    let result: WorkspaceStatResult;
    try {
      result = await this.statPathUnjournaled(
        owner,
        terminalId,
        requestedPath,
        workspaceRoot,
        authorization,
      );
    } catch (error) {
      return this.throwAfterFailedOperation(tracker, error);
    }
    this.finishSuccessfulOperation(tracker, { bytes: result.size });
    return result;
  }

  private async statPathUnjournaled(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<WorkspaceStatResult> {
    const target = this.resolveTarget(
      owner,
      terminalId,
      requestedPath,
      workspaceRoot,
      authorization,
      'read',
    );
    if (target.transport === 'local') {
      const { root } = await this.prepareAccessRoots(this.localFilesystem, target);
      const path = workspaceRootsMatch(target.root, target.requestedPath, 'local')
        ? root
        : resolve(
          await this.localFilesystem.realpath(dirname(target.requestedPath)),
          basename(target.requestedPath),
        );
      assertWithinRoot(root, path, 'local');
      const attributes = await this.localFilesystem.lstat(path);
      if (!attributes) throw new Error(`文件或目录不存在：${requestedPath}`);
      return { path, ...attributes };
    }
    return this.withRemoteFilesystem(owner, terminalId, target, async (filesystem) => {
      const { root } = await this.prepareAccessRoots(filesystem, target);
      const path = workspaceRootsMatch(target.root, target.requestedPath, 'ssh')
        ? root
        : posix.join(
          await filesystem.realpath(posix.dirname(target.requestedPath)),
          posix.basename(target.requestedPath),
        );
      assertWithinRoot(root, path, 'ssh');
      const attributes = await filesystem.lstat(path);
      if (!attributes) throw new Error(`文件或目录不存在：${requestedPath}`);
      return { path, ...attributes };
    });
  }

  async writeText(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    content: string,
    expectedSha256: string | null,
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<AgentFileWriteResult> {
    const tracker = this.createAuditTracker(
      owner,
      terminalId,
      'write',
      { path: requestedPath },
      workspaceRoot,
      authorization,
    );
    let result: AgentFileWriteResult;
    try {
      result = await this.writeTextUnjournaled(
        owner,
        terminalId,
        requestedPath,
        content,
        expectedSha256,
        workspaceRoot,
        authorization,
        tracker,
      );
    } catch (error) {
      return this.throwAfterFailedOperation(tracker, error);
    }
    this.finishSuccessfulOperation(tracker, {
      afterSha256: result.sha256,
      bytes: result.bytes,
      created: result.created,
    });
    return result;
  }

  private async writeTextUnjournaled(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    content: string,
    expectedSha256: string | null,
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
    tracker?: OperationAuditTracker,
  ): Promise<AgentFileWriteResult> {
    let target = this.resolveTarget(
      owner,
      terminalId,
      requestedPath,
      workspaceRoot,
      authorization,
      'write',
    );
    this.assertProtectedMutationTarget(
      target.transport,
      target.workspaceRoot,
      target.requestedPath,
      target.sessionId,
    );
    if (target.transport === 'local') {
      let prepared = await this.prepareMutationTarget(this.localFilesystem, target);
      if (prepared.stat) {
        target = this.retargetForRequirement(target, 'read-write');
        prepared = await this.prepareMutationTarget(this.localFilesystem, target);
      }
      const path = prepared.path;
      const parent = dirname(path);
      // Do not read a destination that appeared after the authorized create
      // preflight. The exclusive publish below will reject that race without
      // turning create-only authority into implicit overwrite/read authority.
      const current = prepared.stat ? await this.optionalLocalFile(path) : undefined;
      this.assertExpectedHash(path, current?.content, expectedSha256);
      const currentDecoded = current ? decodeFileText(current.content, path) : undefined;
      const before = currentDecoded?.text;
      const bytes = currentDecoded
        ? encodeFileText(content, currentDecoded.encoding)
        : boundedContent(content);
      const diff = createWorkspaceDiff(this.safeDiffLabel(target, path), before, content);
      if (!tracker) throw new Error('Workspace write is missing its audit tracker.');
      tracker.intent = {
        ...tracker.intent,
        target: { path: this.auditPathForTarget(target, path) },
        expected: {
          exists: current !== undefined,
          type: 'file',
          ...(expectedSha256 === null ? {} : { sha256: expectedSha256.toLowerCase() }),
        },
      };
      this.assertMutationLive(target, tracker);
      this.beginOperationAudit(tracker, {
        body: diff.diff,
        additions: diff.additions,
        deletions: diff.deletions,
        truncated: diff.diffTruncated,
      });
      const temporary = resolve(parent, `.ai-terminal-${randomUUID()}.tmp`);
      try {
        this.assertMutationLive(target, tracker);
        tracker.filesystemMutationStarted = true;
        await this.writeLocalTemporary(
          temporary,
          bytes,
          current?.mode ?? 0o600,
        );
        if (current) {
          const latest = await this.optionalLocalFile(path);
          this.assertExpectedHash(path, latest?.content, expectedSha256);
          this.assertMutationLive(target, tracker);
          tracker.targetDispatched = true;
          await this.publishLocalOverwrite(temporary, path);
          tracker.targetCommitted = true;
          tracker.confirmedCommits = 1;
        } else {
          // link() publishes the fully written inode only if the destination
          // is still absent, preserving the expectedSha256:null contract.
          this.assertMutationLive(target, tracker);
          tracker.targetDispatched = true;
          await this.publishLocalCreate(temporary, path);
          tracker.targetCommitted = true;
          tracker.confirmedCommits = 1;
          try {
            await this.removeLocalTemporary(temporary);
          } catch (error) {
            tracker.cleanupFailed = true;
            throw error;
          }
        }
      } catch (error) {
        try {
          await this.removeLocalTemporary(temporary);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            tracker.cleanupFailed = true;
          }
        }
        throw error;
      }
      return {
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
        created: current === undefined,
        ...diff,
      };
    }
    if (!tracker) throw new Error('Workspace write is missing its audit tracker.');
    return this.withRemoteFilesystem(owner, terminalId, target, (filesystem) => (
      this.writeRemoteText(filesystem, target, content, expectedSha256, tracker)
    ));
  }

  private writeLocalTemporary(path: string, bytes: Buffer, mode: number): Promise<void> {
    return writeFile(path, bytes, { mode, flag: 'wx' });
  }

  private publishLocalCreate(temporary: string, path: string): Promise<void> {
    return link(temporary, path);
  }

  private publishLocalOverwrite(temporary: string, path: string): Promise<void> {
    return rename(temporary, path);
  }

  private removeLocalTemporary(path: string): Promise<void> {
    return unlink(path);
  }

  async applyPatch(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    expectedSha256: string,
    patches: AgentFilePatch[],
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<AgentFileWriteResult> {
    const tracker = this.createAuditTracker(
      owner,
      terminalId,
      'patch',
      { path: requestedPath },
      workspaceRoot,
      authorization,
    );
    let result: AgentFileWriteResult;
    try {
      result = await this.applyPatchUnjournaled(
        owner,
        terminalId,
        requestedPath,
        expectedSha256,
        patches,
        workspaceRoot,
        authorization,
        tracker,
      );
    } catch (error) {
      return this.throwAfterFailedOperation(tracker, error);
    }
    this.finishSuccessfulOperation(tracker, {
      afterSha256: result.sha256,
      bytes: result.bytes,
      created: result.created,
    });
    return result;
  }

  private async applyPatchUnjournaled(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    expectedSha256: string,
    patches: AgentFilePatch[],
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
    tracker?: OperationAuditTracker,
  ): Promise<AgentFileWriteResult> {
    this.assertPatchInput(patches);
    const target = this.resolveTarget(
      owner,
      terminalId,
      requestedPath,
      workspaceRoot,
      authorization,
      'read-write',
    );
    this.assertProtectedMutationTarget(
      target.transport,
      target.workspaceRoot,
      target.requestedPath,
      target.sessionId,
    );
    if (target.transport === 'local') {
      const current = await this.readTextUnjournaled(
        owner,
        terminalId,
        requestedPath,
        workspaceRoot,
        authorization,
      );
      if (current.sha256 !== expectedSha256) {
        throw new Error('文件已变化；请重新读取后再应用补丁。');
      }
      const next = this.applyExactPatches(current.content, patches);
      return this.writeTextUnjournaled(
        owner,
        terminalId,
        requestedPath,
        next,
        expectedSha256,
        workspaceRoot,
        authorization,
        tracker,
      );
    }
    return this.withRemoteFilesystem(owner, terminalId, target, async (filesystem) => {
      const current = await this.readRemoteText(filesystem, target);
      if (current.sha256 !== expectedSha256) {
        throw new Error('文件已变化；请重新读取后再应用补丁。');
      }
      const next = this.applyExactPatches(current.content, patches);
      return this.writeRemoteText(
        filesystem,
        target,
        next,
        expectedSha256,
        tracker!,
      );
    });
  }

  async search(
    owner: WebContents,
    terminalId: string,
    query: string,
    options: AgentFileSearchOptions = {},
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<WorkspaceSearchResult> {
    const tracker = this.createAuditTracker(
      owner,
      terminalId,
      'search',
      { path: options.path ?? '.' },
      workspaceRoot,
      authorization,
    );
    this.beginOperationAudit(tracker);
    let result: WorkspaceSearchResult;
    try {
      result = await this.searchUnjournaled(
        owner,
        terminalId,
        query,
        options,
        workspaceRoot,
        authorization,
      );
    } catch (error) {
      return this.throwAfterFailedOperation(tracker, error);
    }
    this.finishSuccessfulOperation(tracker, {
      count: result.matches.length,
      truncated: result.truncated,
    });
    return result;
  }

  private async searchUnjournaled(
    owner: WebContents,
    terminalId: string,
    query: string,
    options: AgentFileSearchOptions = {},
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<WorkspaceSearchResult> {
    const target = this.resolveTarget(
      owner,
      terminalId,
      options.path ?? '.',
      workspaceRoot,
      authorization,
      'read',
    );
    return this.withTargetFilesystem(owner, terminalId, target, async (filesystem) => {
      const prepared = await this.prepareTraversalTarget(filesystem, target);
      return searchWorkspace(
        filesystem,
        target.transport,
        prepared.root,
        prepared.path,
        query,
        { maxResults: options.maxResults },
      );
    });
  }

  async glob(
    owner: WebContents,
    terminalId: string,
    pattern: string,
    options: AgentFileSearchOptions = {},
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<WorkspaceGlobResult> {
    const tracker = this.createAuditTracker(
      owner,
      terminalId,
      'glob',
      { path: options.path ?? '.' },
      workspaceRoot,
      authorization,
    );
    this.beginOperationAudit(tracker);
    let result: WorkspaceGlobResult;
    try {
      result = await this.globUnjournaled(
        owner,
        terminalId,
        pattern,
        options,
        workspaceRoot,
        authorization,
      );
    } catch (error) {
      return this.throwAfterFailedOperation(tracker, error);
    }
    this.finishSuccessfulOperation(tracker, {
      count: result.paths.length,
      truncated: result.truncated,
    });
    return result;
  }

  private async globUnjournaled(
    owner: WebContents,
    terminalId: string,
    pattern: string,
    options: AgentFileSearchOptions = {},
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<WorkspaceGlobResult> {
    const target = this.resolveTarget(
      owner,
      terminalId,
      options.path ?? '.',
      workspaceRoot,
      authorization,
      'read',
    );
    return this.withTargetFilesystem(owner, terminalId, target, async (filesystem) => {
      const prepared = await this.prepareTraversalTarget(filesystem, target);
      if (prepared.stat.type !== 'directory') throw new Error('Glob 起点必须是目录。');
      return globWorkspace(
        filesystem,
        target.transport,
        prepared.root,
        prepared.path,
        pattern,
        { maxResults: options.maxResults },
      );
    });
  }

  async mkdirPath(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<void> {
    const tracker = this.createAuditTracker(
      owner,
      terminalId,
      'mkdir',
      { path: requestedPath },
      workspaceRoot,
      authorization,
    );
    try {
      const target = this.resolveTarget(
        owner,
        terminalId,
        requestedPath,
        workspaceRoot,
        authorization,
        'write',
      );
      await this.withTargetFilesystem(owner, terminalId, target, async (filesystem) => {
        const prepared = await this.prepareMutationTarget(filesystem, target);
        if (prepared.stat) throw new Error('目录或文件已存在。');
        tracker.intent = {
          ...tracker.intent,
          target: { path: this.auditPathForTarget(target, prepared.path) },
          expected: { exists: false },
        };
        this.assertMutationLive(target, tracker);
        this.beginOperationAudit(tracker);
        this.assertMutationLive(target, tracker);
        tracker.filesystemMutationStarted = true;
        tracker.targetDispatched = true;
        await filesystem.mkdir(prepared.path, 0o700);
        tracker.targetCommitted = true;
        tracker.confirmedCommits = 1;
      });
    } catch (error) {
      return this.throwAfterFailedOperation(tracker, error);
    }
    this.finishSuccessfulOperation(tracker);
  }

  async renamePath(
    owner: WebContents,
    terminalId: string,
    source: string,
    destination: string,
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<void> {
    const tracker = this.createAuditTracker(
      owner,
      terminalId,
      'rename',
      { source, destination },
      workspaceRoot,
      authorization,
    );
    try {
      const sourceTarget = this.resolveTarget(
        owner,
        terminalId,
        source,
        workspaceRoot,
        authorization,
        'write',
      );
      const destinationTarget = this.resolveTarget(
        owner,
        terminalId,
        destination,
        workspaceRoot,
        authorization,
        'write',
      );
      this.assertSameTargetWorkspace(sourceTarget, destinationTarget);
      await this.withTargetFilesystem(owner, terminalId, sourceTarget, async (filesystem) => {
        const preparedSource = await this.prepareMutationTarget(filesystem, sourceTarget);
        if (!preparedSource.stat) throw new Error('重命名源不存在。');
        if (preparedSource.stat.type === 'symlink') {
          throw new Error('不允许重命名符号链接。');
        }
        const preparedDestination = await this.prepareMutationTarget(filesystem, destinationTarget);
        if (preparedDestination.stat) throw new Error('重命名目标已存在。');
        if (
          preparedSource.stat.type === 'directory'
          && this.pathIsWithin(
            sourceTarget.transport,
            preparedSource.path,
            preparedDestination.path,
          )
        ) throw new Error('不能将目录重命名到它自身内部。');
        tracker.intent = {
          ...tracker.intent,
          target: {
            source: this.auditPathForTarget(sourceTarget, preparedSource.path),
            destination: this.auditPathForTarget(destinationTarget, preparedDestination.path),
          },
          expected: {
            exists: true,
            ...(preparedSource.stat.type === 'directory' || preparedSource.stat.type === 'file'
              ? { type: preparedSource.stat.type }
              : {}),
          },
        };
        this.assertMutationLive(sourceTarget, tracker);
        this.assertMutationLive(destinationTarget, tracker);
        this.beginOperationAudit(tracker);
        this.assertMutationLive(sourceTarget, tracker);
        this.assertMutationLive(destinationTarget, tracker);
        tracker.filesystemMutationStarted = true;
        tracker.targetDispatched = true;
        await filesystem.rename(preparedSource.path, preparedDestination.path);
        tracker.targetCommitted = true;
        tracker.confirmedCommits = 1;
      });
    } catch (error) {
      return this.throwAfterFailedOperation(tracker, error);
    }
    this.finishSuccessfulOperation(tracker);
  }

  async deletePath(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    options: AgentFileDeleteOptions = {},
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
  ): Promise<void> {
    const tracker = this.createAuditTracker(
      owner,
      terminalId,
      'delete',
      { path: requestedPath },
      workspaceRoot,
      authorization,
      { recursive: options.recursive },
    );
    try {
      const target = this.resolveTarget(
        owner,
        terminalId,
        requestedPath,
        workspaceRoot,
        authorization,
        'write',
      );
      await this.withTargetFilesystem(owner, terminalId, target, async (filesystem) => {
        const prepared = await this.prepareMutationTarget(filesystem, target);
        if (!prepared.stat) throw new Error('删除目标不存在。');
        tracker.intent = {
          ...tracker.intent,
          target: { path: this.auditPathForTarget(target, prepared.path) },
          expected: {
            exists: true,
            ...(prepared.stat.type === 'directory' || prepared.stat.type === 'file'
              ? { type: prepared.stat.type }
              : {}),
          },
        };
        if (prepared.stat.type !== 'directory') {
          this.assertMutationLive(target, tracker);
          this.beginOperationAudit(tracker);
          this.assertMutationLive(target, tracker);
          tracker.filesystemMutationStarted = true;
          tracker.targetDispatched = true;
          await filesystem.unlink(prepared.path);
          tracker.targetCommitted = true;
          tracker.confirmedCommits = 1;
          return;
        }
        if (!options.recursive) {
          this.assertMutationLive(target, tracker);
          this.beginOperationAudit(tracker);
          this.assertMutationLive(target, tracker);
          tracker.filesystemMutationStarted = true;
          tracker.targetDispatched = true;
          await filesystem.rmdir(prepared.path);
          tracker.targetCommitted = true;
          tracker.confirmedCommits = 1;
          return;
        }
        const plan = await this.preflightRecursiveDelete(
          filesystem,
          target.transport,
          prepared.root,
          prepared.path,
        );
        tracker.plannedItems = plan.length;
        tracker.intent = { ...tracker.intent, plan: { items: plan.length } };
        this.assertMutationLive(target, tracker);
        this.beginOperationAudit(tracker);
        for (const operation of plan) {
          await this.revalidateDeleteOperation(
            filesystem,
            target.transport,
            prepared.root,
            operation,
          );
          this.assertMutationLive(target, tracker);
          tracker.filesystemMutationStarted = true;
          tracker.targetDispatched = true;
          if (operation.type === 'directory') await filesystem.rmdir(operation.path);
          else await filesystem.unlink(operation.path);
          tracker.targetCommitted = true;
          tracker.confirmedCommits += 1;
        }
      });
    } catch (error) {
      return this.throwAfterFailedOperation(tracker, error);
    }
    this.finishSuccessfulOperation(
      tracker,
      tracker.plannedItems === undefined
        ? undefined
        : {
            itemsPlanned: tracker.plannedItems,
            itemsCommitted: tracker.confirmedCommits,
          },
    );
  }

  private assertPatchInput(patches: AgentFilePatch[]): void {
    if (!patches.length || patches.length > MAX_PATCH_OPERATIONS) {
      throw new Error(`补丁操作数量必须为 1-${MAX_PATCH_OPERATIONS}。`);
    }
    const patchBytes = patches.reduce((total, patch) => (
      total + Buffer.byteLength(patch.search, 'utf8') + Buffer.byteLength(patch.replace, 'utf8')
    ), 0);
    if (patchBytes > MAX_PATCH_INPUT_BYTES) {
      throw new Error(`补丁文本超过 ${MAX_PATCH_INPUT_BYTES} 字节限制。`);
    }
  }

  private applyExactPatches(content: string, patches: AgentFilePatch[]): string {
    let next = content;
    for (const patch of patches) {
      if (!patch.search) throw new Error('补丁 search 不能为空。');
      const first = next.indexOf(patch.search);
      if (first < 0) throw new Error('补丁 search 未在文件中找到。');
      if (next.indexOf(patch.search, first + patch.search.length) >= 0) {
        throw new Error('补丁 search 在文件中不唯一；请提供更多上下文。');
      }
      next = `${next.slice(0, first)}${patch.replace}${next.slice(first + patch.search.length)}`;
    }
    return next;
  }

  private async readRemoteText(
    filesystem: RemoteFilesystem,
    target: Extract<ResolvedTarget, { transport: 'ssh' }>,
  ): Promise<AgentFileReadResult> {
    const { root } = await this.prepareAccessRoots(filesystem, target);
    const path = await filesystem.realpath(target.requestedPath);
    assertWithinRoot(root, path, 'ssh');
    const attributes = await filesystem.stat(path);
    if (attributes?.type !== 'file') throw new Error('目标不是普通文件。');
    if (attributes.size > MAX_AGENT_FILE_BYTES) {
      throw new Error(`文件为 ${attributes.size} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节读取限制。`);
    }
    const buffer = await filesystem.readFile(path, MAX_AGENT_FILE_BYTES);
    return {
      path,
      content: decodeFileText(buffer, path).text,
      bytes: buffer.length,
      sha256: sha256(buffer),
    };
  }

  private async writeRemoteText(
    filesystem: RemoteFilesystem,
    initialTarget: Extract<ResolvedTarget, { transport: 'ssh' }>,
    content: string,
    expectedSha256: string | null,
    tracker: OperationAuditTracker,
  ): Promise<AgentFileWriteResult> {
    let target = initialTarget;
    let prepared = await this.prepareMutationTarget(filesystem, target);
    if (prepared.stat) {
      target = this.retargetForRequirement(target, 'read-write');
      prepared = await this.prepareMutationTarget(filesystem, target);
    }
    const attributes = prepared.stat;
    if (attributes?.type === 'symlink') throw new Error('不允许通过符号链接覆盖文件。');
    if (attributes && attributes.type !== 'file') throw new Error('目标不是普通文件。');
    if (attributes && attributes.size > MAX_AGENT_FILE_BYTES) {
      throw new Error(`文件为 ${attributes.size} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节写入限制。`);
    }
    const current = attributes
      ? await filesystem.readFile(prepared.path, MAX_AGENT_FILE_BYTES)
      : undefined;
    this.assertExpectedHash(prepared.path, current, expectedSha256);
    const currentDecoded = current ? decodeFileText(current, prepared.path) : undefined;
    const before = currentDecoded?.text;
    const bytes = currentDecoded
      ? encodeFileText(content, currentDecoded.encoding)
      : boundedContent(content);
    const diff = createWorkspaceDiff(this.safeDiffLabel(target, prepared.path), before, content);
    tracker.intent = {
      ...tracker.intent,
      target: { path: this.auditPathForTarget(target, prepared.path) },
      expected: {
        exists: current !== undefined,
        type: 'file',
        ...(expectedSha256 === null ? {} : { sha256: expectedSha256.toLowerCase() }),
      },
    };
    this.assertMutationLive(target, tracker);
    this.beginOperationAudit(tracker, {
      body: diff.diff,
      additions: diff.additions,
      deletions: diff.deletions,
      truncated: diff.diffTruncated,
    });
    const parent = posix.dirname(prepared.path);
    const temporary = posix.join(parent, `.ai-terminal-${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      this.assertMutationLive(target, tracker);
      tracker.filesystemMutationStarted = true;
      await filesystem.writeFile(temporary, bytes, attributes?.mode, true);
      temporaryCreated = true;
      if (attributes) {
        const latestStat = await filesystem.lstat(prepared.path);
        if (latestStat?.type !== 'file' || latestStat.size > MAX_AGENT_FILE_BYTES) {
          throw new Error('文件已在写入期间变化；请重新读取。');
        }
        const latest = await filesystem.readFile(prepared.path, MAX_AGENT_FILE_BYTES);
        this.assertExpectedHash(prepared.path, latest, expectedSha256);
        // SFTP has no portable compare-and-swap rename. This second hash check
        // narrows (but cannot eliminate) the remaining check-to-rename race.
        this.assertMutationLive(target, tracker);
        tracker.targetDispatched = true;
        await filesystem.atomicReplace(temporary, prepared.path);
        tracker.targetCommitted = true;
        tracker.confirmedCommits = 1;
      } else {
        // Recheck absence immediately before rename. Standard SFTP rename can
        // still race another creator because no no-replace extension is portable.
        if (await filesystem.lstat(prepared.path)) {
          throw new Error('文件已在写入期间创建；请重新读取。');
        }
        this.assertMutationLive(target, tracker);
        tracker.targetDispatched = true;
        await filesystem.rename(temporary, prepared.path);
        tracker.targetCommitted = true;
        tracker.confirmedCommits = 1;
      }
    } catch (error) {
      try {
        if (temporaryCreated || await filesystem.lstat(temporary)) {
          await filesystem.unlink(temporary);
        }
      } catch {
        tracker.cleanupFailed = true;
      }
      throw error;
    }
    return {
      path: prepared.path,
      bytes: bytes.length,
      sha256: sha256(bytes),
      created: current === undefined,
      ...diff,
    };
  }

  private createAuditTracker(
    owner: WebContents,
    terminalId: string,
    operation: WorkspaceOperation,
    requestedTarget: AgentFilePolicyAuditTarget,
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
    options: { recursive?: boolean; planItems?: number } = {},
  ): OperationAuditTracker {
    const session = this.requireBoundWorkspace(owner, terminalId);
    if (
      workspaceRoot !== undefined
      && !workspaceRootsMatch(session.workspace.root, workspaceRoot, session.transport)
    ) throw new Error('显式 Workspace Root 与 Session 绑定的 Workspace Root 不一致。');
    const boundRoot = workspaceRoot ?? session.workspace.root;
    let auditSuppressed = false;
    const auditPath = (requestedPath: string): WorkspaceOperationCanonicalPath => {
      if (AUDITED_MUTATIONS.has(operation)) {
        const relationship = this.protectedStorageRelationshipForRequest(
          session,
          boundRoot,
          requestedPath,
        );
        if (relationship.protected) {
          auditSuppressed ||= relationship.selfTargeting;
          return this.rejectedAuditPath(requestedPath);
        }
      }
      const coordinate = this.safeAuditPathForRequest(
        session,
        boundRoot,
        requestedPath,
        authorization,
      );
      // Workspace and filesystem roots are protected mutation targets, but
      // the journal deliberately rejects `.` for those scopes because a
      // successful mutation must never address either root. Preserve an audit
      // trail for the prepare-time denial without admitting an impossible
      // canonical mutation coordinate.
      if (
        AUDITED_MUTATIONS.has(operation)
        && coordinate.scope !== 'rejected'
        && coordinate.path === '.'
        && (coordinate.scope === 'workspace' || coordinate.scope === 'filesystem')
      ) return this.rejectedAuditPath(requestedPath);
      return coordinate;
    };
    const target = 'path' in requestedTarget
      ? {
          path: auditPath(requestedTarget.path),
        }
      : {
          source: auditPath(requestedTarget.source),
          destination: auditPath(requestedTarget.destination),
        };
    const intent: WorkspaceOperationIntent = {
      operation,
      backend: session.transport === 'ssh' ? 'sftp' : 'local',
      target,
      ...(operation === 'delete' && options.recursive !== undefined
        ? { recursive: options.recursive }
        : {}),
      ...(operation === 'delete' && options.planItems !== undefined
        ? { plan: { items: options.planItems } }
        : {}),
    };
    return {
      sessionId: session.sessionId,
      intent,
      beginAttempted: false,
      finished: false,
      filesystemMutationStarted: false,
      cleanupFailed: false,
      targetDispatched: false,
      targetCommitted: false,
      confirmedCommits: 0,
      auditSuppressed,
      revokedBeforeIntent: false,
      ...(options.planItems === undefined ? {} : { plannedItems: options.planItems }),
    };
  }

  private auditPathForRequest(
    session: BoundWorkspaceSession,
    workspaceRoot: string,
    requestedPath: string,
    authorization?: AgentFilePathAuthorization,
  ): WorkspaceOperationCanonicalPath {
    assertBoundedPath(requestedPath);
    if (session.transport === 'ssh') {
      const canonicalWorkspace = posix.normalize(workspaceRoot);
      if (!posix.isAbsolute(canonicalWorkspace)) {
        throw new Error('远程 Workspace Root 必须是绝对路径。');
      }
      const path = posix.resolve(canonicalWorkspace, requestedPath);
      const normalizedAuthorization = this.normalizeAuthorization(
        'ssh',
        canonicalWorkspace,
        authorization,
      );
      return this.auditPathForAbsolute(
        'ssh',
        canonicalWorkspace,
        path,
        normalizedAuthorization,
      );
    }
    const canonicalWorkspace = this.resolveLocalRequestedPath(workspaceRoot, '.');
    const path = this.resolveLocalRequestedPath(canonicalWorkspace, requestedPath);
    const normalizedAuthorization = this.normalizeAuthorization(
      'local',
      canonicalWorkspace,
      authorization,
    );
    if (process.platform === 'win32') {
      assertSafeWindowsResolvedPath(parse(path).root, path);
    }
    return this.auditPathForAbsolute(
      'local',
      canonicalWorkspace,
      path,
      normalizedAuthorization,
    );
  }

  private safeAuditPathForRequest(
    session: BoundWorkspaceSession,
    workspaceRoot: string,
    requestedPath: string,
    authorization?: AgentFilePathAuthorization,
  ): WorkspaceOperationCanonicalPath {
    try {
      return this.auditPathForRequest(session, workspaceRoot, requestedPath, authorization);
    } catch {
      return this.rejectedAuditPath(requestedPath);
    }
  }

  private rejectedAuditPath(requestedPath: string): WorkspaceOperationCanonicalPath {
    const boundedPrefix = typeof requestedPath === 'string'
      ? requestedPath.slice(0, MAX_AGENT_PATH_CHARS)
      : String(requestedPath).slice(0, MAX_AGENT_PATH_CHARS);
    const length = typeof requestedPath === 'string' ? requestedPath.length : -1;
    return {
      scope: 'rejected',
      pathHash: sha256(`${length}\0${boundedPrefix}`),
    };
  }

  private resolveLocalRequestedPath(workspaceRoot: string, requestedPath: string): string {
    assertBoundedPath(requestedPath);
    if (process.platform === 'win32') {
      assertSafeWindowsRequestedPath(workspaceRoot);
      assertNoWindowsRootRelativePath(workspaceRoot);
      assertSafeWindowsRequestedPath(requestedPath);
      assertNoWindowsRootRelativePath(requestedPath);
    }
    if (!isAbsolute(workspaceRoot)) throw new Error('本地 Workspace Root 必须是绝对路径。');
    const path = resolve(workspaceRoot, requestedPath);
    if (process.platform === 'win32') {
      assertSafeWindowsResolvedPath(parse(path).root, path);
    }
    return path;
  }

  private protectedStorageRelationshipForRequest(
    session: BoundWorkspaceSession,
    workspaceRoot: string,
    requestedPath: string,
  ): { protected: boolean; selfTargeting: boolean } {
    if (session.transport === 'ssh') return { protected: false, selfTargeting: false };
    try {
      const path = this.resolveLocalRequestedPath(workspaceRoot, requestedPath);
      return this.protectedStorageRelationship(session.sessionId, path);
    } catch {
      return { protected: false, selfTargeting: false };
    }
  }

  private protectedStorageRelationship(
    sessionId: string,
    candidate: string,
  ): { protected: boolean; selfTargeting: boolean } {
    const protection = this.sessions.workspaceStorageProtection(sessionId);
    if (!isAbsolute(protection.root) || !isAbsolute(protection.operationJournalPath)) {
      throw new Error('Session storage protection paths must be absolute.');
    }
    const root = resolve(protection.root);
    const journal = resolve(protection.operationJournalPath);
    if (!this.pathIsWithin('local', root, journal)) {
      throw new Error('Session operation journal is outside its protected storage root.');
    }
    const currentAuditRoot = dirname(journal);
    const path = resolve(candidate);
    return {
      protected: this.pathIsWithin('local', root, path)
        || this.pathIsWithin('local', path, root),
      // Loading/appending the journal may create, chmod, validate, or clean
      // operations.jsonl and diffs/. Never audit a denial into the same
      // current-Session audit subtree (or one of its ancestors).
      selfTargeting: this.pathIsWithin('local', currentAuditRoot, path)
        || this.pathIsWithin('local', path, currentAuditRoot),
    };
  }

  private auditPathForTarget(
    target: ResolvedTarget,
    path = target.requestedPath,
  ): WorkspaceOperationCanonicalPath {
    return this.auditPathForAbsolute(
      target.transport,
      target.workspaceRoot,
      path,
      target.authorization,
      target.root,
    );
  }

  private auditPathForAbsolute(
    flavor: 'local' | 'ssh',
    workspaceRoot: string,
    path: string,
    authorization: NormalizedPathAuthorization,
    selectedRoot?: string,
  ): WorkspaceOperationCanonicalPath {
    if (this.pathIsWithin(flavor, workspaceRoot, path)) {
      return {
        scope: 'workspace',
        path: this.canonicalRelativeAuditLabel(flavor, workspaceRoot, path),
      };
    }
    let scope: 'authorized' | 'filesystem';
    let root: string;
    if (authorization.fullAccess) {
      scope = 'filesystem';
      root = flavor === 'ssh' ? '/' : normalize(parse(path).root);
    } else {
      const candidates = [
        ...(selectedRoot ? [selectedRoot] : []),
        ...authorization.readablePaths,
        ...authorization.writablePaths,
      ].filter((candidate, index, values) => (
        values.indexOf(candidate) === index && this.pathIsWithin(flavor, candidate, path)
      ));
      candidates.sort((left, right) => right.length - left.length);
      if (candidates.length) {
        scope = 'authorized';
        root = candidates[0]!;
      } else {
        scope = 'filesystem';
        root = flavor === 'ssh' ? '/' : normalize(parse(path).root);
      }
    }
    if (!root || !this.pathIsWithin(flavor, root, path)) {
      throw new Error('无法为 Workspace 操作生成安全审计坐标。');
    }
    return {
      scope,
      rootId: sha256(`${flavor}\0${root}`),
      path: this.canonicalRelativeAuditLabel(flavor, root, path),
    };
  }

  private canonicalRelativeAuditLabel(
    flavor: 'local' | 'ssh',
    root: string,
    path: string,
  ): string {
    const label = flavor === 'ssh' ? posix.relative(root, path) : relative(root, path);
    if (
      label === '..'
      || label.startsWith(flavor === 'ssh' ? '../' : `..${sep}`)
      || (flavor === 'ssh' ? posix.isAbsolute(label) : isAbsolute(label))
    ) throw new Error('无法为 Workspace 操作生成相对审计路径。');
    if (!label) return '.';
    return flavor === 'local' ? label.split(sep).join('/') : label;
  }

  private safeDiffLabel(target: ResolvedTarget, path = target.requestedPath): string {
    const coordinate = this.auditPathForTarget(target, path);
    if (coordinate.scope === 'rejected') {
      throw new Error('Resolved Workspace target cannot use a rejected audit coordinate.');
    }
    if (coordinate.scope === 'workspace') return `workspace/${coordinate.path}`;
    return `${coordinate.scope}/${coordinate.rootId!.slice(0, 16)}/${coordinate.path}`;
  }

  private beginOperationAudit(
    tracker: OperationAuditTracker,
    diff?: WorkspaceDiffArtifact,
    source: WorkspaceOperationSource = 'agent_file_service',
  ): void {
    tracker.beginAttempted = true;
    tracker.handle = this.sessions.beginWorkspaceOperation(
      tracker.sessionId,
      tracker.intent,
      diff,
      source,
    );
  }

  private finishOperationAudit(
    tracker: OperationAuditTracker,
    outcome: WorkspaceOperationOutcome,
  ): void {
    if (!tracker.handle) throw new Error('Workspace operation audit has no durable intent.');
    this.sessions.finishWorkspaceOperation(tracker.handle, outcome);
    tracker.finished = true;
  }

  private finishSuccessfulOperation(
    tracker: OperationAuditTracker,
    effect?: WorkspaceOperationEffect,
  ): void {
    const sideEffectCommitted = AUDITED_MUTATIONS.has(tracker.intent.operation);
    try {
      this.finishOperationAudit(tracker, {
        outcome: 'succeeded',
        sideEffectCommitted,
        ...(effect === undefined ? {} : { effect }),
      });
    } catch (error) {
      throw new WorkspaceOperationAuditPersistenceError(sideEffectCommitted, error);
    }
  }

  private throwAfterFailedOperation(
    tracker: OperationAuditTracker,
    error: unknown,
  ): never {
    if (tracker.revokedBeforeIntent && !tracker.handle) throw error;
    if (tracker.auditSuppressed && !tracker.handle) throw error;
    if (!tracker.handle) {
      if (tracker.beginAttempted) throw error;
      this.beginOperationAudit(tracker);
    }
    const sideEffectCommitted = tracker.targetCommitted || tracker.confirmedCommits > 0
      ? true
      : tracker.intent.backend === 'sftp' && tracker.targetDispatched
        ? null
        : false;
    const stage = tracker.cleanupFailed
      ? 'cleanup'
      : tracker.targetDispatched || tracker.targetCommitted
        ? 'commit'
      : tracker.filesystemMutationStarted
        ? 'dispatch'
        : 'prepare';
    const effect = tracker.plannedItems === undefined
      ? undefined
      : {
          itemsPlanned: tracker.plannedItems,
          itemsCommitted: tracker.confirmedCommits,
        };
    try {
      this.finishOperationAudit(tracker, {
        outcome: 'failed',
        sideEffectCommitted,
        ...(effect === undefined ? {} : { effect }),
        failure: {
          code: this.safeFailureCode(error),
          stage,
          retrySafe: sideEffectCommitted === false && !tracker.cleanupFailed,
        },
      });
    } catch (auditError) {
      throw new WorkspaceOperationAuditPersistenceError(sideEffectCommitted, auditError);
    }
    throw error;
  }

  private safeFailureCode(error: unknown): WorkspaceOperationFailure['code'] {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === 'EACCES' || code === 'EPERM') return 'permission';
    if (code === 'ENOENT') return 'not_found';
    if (code === 'EEXIST') return 'conflict';
    if (
      code === 'ECONNABORTED'
      || code === 'ECONNRESET'
      || code === 'EPIPE'
      || code === 'ENOTCONN'
      || code === 'ETIMEDOUT'
    ) return 'remote_disconnected';
    return 'unknown';
  }

  private withTargetFilesystem<T>(
    owner: WebContents,
    terminalId: string,
    target: ResolvedTarget,
    operation: (filesystem: FilesystemBackend) => Promise<T>,
  ): Promise<T> {
    if (target.transport === 'local') return operation(this.localFilesystem);
    return this.withRemoteFilesystem(owner, terminalId, target, operation);
  }

  private assertMutationLive(
    target: ResolvedTarget,
    tracker: OperationAuditTracker,
  ): void {
    try {
      target.authorization.assertLive?.();
    } catch (error) {
      // Do not create a durable intent after the capability was revoked. If
      // an intent already exists, the normal failure path still closes it.
      if (!tracker.handle) tracker.revokedBeforeIntent = true;
      throw error;
    }
  }

  private async prepareAccessRoots(
    filesystem: FilesystemBackend,
    target: ResolvedTarget,
  ): Promise<{ root: string; workspaceRoot: string }> {
    const root = await filesystem.realpath(target.root);
    assertBoundRootUnchanged(target.root, root, target.transport);
    if ((await filesystem.lstat(root))?.type !== 'directory') {
      throw new Error('已授权文件访问根目录已不可用。');
    }
    if (workspaceRootsMatch(target.workspaceRoot, target.root, target.transport)) {
      return { root, workspaceRoot: root };
    }
    const workspaceRoot = await filesystem.realpath(target.workspaceRoot);
    assertBoundRootUnchanged(target.workspaceRoot, workspaceRoot, target.transport);
    if ((await filesystem.lstat(workspaceRoot))?.type !== 'directory') {
      throw new Error('Workspace Root 已不可用。');
    }
    return { root, workspaceRoot };
  }

  private async prepareTraversalTarget(
    filesystem: FilesystemBackend,
    target: ResolvedTarget,
  ): Promise<PreparedWorkspaceTarget & { stat: RemoteFileStat }> {
    const { root } = await this.prepareAccessRoots(filesystem, target);
    const lexicalStat = await filesystem.lstat(target.requestedPath);
    if (!lexicalStat) throw new Error('搜索或 Glob 起点不存在。');
    if (lexicalStat.type === 'symlink') throw new Error('搜索或 Glob 起点不能是符号链接。');
    const path = await filesystem.realpath(target.requestedPath);
    assertWithinRoot(root, path, target.transport);
    if (!workspaceRootsMatch(target.requestedPath, path, target.transport)) {
      throw new Error('搜索或 Glob 路径不能经过符号链接。');
    }
    const stat = await filesystem.lstat(path);
    if (!stat || stat.type === 'symlink') {
      throw new Error('搜索或 Glob 起点已变化。');
    }
    return { root, path, stat };
  }

  private async prepareMutationTarget(
    filesystem: FilesystemBackend,
    target: ResolvedTarget,
  ): Promise<PreparedWorkspaceTarget> {
    const { root, workspaceRoot } = await this.prepareAccessRoots(filesystem, target);
    this.assertProtectedMutationTarget(
      target.transport,
      workspaceRoot,
      target.requestedPath,
      target.sessionId,
    );

    const lexicalParent = target.transport === 'ssh'
      ? posix.dirname(target.requestedPath)
      : dirname(target.requestedPath);
    const parentStat = await filesystem.lstat(lexicalParent);
    if (parentStat?.type === 'symlink') throw new Error('操作路径不能经过符号链接。');
    if (parentStat?.type !== 'directory') throw new Error('目标父目录不存在或不是目录。');
    const parent = await filesystem.realpath(lexicalParent);
    assertWithinRoot(root, parent, target.transport);
    if (!workspaceRootsMatch(lexicalParent, parent, target.transport)) {
      throw new Error('操作路径不能经过符号链接。');
    }
    const path = target.transport === 'ssh'
      ? posix.join(parent, posix.basename(target.requestedPath))
      : resolve(parent, basename(target.requestedPath));
    assertWithinRoot(root, path, target.transport);
    this.assertProtectedMutationTarget(
      target.transport,
      workspaceRoot,
      path,
      target.sessionId,
    );
    return { root, path, stat: await filesystem.lstat(path) };
  }

  private assertSameTargetWorkspace(left: ResolvedTarget, right: ResolvedTarget): void {
    if (
      left.transport !== right.transport
      || left.sessionId !== right.sessionId
      || !workspaceRootsMatch(left.workspaceRoot, right.workspaceRoot, left.transport)
      || (left.transport === 'ssh' && right.transport === 'ssh' && left.hostId !== right.hostId)
    ) throw new Error('重命名源和目标必须在同一 Workspace 中。');
  }

  private assertProtectedMutationTarget(
    flavor: 'local' | 'ssh',
    workspaceRoot: string,
    candidate: string,
    sessionId: string,
  ): void {
    const filesystemRoot = flavor === 'ssh'
      ? '/'
      : normalize(parse(candidate).root);
    if (workspaceRootsMatch(candidate, filesystemRoot, flavor)) {
      throw new Error('不允许修改或删除文件系统根目录。');
    }
    // Deleting or renaming an ancestor would also remove the bound Workspace
    // Root, so protect both the exact root and every containing directory.
    if (this.pathIsWithin(flavor, candidate, workspaceRoot)) {
      throw new Error('不允许修改或删除 Workspace Root。');
    }
    if (
      flavor === 'local'
      && this.protectedStorageRelationship(sessionId, candidate).protected
    ) {
      throw new Error(
        '应用 Session 和 Workspace 审计存储受保护，文件工具不能修改该路径或其祖先。',
      );
    }
  }

  private pathIsWithin(
    flavor: 'local' | 'ssh',
    parent: string,
    candidate: string,
  ): boolean {
    const candidateRelative = flavor === 'ssh'
      ? posix.relative(parent, candidate)
      : relative(parent, candidate);
    const separator = flavor === 'ssh' ? '/' : process.platform === 'win32' ? '\\' : '/';
    return candidateRelative === ''
      || (
        candidateRelative !== '..'
        && !candidateRelative.startsWith(`..${separator}`)
        && !(flavor === 'ssh' ? posix.isAbsolute(candidateRelative) : isAbsolute(candidateRelative))
      );
  }

  private async preflightRecursiveDelete(
    filesystem: FilesystemBackend,
    flavor: 'local' | 'ssh',
    root: string,
    targetPath: string,
  ): Promise<DeletePlanOperation[]> {
    const plan: DeletePlanOperation[] = [];
    const deadline = Date.now() + MAX_RECURSIVE_DELETE_DURATION_MS;
    let entriesVisited = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_RECURSIVE_DELETE_DEPTH) {
        throw new Error(`递归删除超过 ${MAX_RECURSIVE_DELETE_DEPTH} 层限制，未删除任何内容。`);
      }
      this.assertRecursiveDeleteDeadline(deadline);
      const canonicalDirectory = await filesystem.realpath(directory);
      this.assertRecursiveDeleteDeadline(deadline);
      assertWithinRoot(root, canonicalDirectory, flavor);
      if (!workspaceRootsMatch(directory, canonicalDirectory, flavor)) {
        throw new Error('递归删除遇到符号链接目录，未删除任何内容。');
      }
      const current = await filesystem.lstat(directory);
      this.assertRecursiveDeleteDeadline(deadline);
      if (current?.type !== 'directory') {
        throw new Error('递归删除预检期间目录已变化，未删除任何内容。');
      }
      const entries = await filesystem.listDirectory(directory);
      this.assertRecursiveDeleteDeadline(deadline);
      entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const entry of entries) {
        this.assertRecursiveDeleteDeadline(deadline);
        if (entriesVisited >= MAX_RECURSIVE_DELETE_ENTRIES) {
          throw new Error(`递归删除超过 ${MAX_RECURSIVE_DELETE_ENTRIES} 个条目限制，未删除任何内容。`);
        }
        entriesVisited += 1;
        if (
          !entry.name
          || entry.name === '.'
          || entry.name === '..'
          || entry.name.includes('\0')
          || entry.name.includes('/')
          || (flavor === 'local' && process.platform === 'win32' && entry.name.includes('\\'))
        ) throw new Error('递归删除遇到不安全的目录条目，未删除任何内容。');
        const path = flavor === 'ssh'
          ? posix.join(directory, entry.name)
          : resolve(directory, entry.name);
        assertWithinRoot(root, path, flavor);
        const stat = await filesystem.lstat(path);
        this.assertRecursiveDeleteDeadline(deadline);
        if (!stat) throw new Error('递归删除预检期间条目已变化，未删除任何内容。');
        if (stat.type === 'directory') {
          await walk(path, depth + 1);
          this.assertRecursiveDeleteDeadline(deadline);
        } else {
          this.assertRecursiveDeleteDeadline(deadline);
          plan.push({ path, type: 'file' });
        }
      }
      this.assertRecursiveDeleteDeadline(deadline);
      plan.push({ path: directory, type: 'directory' });
    };
    await walk(targetPath, 0);
    return plan;
  }

  private assertRecursiveDeleteDeadline(deadline: number): void {
    if (Date.now() >= deadline) {
      throw new Error('递归删除预检超时，未删除任何内容。');
    }
  }

  private async revalidateDeleteOperation(
    filesystem: FilesystemBackend,
    flavor: 'local' | 'ssh',
    root: string,
    operation: DeletePlanOperation,
  ): Promise<void> {
    const parent = flavor === 'ssh'
      ? posix.dirname(operation.path)
      : dirname(operation.path);
    const canonicalParent = await filesystem.realpath(parent);
    assertWithinRoot(root, canonicalParent, flavor);
    if (!workspaceRootsMatch(parent, canonicalParent, flavor)) {
      throw new Error('递归删除执行期间父目录已变为符号链接。');
    }
    const current = await filesystem.lstat(operation.path);
    if (!current) throw new Error('递归删除执行期间条目已变化。');
    if (operation.type === 'directory') {
      if (current.type !== 'directory') {
        throw new Error('递归删除执行期间目录类型已变化。');
      }
      const canonicalDirectory = await filesystem.realpath(operation.path);
      assertWithinRoot(root, canonicalDirectory, flavor);
      if (!workspaceRootsMatch(operation.path, canonicalDirectory, flavor)) {
        throw new Error('递归删除执行期间目录已变为符号链接。');
      }
    } else if (current.type === 'directory') {
      throw new Error('递归删除执行期间文件类型已变化。');
    }
    // A path-only backend cannot make the following unlink/rmdir atomic with
    // these checks. Revalidation prevents intentional traversal and narrows
    // the residual race to the individual backend operation.
  }

  private resolveTarget(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    workspaceRoot?: string,
    authorization?: AgentFilePathAuthorization,
    requirement: AgentFileAccessRequirement = 'read',
  ): ResolvedTarget {
    assertBoundedPath(requestedPath);
    const session = this.requireBoundWorkspace(owner, terminalId);
    const { workspace } = session;
    if (
      workspaceRoot !== undefined
      && !workspaceRootsMatch(workspace.root, workspaceRoot, session.transport)
    ) {
      throw new Error('显式 Workspace Root 与 Session 绑定的 Workspace Root 不一致。');
    }
    const boundRoot = workspaceRoot ?? workspace.root;
    if (session.transport === 'ssh') {
      const workspacePath = posix.normalize(boundRoot);
      if (!posix.isAbsolute(workspacePath)) {
        throw new Error('远程 Workspace Root 必须是绝对路径。');
      }
      const path = posix.resolve(workspacePath, requestedPath);
      const normalizedAuthorization = this.normalizeAuthorization(
        'ssh',
        workspacePath,
        authorization,
      );
      const root = this.selectAuthorizationRoot(
        'ssh',
        path,
        normalizedAuthorization,
        requirement,
      );
      assertWithinRoot(root, path, 'ssh');
      return {
        transport: 'ssh',
        sessionId: session.sessionId,
        root,
        workspaceRoot: workspacePath,
        requestedPath: path,
        hostId: workspace.hostId!,
        authorization: normalizedAuthorization,
      };
    }
    if (process.platform === 'win32') {
      assertSafeWindowsRequestedPath(boundRoot);
      assertNoWindowsRootRelativePath(boundRoot);
      // Validate the raw spelling before resolve() can reinterpret C:relative
      // or normalize an unsafe reserved/ADS segment out of sight.
      assertSafeWindowsRequestedPath(requestedPath);
      assertNoWindowsRootRelativePath(requestedPath);
    }
    if (!isAbsolute(boundRoot)) throw new Error('本地 Workspace Root 必须是绝对路径。');
    const workspacePath = resolve(boundRoot);
    const path = resolve(workspacePath, requestedPath);
    const normalizedAuthorization = this.normalizeAuthorization(
      'local',
      workspacePath,
      authorization,
    );
    const root = this.selectAuthorizationRoot(
      'local',
      path,
      normalizedAuthorization,
      requirement,
    );
    assertWithinRoot(root, path, 'local');
    if (process.platform === 'win32') assertSafeWindowsResolvedPath(root, path);
    return {
      transport: 'local',
      sessionId: session.sessionId,
      root,
      workspaceRoot: workspacePath,
      requestedPath: path,
      authorization: normalizedAuthorization,
    };
  }

  private requireBoundWorkspace(
    owner: WebContents,
    terminalId: string,
  ): BoundWorkspaceSession {
    const session = this.sessions.sessionForTerminal(owner, terminalId);
    if (!session) throw new Error('文件工具需要正式会话。');
    const workspace = session.workspace;
    if (!workspace) throw new Error('请先设置 Workspace Root。');
    assertWorkspaceMatchesSession(session.transport, session.hostId, workspace);
    return {
      sessionId: session.id,
      transport: session.transport,
      hostId: session.hostId,
      workspace,
    };
  }

  private normalizeAuthorization(
    flavor: 'local' | 'ssh',
    workspaceRoot: string,
    authorization?: AgentFilePathAuthorization,
  ): NormalizedPathAuthorization {
    if (authorization === undefined) {
      return {
        readablePaths: [workspaceRoot],
        writablePaths: [workspaceRoot],
        fullAccess: false,
      };
    }
    if (
      !Array.isArray(authorization.readablePaths)
      || !Array.isArray(authorization.writablePaths)
      || typeof authorization.fullAccess !== 'boolean'
      || (authorization.assertLive !== undefined && typeof authorization.assertLive !== 'function')
    ) throw new Error('文件路径授权无效。');
    if (authorization.fullAccess) {
      return {
        readablePaths: [],
        writablePaths: [],
        fullAccess: true,
        ...(authorization.assertLive ? { assertLive: authorization.assertLive } : {}),
      };
    }
    const normalizeRoots = (roots: readonly string[]) => {
      const normalized: string[] = [];
      for (const root of roots) {
        if (typeof root !== 'string') throw new Error('文件路径授权无效。');
        assertBoundedPath(root);
        if (flavor === 'ssh') {
          if (!posix.isAbsolute(root)) throw new Error('远程授权根必须是绝对路径。');
          normalized.push(normalizedRemotePath(root));
          continue;
        }
        if (process.platform === 'win32') {
          assertSafeWindowsRequestedPath(root);
          assertNoWindowsRootRelativePath(root);
        }
        if (!isAbsolute(root)) throw new Error('本地授权根必须是绝对路径。');
        const normalizedRoot = normalize(resolve(root));
        if (process.platform === 'win32') {
          assertSafeWindowsResolvedPath(parse(normalizedRoot).root, normalizedRoot);
        }
        normalized.push(normalizedRoot);
      }
      return [...new Set(normalized)];
    };
    return {
      readablePaths: normalizeRoots(authorization.readablePaths),
      writablePaths: normalizeRoots(authorization.writablePaths),
      fullAccess: false,
      ...(authorization.assertLive ? { assertLive: authorization.assertLive } : {}),
    };
  }

  private selectAuthorizationRoot(
    flavor: 'local' | 'ssh',
    candidate: string,
    authorization: NormalizedPathAuthorization,
    requirement: AgentFileAccessRequirement,
  ): string {
    if (authorization.fullAccess) {
      const root = flavor === 'ssh' ? '/' : normalize(parse(candidate).root);
      if (!root || (flavor === 'local' && !isAbsolute(root))) {
        throw new Error('无法确定文件系统安全边界。');
      }
      return root;
    }
    const matching = (roots: string[]) => roots.filter((root) => (
      this.pathIsWithin(flavor, root, candidate)
    ));
    const readable = matching(authorization.readablePaths);
    const writable = matching(authorization.writablePaths);
    let eligible: string[];
    if (requirement === 'read') eligible = readable;
    else if (requirement === 'write') eligible = writable;
    else {
      if (!readable.length || !writable.length) {
        throw new Error('文件路径超出读写交集授权范围。');
      }
      eligible = [...readable, ...writable];
    }
    if (!eligible.length) {
      throw new Error('文件路径超出当前会话工作目录或已授权范围。');
    }
    // All matching ancestors of one candidate are segment-nested; the most
    // specific one is the safe canonical/symlink boundary for this call.
    eligible.sort((left, right) => right.length - left.length);
    return eligible[0]!;
  }

  private retargetForRequirement<T extends ResolvedTarget>(
    target: T,
    requirement: AgentFileAccessRequirement,
  ): T {
    const root = this.selectAuthorizationRoot(
      target.transport,
      target.requestedPath,
      target.authorization,
      requirement,
    );
    return { ...target, root };
  }

  private async optionalLocalFile(path: string): Promise<{
    content: Buffer;
    mode: number;
  } | undefined> {
    const attributes = await this.localFilesystem.lstat(path);
    if (!attributes) return undefined;
    if (attributes.type === 'symlink') throw new Error('不允许通过符号链接覆盖文件。');
    if (attributes.type !== 'file') throw new Error('目标不是普通文件。');
    if (attributes.size > MAX_AGENT_FILE_BYTES) {
      throw new Error(`文件为 ${attributes.size} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节写入限制。`);
    }
    const content = await this.localFilesystem.readFile(path, MAX_AGENT_FILE_BYTES);
    return { content, mode: attributes.mode & 0o777 };
  }

  private assertExpectedHash(
    path: string,
    current: Buffer | undefined,
    expectedSha256: string | null,
  ): void {
    if (!current) {
      if (expectedSha256 !== null) throw new Error(`文件不存在，无法匹配预期哈希：${path}`);
      return;
    }
    if (!expectedSha256 || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
      throw new Error('覆盖现有文件前必须先读取并提供有效的 expectedSha256。');
    }
    if (sha256(current) !== expectedSha256) throw new Error('文件已变化；请重新读取后再写入。');
  }

  private withRemoteFilesystem<T>(
    owner: WebContents,
    terminalId: string,
    target: Extract<ResolvedTarget, { transport: 'ssh' }>,
    operation: (filesystem: RemoteFilesystem) => Promise<T>,
  ): Promise<T> {
    return this.remoteFilesystems.withFilesystem(
      owner,
      terminalId,
      operation,
      target.hostId,
    );
  }
}

export const AGENT_FILE_LIMITS = {
  maxBytes: MAX_AGENT_FILE_BYTES,
  maxEntries: MAX_AGENT_DIRECTORY_ENTRIES,
  maxPatchOperations: MAX_PATCH_OPERATIONS,
  maxPathChars: MAX_AGENT_PATH_CHARS,
  maxPatchInputBytes: MAX_PATCH_INPUT_BYTES,
  search: DEFAULT_WORKSPACE_TRAVERSAL_LIMITS,
  maxRecursiveDeleteDepth: MAX_RECURSIVE_DELETE_DEPTH,
  maxRecursiveDeleteEntries: MAX_RECURSIVE_DELETE_ENTRIES,
  maxRecursiveDeleteDurationMs: MAX_RECURSIVE_DELETE_DURATION_MS,
} as const;
