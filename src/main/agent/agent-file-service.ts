import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  link,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { posix } from 'node:path';
import type { WebContents } from 'electron';
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
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

interface ResolvedTarget {
  transport: 'local' | 'ssh';
  root: string;
  requestedPath: string;
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
    || isAbsolute(relativePath)
  ) throw new Error('文件路径超出当前会话工作目录。');
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
  const bound = platform === 'ssh' ? posix.normalize(boundRoot) : normalize(resolve(boundRoot));
  const canonical = platform === 'ssh'
    ? posix.normalize(canonicalRoot)
    : normalize(resolve(canonicalRoot));
  const same = platform === 'local' && process.platform === 'win32'
    ? bound.toLocaleLowerCase('en-US') === canonical.toLocaleLowerCase('en-US')
    : bound === canonical;
  if (!same) throw new Error('绑定的文件访问根目录已被替换或重定向；请关闭后重新授权。');
}

function sftpRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolvePath, reject) => {
    sftp.realpath(path, (error, resolvedPath) => {
      if (error) reject(error);
      else resolvePath(resolvedPath);
    });
  });
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<Stats | undefined> {
  return new Promise((resolveStats, reject) => {
    sftp.stat(path, (error, attributes) => {
      if (error && isNotFound(error)) resolveStats(undefined);
      else if (error) reject(error);
      else resolveStats(attributes);
    });
  });
}

function sftpLstat(sftp: SFTPWrapper, path: string): Promise<Stats | undefined> {
  return new Promise((resolveStats, reject) => {
    sftp.lstat(path, (error, attributes) => {
      if (error && isNotFound(error)) resolveStats(undefined);
      else if (error) reject(error);
      else resolveStats(attributes);
    });
  });
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: string | number } | undefined)?.code;
  return code === 'ENOENT' || code === 2;
}

function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolveBuffer, reject) => {
    sftp.readFile(path, (error, data) => {
      if (error) reject(error);
      else resolveBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
  });
}

function sftpWriteFile(
  sftp: SFTPWrapper,
  path: string,
  content: Buffer,
  mode = 0o600,
): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    sftp.writeFile(path, content, { mode: mode & 0o777 }, (error) => {
      if (error) reject(error);
      else resolveWrite();
    });
  });
}

function sftpRename(sftp: SFTPWrapper, source: string, destination: string): Promise<void> {
  return new Promise((resolveRename, reject) => {
    sftp.rename(source, destination, (error) => {
      if (error) reject(error);
      else resolveRename();
    });
  });
}

function sftpAtomicReplace(sftp: SFTPWrapper, source: string, destination: string): Promise<void> {
  return new Promise((resolveRename, reject) => {
    sftp.ext_openssh_rename(source, destination, (error) => {
      if (error) reject(new Error(`远程服务器不支持安全原子覆盖：${error.message}`));
      else resolveRename();
    });
  });
}

function sftpUnlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolveUnlink, reject) => {
    sftp.unlink(path, (error) => {
      if (error) reject(error);
      else resolveUnlink();
    });
  });
}

function sftpReaddir(sftp: SFTPWrapper, path: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolveEntries, reject) => {
    sftp.readdir(path, (error, entries) => {
      if (error) reject(error);
      else resolveEntries(entries);
    });
  });
}

function entryType(attributes: FileEntryWithStats['attrs']): AgentFileListEntry['type'] {
  if (attributes.isDirectory()) return 'directory';
  if (attributes.isFile()) return 'file';
  if (attributes.isSymbolicLink()) return 'symlink';
  return 'other';
}

export class AgentFileService {
  constructor(
    private readonly terminals: TerminalService,
    private readonly sessions: SessionManager,
  ) {}

