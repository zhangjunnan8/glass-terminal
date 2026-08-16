import { isAbsolute, relative, resolve } from 'node:path';
import { posix } from 'node:path';
import type {
  WorkspaceGlobResult,
  WorkspaceSearchMatch,
  WorkspaceSearchResult,
} from '../../shared/tools';
import type {
  FilesystemBackend,
  RemoteFileStat,
} from './remote-filesystem';

export type WorkspacePathFlavor = 'local' | 'ssh';

export interface WorkspaceTraversalLimits {
  maxDepth: number;
  maxEntries: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDurationMs: number;
  defaultMaxResults: number;
  maxResults: number;
  maxQueryBytes: number;
  maxPatternChars: number;
  maxGlobWildcards: number;
  maxCandidateChars: number;
  maxPreviewChars: number;
}

export const DEFAULT_WORKSPACE_TRAVERSAL_LIMITS: Readonly<WorkspaceTraversalLimits> = {
  maxDepth: 32,
  maxEntries: 10_000,
  maxFiles: 2_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxDurationMs: 10_000,
  defaultMaxResults: 100,
  maxResults: 500,
  maxQueryBytes: 16 * 1024,
  maxPatternChars: 2_048,
  maxGlobWildcards: 128,
  maxCandidateChars: 4_096,
  maxPreviewChars: 240,
};

export interface WorkspaceSearchOptions {
  maxResults?: number;
}

export interface WorkspaceGlobOptions {
  maxResults?: number;
}

interface WalkEntry {
  path: string;
  stat: RemoteFileStat;
}

interface WalkState {
  entriesVisited: number;
  truncated: boolean;
}

type WalkDecision = 'continue' | 'stop';

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeEntryName(name: string, flavor: WorkspacePathFlavor): boolean {
  return Boolean(name)
    && name !== '.'
    && name !== '..'
    && !name.includes('\0')
    && !name.includes('/')
    && (flavor !== 'local' || process.platform !== 'win32' || !name.includes('\\'));
}

function joinPath(flavor: WorkspacePathFlavor, parent: string, name: string): string {
  return flavor === 'ssh' ? posix.join(parent, name) : resolve(parent, name);
}

function relativePath(flavor: WorkspacePathFlavor, root: string, path: string): string {
  return flavor === 'ssh' ? posix.relative(root, path) : relative(root, path);
}

function pathIsAbsolute(flavor: WorkspacePathFlavor, path: string): boolean {
  return flavor === 'ssh' ? posix.isAbsolute(path) : isAbsolute(path);
}

function assertWithinRoot(
  flavor: WorkspacePathFlavor,
  root: string,
  path: string,
): void {
  const candidate = relativePath(flavor, root, path);
  const separator = flavor === 'ssh' ? '/' : process.platform === 'win32' ? '\\' : '/';
  if (
    candidate === '..'
    || candidate.startsWith(`..${separator}`)
    || pathIsAbsolute(flavor, candidate)
  ) throw new Error('Workspace traversal escaped its bound root.');
}

function pathsEqual(flavor: WorkspacePathFlavor, left: string, right: string): boolean {
  if (flavor === 'ssh') return posix.normalize(left) === posix.normalize(right);
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function boundedMaxResults(
  requested: number | undefined,
  limits: Readonly<WorkspaceTraversalLimits>,
): number {
  if (requested === undefined) return limits.defaultMaxResults;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error('maxResults 必须是正整数。');
  }
  return Math.min(requested, limits.maxResults);
}

