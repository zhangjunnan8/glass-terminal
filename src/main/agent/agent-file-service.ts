import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  link,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { posix } from 'node:path';
import type { WebContents } from 'electron';
import type { WorkspaceBinding, WorkspaceStatResult } from '../../shared/tools';
import { LocalFilesystemBackend } from '../filesystem/local-filesystem';
import {
  RemoteFilesystemProvider,
  type RemoteFilesystem,
} from '../filesystem/remote-filesystem';
import type { SessionManager } from '../sessions/session-manager';
import type { TerminalService } from '../terminal/terminal-service';

const MAX_AGENT_FILE_BYTES = 512 * 1024;
const MAX_AGENT_DIRECTORY_ENTRIES = 500;
const MAX_PATCH_OPERATIONS = 64;
const MAX_AGENT_PATH_CHARS = 4_096;
const MAX_PATCH_INPUT_BYTES = 1024 * 1024;

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
    || isAbsolute(relativePath)
  ) throw new Error('文件路径超出当前会话工作目录。');
}

function normalizedRemotePath(path: string): string {
  const normalized = posix.normalize(path);
  return normalized === '/' ? normalized : normalized.replace(/\/+$/u, '');
}

const WINDOWS_RESERVED_FILE_STEM = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function assertSafeWindowsPath(root: string, target: string): void {
  if (process.platform !== 'win32') return;
  for (const segment of relative(root, target).split(/[\\/]/)) {
    if (!segment) continue;
    const withoutTrailingDotsOrSpaces = segment.replace(/[. ]+$/u, '');
    const stem = withoutTrailingDotsOrSpaces.split('.', 1)[0] ?? '';
    if (
      segment.includes(':')
      || withoutTrailingDotsOrSpaces !== segment
      || WINDOWS_RESERVED_FILE_STEM.test(stem)
    ) {
      throw new Error('文件路径包含 Windows 保留名称、尾随点/空格或备用数据流。');
    }
  }
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
    private readonly localFilesystem: RemoteFilesystem = new LocalFilesystemBackend(),
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
      const buffer = await this.localFilesystem.readFile(path);
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
      const buffer = await filesystem.readFile(path);
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
      const root = await this.localFilesystem.realpath(target.root);
      assertBoundRootUnchanged(target.root, root, 'local');
      const parent = await this.localFilesystem.realpath(dirname(target.requestedPath));
      assertWithinRoot(root, parent, 'local');
      const path = resolve(parent, basename(target.requestedPath));
      const current = await this.optionalLocalFile(path);
      this.assertExpectedHash(path, current?.content, expectedSha256);
      const temporary = resolve(parent, `.ai-terminal-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { mode: current?.mode ?? 0o600, flag: 'wx' });
        if (current) {
          await rename(temporary, path);
        } else {
          // link() publishes the fully written inode only if the destination
          // is still absent, preserving the expectedSha256:null contract.
          await link(temporary, path);
          await unlink(temporary);
        }
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      return { path, bytes: bytes.length, sha256: sha256(bytes), created: current === undefined };
    }
    return this.withRemoteFilesystem(owner, terminalId, target, async (filesystem) => {
      const root = await filesystem.realpath(target.root);
      assertBoundRootUnchanged(target.root, root, 'ssh');
      const parent = await filesystem.realpath(posix.dirname(target.requestedPath));
      assertWithinRoot(root, parent, 'ssh');
      const path = posix.join(parent, posix.basename(target.requestedPath));
      const attributes = await filesystem.lstat(path);
      if (attributes?.type === 'symlink') throw new Error('不允许通过符号链接覆盖文件。');
      if (attributes && attributes.type !== 'file') throw new Error('目标不是普通文件。');
      if (attributes && attributes.size > MAX_AGENT_FILE_BYTES) {
        throw new Error(`文件为 ${attributes.size} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节写入限制。`);
      }
      const current = attributes ? await filesystem.readFile(path) : undefined;
      if (current && current.length > MAX_AGENT_FILE_BYTES) {
        throw new Error(`文件读取结果为 ${current.length} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节限制。`);
      }
      this.assertExpectedHash(path, current, expectedSha256);
      const temporary = posix.join(parent, `.ai-terminal-${randomUUID()}.tmp`);
      try {
        await filesystem.writeFile(temporary, bytes, attributes?.mode);
        if (attributes) {
          await filesystem.atomicReplace(temporary, path);
        } else {
          // Recheck absence immediately before the standard rename. Existing
          // targets require the OpenSSH atomic-overwrite extension above.
          if (await filesystem.lstat(path)) throw new Error('文件已在写入期间创建；请重新读取。');
          await filesystem.rename(temporary, path);
        }
      } catch (error) {
        await filesystem.unlink(temporary).catch(() => undefined);
        throw error;
      }
      return { path, bytes: bytes.length, sha256: sha256(bytes), created: current === undefined };
    });
  }

  async applyPatch(
    owner: WebContents,
    terminalId: string,
    requestedPath: string,
    expectedSha256: string,
    patches: AgentFilePatch[],
    workspaceRoot?: string,
  ): Promise<AgentFileWriteResult> {
    if (!patches.length || patches.length > MAX_PATCH_OPERATIONS) {
      throw new Error(`补丁操作数量必须为 1-${MAX_PATCH_OPERATIONS}。`);
    }
    const patchBytes = patches.reduce((total, patch) => (
      total + Buffer.byteLength(patch.search, 'utf8') + Buffer.byteLength(patch.replace, 'utf8')
    ), 0);
    if (patchBytes > MAX_PATCH_INPUT_BYTES) {
      throw new Error(`补丁文本超过 ${MAX_PATCH_INPUT_BYTES} 字节限制。`);
    }
    const current = await this.readText(owner, terminalId, requestedPath, workspaceRoot);
    if (current.sha256 !== expectedSha256) throw new Error('文件已变化；请重新读取后再应用补丁。');
    let next = current.content;
    for (const patch of patches) {
      if (!patch.search) throw new Error('补丁 search 不能为空。');
      const first = next.indexOf(patch.search);
      if (first < 0) throw new Error('补丁 search 未在文件中找到。');
      if (next.indexOf(patch.search, first + patch.search.length) >= 0) {
        throw new Error('补丁 search 在文件中不唯一；请提供更多上下文。');
      }
      next = `${next.slice(0, first)}${patch.replace}${next.slice(first + patch.search.length)}`;
    }
    return this.writeText(owner, terminalId, requestedPath, next, expectedSha256, workspaceRoot);
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
    if (!isAbsolute(boundRoot)) throw new Error('本地 Workspace Root 必须是绝对路径。');
    const root = resolve(boundRoot);
    const path = resolve(root, requestedPath);
    assertWithinRoot(root, path, 'local');
    assertSafeWindowsPath(root, path);
    return { transport: 'local', root, requestedPath: path };
  }

  private async optionalLocalFile(path: string): Promise<{
    content: Buffer;
    mode: number;
  } | undefined> {
    try {
      const attributes = await lstat(path);
      if (attributes.isSymbolicLink()) throw new Error('不允许通过符号链接覆盖文件。');
      if (!attributes.isFile()) throw new Error('目标不是普通文件。');
      if (attributes.size > MAX_AGENT_FILE_BYTES) {
        throw new Error(`文件为 ${attributes.size} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节写入限制。`);
      }
      const content = await readFile(path);
      if (content.length > MAX_AGENT_FILE_BYTES) {
        throw new Error(`文件读取结果为 ${content.length} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节限制。`);
      }
      return { content, mode: attributes.mode & 0o777 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
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
} as const;