  async bindWorkspaceRoot(owner: WebContents, terminalId: string): Promise<string> {
    const session = this.sessions.sessionForTerminal(owner, terminalId);
    if (!session) throw new Error('文件工具需要正式会话。');
    if (!session.cwd) throw new Error('当前会话工作目录未知；请先在终端显示一个 Shell 提示符。');
    if (session.transport === 'ssh') {
      if (!posix.isAbsolute(session.cwd)) throw new Error('远程会话工作目录必须是绝对路径。');
      return this.withSftp(owner, terminalId, async (sftp) => {
        const root = await sftpRealpath(sftp, session.cwd!);
        const attributes = await sftpStat(sftp, root);
        if (!attributes?.isDirectory()) throw new Error('当前会话工作目录不是可访问的目录。');
        return root;
      });
    }
    const root = await realpath(resolve(session.cwd));
    if (!(await stat(root)).isDirectory()) throw new Error('当前会话工作目录不是可访问的目录。');
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
      const root = await realpath(target.root);
      assertBoundRootUnchanged(target.root, root, 'local');
      const path = await realpath(target.requestedPath);
      assertWithinRoot(root, path, 'local');
      const attributes = await stat(path);
      if (!attributes.isFile()) throw new Error('目标不是普通文件。');
      if (attributes.size > MAX_AGENT_FILE_BYTES) {
        throw new Error(`文件为 ${attributes.size} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节读取限制。`);
      }
      const buffer = await readFile(path);
      if (buffer.length > MAX_AGENT_FILE_BYTES) {
        throw new Error(`文件读取结果为 ${buffer.length} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节限制。`);
      }
      return { path, content: assertUtf8Text(buffer, path), bytes: buffer.length, sha256: sha256(buffer) };
    }
    return this.withSftp(owner, terminalId, async (sftp) => {
      const root = await sftpRealpath(sftp, target.root);
      assertBoundRootUnchanged(target.root, root, 'ssh');
      const path = await sftpRealpath(sftp, target.requestedPath);
      assertWithinRoot(root, path, 'ssh');
      const attributes = await sftpStat(sftp, path);
      if (!attributes?.isFile()) throw new Error('目标不是普通文件。');
      if (attributes.size > MAX_AGENT_FILE_BYTES) {
        throw new Error(`文件为 ${attributes.size} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节读取限制。`);
      }
      const buffer = await sftpReadFile(sftp, path);
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
      const root = await realpath(target.root);
      assertBoundRootUnchanged(target.root, root, 'local');
      const path = await realpath(target.requestedPath);
      assertWithinRoot(root, path, 'local');
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(path, { withFileTypes: true });
      const limited = entries.slice(0, MAX_AGENT_DIRECTORY_ENTRIES);
      const mapped = await Promise.all(limited.map(async (entry) => {
        const entryPath = resolve(path, entry.name);
        const attributes = await lstat(entryPath);
        return {
          name: entry.name,
          type: entry.isDirectory()
            ? 'directory' as const
            : entry.isFile() ? 'file' as const : entry.isSymbolicLink() ? 'symlink' as const : 'other' as const,
          size: attributes.size,
        };
      }));
      return { path, entries: mapped, truncated: entries.length > limited.length };
    }
    return this.withSftp(owner, terminalId, async (sftp) => {
      const root = await sftpRealpath(sftp, target.root);
      assertBoundRootUnchanged(target.root, root, 'ssh');
      const path = await sftpRealpath(sftp, target.requestedPath);
      assertWithinRoot(root, path, 'ssh');
      const entries = await sftpReaddir(sftp, path);
      return {
        path,
        entries: entries.slice(0, MAX_AGENT_DIRECTORY_ENTRIES).map((entry) => ({
          name: entry.filename,
          type: entryType(entry.attrs),
          size: entry.attrs.size,
        })),
        truncated: entries.length > MAX_AGENT_DIRECTORY_ENTRIES,
      };
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
      const root = await realpath(target.root);
      assertBoundRootUnchanged(target.root, root, 'local');
      const parent = await realpath(dirname(target.requestedPath));
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
    return this.withSftp(owner, terminalId, async (sftp) => {
      const root = await sftpRealpath(sftp, target.root);
      assertBoundRootUnchanged(target.root, root, 'ssh');
      const parent = await sftpRealpath(sftp, posix.dirname(target.requestedPath));
      assertWithinRoot(root, parent, 'ssh');
      const path = posix.join(parent, posix.basename(target.requestedPath));
      const attributes = await sftpLstat(sftp, path);
      if (attributes?.isSymbolicLink()) throw new Error('不允许通过符号链接覆盖文件。');
      if (attributes && !attributes.isFile()) throw new Error('目标不是普通文件。');
      if (attributes && attributes.size > MAX_AGENT_FILE_BYTES) {
        throw new Error(`文件为 ${attributes.size} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节写入限制。`);
      }
      const current = attributes ? await sftpReadFile(sftp, path) : undefined;
      if (current && current.length > MAX_AGENT_FILE_BYTES) {
        throw new Error(`文件读取结果为 ${current.length} 字节，超过 ${MAX_AGENT_FILE_BYTES} 字节限制。`);
      }
      this.assertExpectedHash(path, current, expectedSha256);
      const temporary = posix.join(parent, `.ai-terminal-${randomUUID()}.tmp`);
      try {
        await sftpWriteFile(sftp, temporary, bytes, attributes?.mode);
        if (attributes) {
          await sftpAtomicReplace(sftp, temporary, path);
        } else {
          // Recheck absence immediately before the standard rename. Existing
          // targets require the OpenSSH atomic-overwrite extension above.
          if (await sftpLstat(sftp, path)) throw new Error('文件已在写入期间创建；请重新读取。');
          await sftpRename(sftp, temporary, path);
        }
      } catch (error) {
        await sftpUnlink(sftp, temporary).catch(() => undefined);
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
    const boundRoot = workspaceRoot ?? session.cwd;
    if (!boundRoot) throw new Error('当前会话工作目录未知；请先在终端显示一个 Shell 提示符。');
    if (session.transport === 'ssh') {
      const root = posix.normalize(boundRoot);
      if (!root.startsWith('/')) throw new Error('远程会话工作目录必须是绝对路径。');
      const path = posix.resolve(root, requestedPath);
      assertWithinRoot(root, path, 'ssh');
      return { transport: 'ssh', root, requestedPath: path };
    }
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

  private async withSftp<T>(
    owner: WebContents,
    terminalId: string,
    operation: (sftp: SFTPWrapper) => Promise<T>,
  ): Promise<T> {
    const sftp = await this.terminals.openSftp(owner, terminalId);
    try {
      return await operation(sftp);
    } finally {
      sftp.end();
    }
  }
}

export const AGENT_FILE_LIMITS = {
  maxBytes: MAX_AGENT_FILE_BYTES,
  maxEntries: MAX_AGENT_DIRECTORY_ENTRIES,
  maxPatchOperations: MAX_PATCH_OPERATIONS,
  maxPathChars: MAX_AGENT_PATH_CHARS,
  maxPatchInputBytes: MAX_PATCH_INPUT_BYTES,
} as const;