async function walkWorkspace(
  filesystem: FilesystemBackend,
  flavor: WorkspacePathFlavor,
  root: string,
  startDirectory: string,
  limits: Readonly<WorkspaceTraversalLimits>,
  deadline: number,
  visit: (entry: WalkEntry) => Promise<WalkDecision>,
): Promise<WalkState> {
  const state: WalkState = { entriesVisited: 0, truncated: false };

  const walkDirectory = async (directory: string, depth: number): Promise<boolean> => {
    if (Date.now() > deadline) {
      state.truncated = true;
      return false;
    }

    // Revalidate immediately before listing. This catches a directory swapped
    // for a symlink since its parent was enumerated. SFTP/Node path APIs cannot
    // fully remove the remaining check-to-open race, but no discovered symlink
    // is intentionally followed.
    try {
      const canonicalDirectory = await filesystem.realpath(directory);
      assertWithinRoot(flavor, root, canonicalDirectory);
      if (!pathsEqual(flavor, directory, canonicalDirectory)) {
        state.truncated = true;
        if (depth === 0) throw new Error('Workspace 目录已被替换为符号链接。');
        return true;
      }
    } catch (error) {
      if (depth === 0) throw error;
      state.truncated = true;
      return true;
    }

    let entries;
    try {
      entries = await filesystem.listDirectory(directory);
    } catch (error) {
      if (depth === 0) throw error;
      state.truncated = true;
      return true;
    }
    if (Date.now() > deadline) {
      state.truncated = true;
      return false;
    }

    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const listedEntry of entries) {
      if (Date.now() > deadline) {
        state.truncated = true;
        return false;
      }
      if (state.entriesVisited >= limits.maxEntries) {
        state.truncated = true;
        return false;
      }
      state.entriesVisited += 1;

      if (!safeEntryName(listedEntry.name, flavor)) {
        state.truncated = true;
        continue;
      }
      const path = joinPath(flavor, directory, listedEntry.name);
      assertWithinRoot(flavor, root, path);

      // Do not trust cached/readdir attributes for a security decision. lstat
      // observes the final path component without following a symlink.
      let stat: RemoteFileStat | undefined;
      try {
        stat = await filesystem.lstat(path);
      } catch {
        state.truncated = true;
        continue;
      }
      if (!stat) continue;
      if (Date.now() > deadline) {
        state.truncated = true;
        return false;
      }

      if (await visit({ path, stat }) === 'stop') return false;
      if (stat.type !== 'directory') continue;

      const childDepth = depth + 1;
      if (childDepth >= limits.maxDepth) {
        state.truncated = true;
        continue;
      }
      if (!await walkDirectory(path, childDepth)) return false;
    }
    return true;
  };

  await walkDirectory(startDirectory, 0);
  return state;
}

function decodeSearchableText(buffer: Buffer): string | undefined {
  if (buffer.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = content.indexOf('\n'); index >= 0; index = content.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function lineIndexAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle;
  }
  return low;
}

function previewAt(
  content: string,
  starts: number[],
  offset: number,
  maxChars: number,
): Omit<WorkspaceSearchMatch, 'path'> {
  const lineIndex = lineIndexAt(starts, offset);
  const start = starts[lineIndex]!;
  const rawEnd = content.indexOf('\n', start);
  const end = rawEnd < 0 ? content.length : rawEnd;
  const line = content.slice(start, end).replace(/\r$/u, '');
  const codeUnitColumn = Math.max(0, offset - start);
  const column = Array.from(line.slice(0, codeUnitColumn)).length + 1;
  const scrub = (value: string) => value.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu,
    '\uFFFD',
  );
  if (line.length <= maxChars) {
    return { line: lineIndex + 1, column, preview: scrub(line) };
  }
  const windowStart = Math.max(0, Math.min(codeUnitColumn - 60, line.length - maxChars));
  const windowEnd = Math.min(line.length, windowStart + maxChars);
  return {
    line: lineIndex + 1,
    column,
    preview: scrub(`${windowStart > 0 ? '…' : ''}${line.slice(windowStart, windowEnd)}${windowEnd < line.length ? '…' : ''}`),
  };
}

async function readSearchFile(
  filesystem: FilesystemBackend,
  entry: WalkEntry,
  query: string,
  flavor: WorkspacePathFlavor,
  root: string,
  limits: Readonly<WorkspaceTraversalLimits>,
  maxReadBytes: number,
  matches: WorkspaceSearchMatch[],
  maxResults: number,
): Promise<{
  bytes: number;
  scanned: boolean;
  hasOverflowMatch: boolean;
  incomplete: boolean;
}> {
  if (entry.stat.size < 0 || entry.stat.size > limits.maxFileBytes) {
    return { bytes: 0, scanned: false, hasOverflowMatch: false, incomplete: true };
  }
  let buffer: Buffer;
  try {
    const canonicalPath = await filesystem.realpath(entry.path);
    assertWithinRoot(flavor, root, canonicalPath);
    if (!pathsEqual(flavor, entry.path, canonicalPath)) {
      return { bytes: 0, scanned: false, hasOverflowMatch: false, incomplete: true };
    }
    const currentStat = await filesystem.lstat(entry.path);
    if (currentStat?.type !== 'file') {
      return { bytes: 0, scanned: false, hasOverflowMatch: false, incomplete: true };
    }
    buffer = await filesystem.readFile(entry.path, maxReadBytes);
  } catch {
    return { bytes: 0, scanned: false, hasOverflowMatch: false, incomplete: true };
  }
  if (buffer.length > maxReadBytes) {
    return { bytes: maxReadBytes, scanned: true, hasOverflowMatch: false, incomplete: true };
  }
  const content = decodeSearchableText(buffer);
  if (content === undefined) {
    return { bytes: buffer.length, scanned: true, hasOverflowMatch: false, incomplete: false };
  }

  const starts = lineStarts(content);
  for (
    let offset = content.indexOf(query);
    offset >= 0;
    offset = content.indexOf(query, offset + query.length)
  ) {
    if (matches.length >= maxResults) {
      return { bytes: buffer.length, scanned: true, hasOverflowMatch: true, incomplete: false };
    }
    matches.push({
      path: entry.path,
      ...previewAt(content, starts, offset, limits.maxPreviewChars),
    });
  }
  return { bytes: buffer.length, scanned: true, hasOverflowMatch: false, incomplete: false };
}

