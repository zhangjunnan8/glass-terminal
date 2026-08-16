import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
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
import type { TerminalService } from '../terminal/terminal-service';

const MAX_AGENT_FILE_BYTES = 512 * 1024;
const MAX_AGENT_DIRECTORY_ENTRIES = 500;
const MAX_PATCH_OPERATIONS = 64;
const MAX_AGENT_PATH_CHARS = 4_096;
const MAX_PATCH_INPUT_BYTES = 1024 * 1024;
const MAX_RECURSIVE_DELETE_DEPTH = 32;
const MAX_RECURSIVE_DELETE_ENTRIES = 10_000;
const MAX_RECURSIVE_DELETE_DURATION_MS = 10_000;

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

type ResolvedTarget =
  | {
    transport: 'local';
    root: string;
    requestedPath: string;
  }
  | {
    transport: 'ssh';
    root: string;
    requestedPath: string;
    hostId: string;
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

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertUtf8Text(buffer: Buffer, label: string): string {
  if (buffer.includes(0)) throw new Error(`${label} 不是受支持的 UTF-8 文本文件。`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${label} 不是有效的 UTF-8 文本文件。`);
  }
}

function boundedContent(content: string): Buffer {
  if (content.includes('\0')) throw new Error('文件内容不能包含 NUL 字节。');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_AGENT_FILE_BYTES) {
    throw new Error(
      `单次文件写入为 ${bytes.length} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节限制；`
      + '请拆分为较小文件或使用精确补丁。',
    );
  }
  return bytes;
}

function assertBoundedPath(requestedPath: string): void {
  if (
    !requestedPath
    || requestedPath.includes('\0')
    || requestedPath.length > MAX_AGENT_PATH_CHARS
  ) throw new Error(`文件路径无效或超过 ${MAX_AGENT_PATH_CHARS} 字符限制。`);
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
    if ((await this.localFilesystem.stat(root))?.type !== 'directory') {
      throw new Error('Workspace Root 不是可访问的目录。');
    }
    return root;
  }

  async readText(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    workspaceRoot?: string,
  ): Promise<AgentFileReadResult> {
    const target = this.resolveTarget(owner, terminalId, requestedPath, workspaceRoot);
    if (target.transport === 'local') {
      const root = await this.localFilesystem.realpath(target.root);
      assertBoundRootUnchanged(target.root, root, 'local');
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
      return { path, content: assertUtf8Text(buffer, path), bytes: buffer.length, sha256: sha256(buffer) };
    }
    return this.withRemoteFilesystem(owner, terminalId, target, async (filesystem) => {
      const root = await filesystem.realpath(target.root);
      assertBoundRootUnchanged(target.root, root, 'ssh');
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
      return { path, content: assertUtf8Text(buffer, path), bytes: buffer.length, sha256: sha256(buffer) };
    });
  }

  async list(
    owner: WebContents,
    terminalId: string,
    requestedPath = '.',
    workspaceRoot?: string,
  ): Promise<{ path: string; entries: AgentFileListEntry[]; truncated: boolean }> {
    const target = this.resolveTarget(owner, terminalId, requestedPath, workspaceRoot);
    if (target.transport === 'local') {
      const root = await this.localFilesystem.realpath(target.root);
      assertBoundRootUnchanged(target.root, root, 'local');
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
      const root = await filesystem.realpath(target.root);
      assertBoundRootUnchanged(target.root, root, 'ssh');
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
  ): Promise<WorkspaceStatResult> {
    const target = this.resolveTarget(owner, terminalId, requestedPath, workspaceRoot);
    if (target.transport === 'local') {
      const root = await this.localFilesystem.realpath(target.root);
      assertBoundRootUnchanged(target.root, root, 'local');
      const path = relative(target.root, target.requestedPath) === ''
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
      const root = await filesystem.realpath(target.root);
      assertBoundRootUnchanged(target.root, root, 'ssh');
      const path = posix.relative(target.root, target.requestedPath) === ''
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
  ): Promise<AgentFileWriteResult> {
    const bytes = boundedContent(content);
    const target = this.resolveTarget(owner, terminalId, requestedPath, workspaceRoot);
    if (target.transport === 'local') {
      const prepared = await this.prepareMutationTarget(this.localFilesystem, target);
      const path = prepared.path;
      const parent = dirname(path);
      const current = await this.optionalLocalFile(path);
      this.assertExpectedHash(path, current?.content, expectedSha256);
      const before = current ? assertUtf8Text(current.content, path) : undefined;
      const diff = createWorkspaceDiff(this.relativeLabel(target), before, content);
      const temporary = resolve(parent, `.ai-terminal-${randomUUID()}.tmp`);
      let temporaryCreated = false;
      try {
        await writeFile(temporary, bytes, { mode: current?.mode ?? 0o600, flag: 'wx' });
        temporaryCreated = true;
        if (current) {
          const latest = await this.optionalLocalFile(path);
          this.assertExpectedHash(path, latest?.content, expectedSha256);
          await rename(temporary, path);
        } else {
          // link() publishes the fully written inode only if the destination
          // is still absent, preserving the expectedSha256:null contract.
          await link(temporary, path);
          await unlink(temporary);
        }
      } catch (error) {
        if (temporaryCreated) await unlink(temporary).catch(() => undefined);
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
    return this.withRemoteFilesystem(owner, terminalId, target, (filesystem) => (
      this.writeRemoteText(filesystem, target, content, bytes, expectedSha256)
    ));
  }

  async applyPatch(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    expectedSha256: string,
    patches: AgentFilePatch[],
    workspaceRoot?: string,
  ): Promise<AgentFileWriteResult> {
    this.assertPatchInput(patches);
    const target = this.resolveTarget(owner, terminalId, requestedPath, workspaceRoot);
    if (target.transport === 'local') {
      const current = await this.readText(owner, terminalId, requestedPath, workspaceRoot);
      if (current.sha256 !== expectedSha256) {
        throw new Error('文件已变化；请重新读取后再应用补丁。');
      }
      const next = this.applyExactPatches(current.content, patches);
      return this.writeText(owner, terminalId, requestedPath, next, expectedSha256, workspaceRoot);
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
        boundedContent(next),
        expectedSha256,
      );
    });
  }

  async search(
    owner: WebContents,
    terminalId: string,
    query: string,
    options: AgentFileSearchOptions = {},
    workspaceRoot?: string,
  ): Promise<WorkspaceSearchResult> {
    const target = this.resolveTarget(
      owner,
      terminalId,
      options.path ?? '.',
      workspaceRoot,
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
  ): Promise<WorkspaceGlobResult> {
    const target = this.resolveTarget(
      owner,
      terminalId,
      options.path ?? '.',
      workspaceRoot,
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
  ): Promise<void> {
    const target = this.resolveTarget(owner, terminalId, requestedPath, workspaceRoot);
    return this.withTargetFilesystem(owner, terminalId, target, async (filesystem) => {
      const prepared = await this.prepareMutationTarget(filesystem, target);
      if (prepared.stat) throw new Error('目录或文件已存在。');
      await filesystem.mkdir(prepared.path, 0o700);
    });
  }

  async renamePath(
    owner: WebContents,
    terminalId: string,
    source: string,
    destination: string,
    workspaceRoot?: string,
  ): Promise<void> {
    const sourceTarget = this.resolveTarget(owner, terminalId, source, workspaceRoot);
    const destinationTarget = this.resolveTarget(owner, terminalId, destination, workspaceRoot);
    this.assertSameTargetWorkspace(sourceTarget, destinationTarget);
    return this.withTargetFilesystem(owner, terminalId, sourceTarget, async (filesystem) => {
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
      await filesystem.rename(preparedSource.path, preparedDestination.path);
    });
  }

  async deletePath(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    options: AgentFileDeleteOptions = {},
    workspaceRoot?: string,
  ): Promise<void> {
    const target = this.resolveTarget(owner, terminalId, requestedPath, workspaceRoot);
    return this.withTargetFilesystem(owner, terminalId, target, async (filesystem) => {
      const prepared = await this.prepareMutationTarget(filesystem, target);
      if (!prepared.stat) throw new Error('删除目标不存在。');
      if (prepared.stat.type !== 'directory') {
        await filesystem.unlink(prepared.path);
        return;
      }
      if (!options.recursive) {
        await filesystem.rmdir(prepared.path);
        return;
      }
      const plan = await this.preflightRecursiveDelete(
        filesystem,
        target.transport,
        prepared.root,
        prepared.path,
      );
      for (const operation of plan) {
        await this.revalidateDeleteOperation(
          filesystem,
          target.transport,
          prepared.root,
          operation,
        );
        if (operation.type === 'directory') await filesystem.rmdir(operation.path);
        else await filesystem.unlink(operation.path);
      }
    });
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
    const root = await filesystem.realpath(target.root);
    assertBoundRootUnchanged(target.root, root, 'ssh');
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
      content: assertUtf8Text(buffer, path),
      bytes: buffer.length,
      sha256: sha256(buffer),
    };
  }

  private async writeRemoteText(
    filesystem: RemoteFilesystem,
    target: Extract<ResolvedTarget, { transport: 'ssh' }>,
    content: string,
    bytes: Buffer,
    expectedSha256: string | null,
  ): Promise<AgentFileWriteResult> {
    const prepared = await this.prepareMutationTarget(filesystem, target);
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
    const before = current ? assertUtf8Text(current, prepared.path) : undefined;
    const diff = createWorkspaceDiff(this.relativeLabel(target), before, content);
    const parent = posix.dirname(prepared.path);
    const temporary = posix.join(parent, `.ai-terminal-${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
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
        await filesystem.atomicReplace(temporary, prepared.path);
      } else {
        // Recheck absence immediately before rename. Standard SFTP rename can
        // still race another creator because no no-replace extension is portable.
        if (await filesystem.lstat(prepared.path)) {
          throw new Error('文件已在写入期间创建；请重新读取。');
        }
        await filesystem.rename(temporary, prepared.path);
      }
    } catch (error) {
      if (temporaryCreated) await filesystem.unlink(temporary).catch(() => undefined);
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

  private withTargetFilesystem<T>(
    owner: WebContents,
    terminalId: string,
    target: ResolvedTarget,
    operation: (filesystem: FilesystemBackend) => Promise<T>,
  ): Promise<T> {
    if (target.transport === 'local') return operation(this.localFilesystem);
    return this.withRemoteFilesystem(owner, terminalId, target, operation);
  }

  private async prepareTraversalTarget(
    filesystem: FilesystemBackend,
    target: ResolvedTarget,
  ): Promise<PreparedWorkspaceTarget & { stat: RemoteFileStat }> {
    const root = await filesystem.realpath(target.root);
    assertBoundRootUnchanged(target.root, root, target.transport);
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
    const root = await filesystem.realpath(target.root);
    assertBoundRootUnchanged(target.root, root, target.transport);
    const relativeTarget = target.transport === 'ssh'
      ? posix.relative(target.root, target.requestedPath)
      : relative(target.root, target.requestedPath);
    if (!relativeTarget) throw new Error('不允许修改或删除 Workspace Root。');

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
    return { root, path, stat: await filesystem.lstat(path) };
  }

  private assertSameTargetWorkspace(left: ResolvedTarget, right: ResolvedTarget): void {
    if (
      left.transport !== right.transport
      || !workspaceRootsMatch(left.root, right.root, left.transport)
      || (left.transport === 'ssh' && right.transport === 'ssh' && left.hostId !== right.hostId)
    ) throw new Error('重命名源和目标必须在同一 Workspace 中。');
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

  private relativeLabel(target: ResolvedTarget): string {
    const label = target.transport === 'ssh'
      ? posix.relative(target.root, target.requestedPath)
      : relative(target.root, target.requestedPath);
    const fallback = target.transport === 'ssh'
      ? posix.basename(target.requestedPath)
      : basename(target.requestedPath);
    return target.transport === 'local'
      ? (label || fallback).split(sep).join('/')
      : label || fallback;
  }

  private resolveTarget(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    workspaceRoot?: string,
  ): ResolvedTarget {
    assertBoundedPath(requestedPath);
    const session = this.sessions.sessionForTerminal(owner, terminalId);
    if (!session) throw new Error('文件工具需要正式会话。');
    const workspace = session.workspace;
    if (!workspace) throw new Error('请先设置 Workspace Root。');
    assertWorkspaceMatchesSession(session.transport, session.hostId, workspace);
    if (
      workspaceRoot !== undefined
      && !workspaceRootsMatch(workspace.root, workspaceRoot, session.transport)
    ) {
      throw new Error('显式 Workspace Root 与 Session 绑定的 Workspace Root 不一致。');
    }
    const boundRoot = workspaceRoot ?? workspace.root;
    if (session.transport === 'ssh') {
      const root = posix.normalize(boundRoot);
      if (!root.startsWith('/')) throw new Error('远程 Workspace Root 必须是绝对路径。');
      const path = posix.resolve(root, requestedPath);
      assertWithinRoot(root, path, 'ssh');
      return { transport: 'ssh', root, requestedPath: path, hostId: workspace.hostId! };
    }
    if (process.platform === 'win32') {
      assertSafeWindowsRequestedPath(boundRoot);
      // Validate the raw spelling before resolve() can reinterpret C:relative
      // or normalize an unsafe reserved/ADS segment out of sight.
      assertSafeWindowsRequestedPath(requestedPath);
    }
    if (!isAbsolute(boundRoot)) throw new Error('本地 Workspace Root 必须是绝对路径。');
    const root = resolve(boundRoot);
    const path = resolve(root, requestedPath);
    assertWithinRoot(root, path, 'local');
    if (process.platform === 'win32') assertSafeWindowsResolvedPath(root, path);
    return { transport: 'local', root, requestedPath: path };
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