export async function searchWorkspace(
  filesystem: FilesystemBackend,
  flavor: WorkspacePathFlavor,
  root: string,
  start: string,
  query: string,
  options: WorkspaceSearchOptions = {},
  limits: Readonly<WorkspaceTraversalLimits> = DEFAULT_WORKSPACE_TRAVERSAL_LIMITS,
): Promise<WorkspaceSearchResult> {
  if (!query || query.includes('\0')) throw new Error('搜索文本不能为空或包含 NUL 字节。');
  if (Buffer.byteLength(query, 'utf8') > limits.maxQueryBytes) {
    throw new Error(`搜索文本超过 ${limits.maxQueryBytes} 字节限制。`);
  }
  const maxResults = boundedMaxResults(options.maxResults, limits);
  const matches: WorkspaceSearchMatch[] = [];
  const deadline = Date.now() + limits.maxDurationMs;
  let filesScanned = 0;
  let filesConsidered = 0;
  let bytesScanned = 0;
  let truncated = false;

  const startStat = await filesystem.lstat(start);
  if (!startStat) throw new Error('搜索起点不存在。');
  if (startStat.type === 'symlink') throw new Error('搜索起点不能是符号链接。');
  if (startStat.type !== 'file' && startStat.type !== 'directory') {
    throw new Error('搜索起点必须是普通文件或目录。');
  }
  assertWithinRoot(flavor, root, start);

  const visit = async (entry: WalkEntry): Promise<WalkDecision> => {
    if (entry.stat.type !== 'file') return 'continue';
    if (filesConsidered >= limits.maxFiles) {
      truncated = true;
      return 'stop';
    }
    filesConsidered += 1;
    if (
      entry.stat.size > limits.maxFileBytes
      || bytesScanned + Math.max(0, entry.stat.size) > limits.maxTotalBytes
    ) {
      truncated = true;
      if (entry.stat.size > limits.maxFileBytes) return 'continue';
      return 'stop';
    }
    const result = await readSearchFile(
      filesystem,
      entry,
      query,
      flavor,
      root,
      limits,
      Math.min(limits.maxFileBytes, limits.maxTotalBytes - bytesScanned),
      matches,
      maxResults,
    );
    if (result.scanned) filesScanned += 1;
    bytesScanned += result.bytes;
    if (result.incomplete) truncated = true;
    if (result.hasOverflowMatch || Date.now() > deadline) {
      truncated = true;
      return 'stop';
    }
    return 'continue';
  };

  if (startStat.type === 'file') {
    const result = await visit({ path: start, stat: startStat });
    if (result === 'stop') truncated = true;
  } else {
    const walk = await walkWorkspace(
      filesystem,
      flavor,
      root,
      start,
      limits,
      deadline,
      visit,
    );
    truncated ||= walk.truncated;
  }

  matches.sort((left, right) => (
    compareNames(left.path, right.path)
    || left.line - right.line
    || left.column - right.column
  ));
  return { query, matches, filesScanned, truncated };
}

type GlobToken =
  | { type: 'literal'; value: string }
  | { type: 'single' }
  | { type: 'star' }
  | { type: 'globstar' }
  | { type: 'globstar-slash' };

function globTokens(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '?') {
      tokens.push({ type: 'single' });
      continue;
    }
    if (character !== '*') {
      tokens.push({ type: 'literal', value: character });
      continue;
    }
    let end = index;
    while (pattern[end + 1] === '*') end += 1;
    const globstar = end > index;
    index = end;
    if (globstar && pattern[index + 1] === '/') {
      index += 1;
      tokens.push({ type: 'globstar-slash' });
    } else {
      tokens.push({ type: globstar ? 'globstar' : 'star' });
    }
  }
  return tokens;
}

/** Bounded dynamic-programming matcher; it avoids regex backtracking. */
function matchesGlob(tokens: GlobToken[], candidate: string): boolean {
  let previous = new Uint8Array(candidate.length + 1);
  previous[0] = 1;
  for (const token of tokens) {
    const current = new Uint8Array(candidate.length + 1);
    if (token.type === 'literal' || token.type === 'single') {
      for (let index = 1; index <= candidate.length; index += 1) {
        const character = candidate[index - 1]!;
        if (
          previous[index - 1]
          && (
            token.type === 'literal'
              ? character === token.value
              : character !== '/'
          )
        ) current[index] = 1;
      }
    } else if (token.type === 'star' || token.type === 'globstar') {
      current[0] = previous[0]!;
      for (let index = 1; index <= candidate.length; index += 1) {
        const canConsume = token.type === 'globstar' || candidate[index - 1] !== '/';
        if (previous[index] || (canConsume && current[index - 1])) current[index] = 1;
      }
    } else {
      // **/ may consume no directory or any prefix ending at a slash.
      let active = Boolean(previous[0]);
      current[0] = previous[0]!;
      for (let index = 1; index <= candidate.length; index += 1) {
        active ||= Boolean(previous[index]);
        if (previous[index] || (active && candidate[index - 1] === '/')) current[index] = 1;
      }
    }
    previous = current;
  }
  return Boolean(previous[candidate.length]);
}

function normalizedGlobPattern(
  flavor: WorkspacePathFlavor,
  pattern: string,
  limits: Readonly<WorkspaceTraversalLimits>,
): string {
  if (!pattern || pattern.includes('\0') || pattern.length > limits.maxPatternChars) {
    throw new Error(`Glob 模式不能为空、包含 NUL，且不能超过 ${limits.maxPatternChars} 字符。`);
  }
  const normalized = (
    flavor === 'local' && process.platform === 'win32'
      ? pattern.replace(/\\/gu, '/')
      : pattern
  ).replace(/^\.\//u, '');
  const windowsLocal = flavor === 'local' && process.platform === 'win32';
  if (
    normalized.startsWith('/')
    || (windowsLocal && /^[A-Za-z]:/u.test(normalized))
    || (windowsLocal && /^(?:\\\\|\/\/)/u.test(normalized))
    || normalized.split('/').includes('..')
  ) throw new Error('Glob 模式必须相对于搜索起点且不能包含 ..。');
  const wildcardCount = Array.from(normalized).filter((character) => (
    character === '*' || character === '?'
  )).length;
  if (wildcardCount > limits.maxGlobWildcards) {
    throw new Error(`Glob 通配符数量超过 ${limits.maxGlobWildcards} 限制。`);
  }
  return normalized;
}

export async function globWorkspace(
  filesystem: FilesystemBackend,
  flavor: WorkspacePathFlavor,
  root: string,
  startDirectory: string,
  pattern: string,
  options: WorkspaceGlobOptions = {},
  limits: Readonly<WorkspaceTraversalLimits> = DEFAULT_WORKSPACE_TRAVERSAL_LIMITS,
): Promise<WorkspaceGlobResult> {
  const normalizedPattern = normalizedGlobPattern(flavor, pattern, limits);
  const tokens = globTokens(normalizedPattern);
  const maxResults = boundedMaxResults(options.maxResults, limits);
  const paths: string[] = [];
  const deadline = Date.now() + limits.maxDurationMs;
  let overflow = false;

  const startStat = await filesystem.lstat(startDirectory);
  if (!startStat) throw new Error('Glob 起点不存在。');
  if (startStat.type === 'symlink') throw new Error('Glob 起点不能是符号链接。');
  if (startStat.type !== 'directory') throw new Error('Glob 起点必须是目录。');
  assertWithinRoot(flavor, root, startDirectory);

  const walk = await walkWorkspace(
    filesystem,
    flavor,
    root,
    startDirectory,
    limits,
    deadline,
    async (entry) => {
      const rawCandidate = relativePath(flavor, startDirectory, entry.path);
      const candidate = flavor === 'local' && process.platform === 'win32'
        ? rawCandidate.replace(/\\/gu, '/')
        : rawCandidate;
      if (candidate.length > limits.maxCandidateChars) {
        overflow = true;
        return 'stop';
      }
      if (!matchesGlob(tokens, candidate)) return 'continue';
      if (paths.length >= maxResults) {
        overflow = true;
        return 'stop';
      }
      paths.push(entry.path);
      return 'continue';
    },
  );
  paths.sort(compareNames);
  return { pattern, paths, truncated: overflow || walk.truncated };
}
