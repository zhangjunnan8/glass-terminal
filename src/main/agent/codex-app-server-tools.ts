import type { AgentFileAccessMode } from '../../shared/agent';
import type { ToolGateway, WorkspaceTool } from '../../shared/tools';
import type { CodexAppServerDynamicToolDefinition } from '../app-server/app-server-turn-runner';
import { agentToolDefinitionsForAccess } from './agent-tool-definitions';
import {
  continuationFingerprint,
  decodeOffsetCursor,
  encodeOffsetCursor,
  prepareWorkspaceReadPage,
  renderWorkspaceReadPage,
} from './agent-tool-pagination';

const MAX_RESULT_CONTENT_CHARS = 30_000;
const MAX_LIST_ENTRIES = 200;
const MAX_DYNAMIC_RESULT_BYTES = 64 * 1024;

function requireString(
  args: Record<string, unknown>,
  field: string,
  tool: string,
): string {
  const value = args[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${tool}.${field} must be a non-empty string.`);
  }
  return value;
}

function requirePath(
  args: Record<string, unknown>,
  tool: string,
  field = 'path',
): string {
  const value = requireString(args, field, tool);
  if (value.length > 4_096) throw new Error(`${tool}.${field} exceeds 4096 characters.`);
  return value;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Expected an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function requireWorkspace(
  gateway: ToolGateway,
  fileAccessMode: AgentFileAccessMode,
  tool: string,
): WorkspaceTool {
  if (fileAccessMode === 'off' || !gateway.workspace) {
    throw new Error(`${tool} requires an authorized Workspace Root.`);
  }
  return gateway.workspace;
}

function boundedText(value: string): { value: string; truncated: boolean } {
  if (value.length <= MAX_RESULT_CONTENT_CHARS) return { value, truncated: false };
  return { value: value.slice(0, MAX_RESULT_CONTENT_CHARS), truncated: true };
}

function largestFittingPrefix<T>(
  values: readonly T[],
  candidate: (count: number) => unknown,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(candidate(middle)), 'utf8') <= MAX_DYNAMIC_RESULT_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

export function codexDynamicToolDefinitions(
  gateway: ToolGateway,
  fileAccessMode: AgentFileAccessMode,
  exposeWorkspaceTools: boolean,
): CodexAppServerDynamicToolDefinition[] {
  const permissions = gateway.context.permissions.workspace;
  return agentToolDefinitionsForAccess({
    fileAccessMode,
    workspaceAvailable: exposeWorkspaceTools && Boolean(gateway.workspace),
    workspaceEnabled: exposeWorkspaceTools && permissions.enabled,
    workspaceRead: exposeWorkspaceTools && permissions.read,
    shellKind: gateway.context.terminal.shellKind,
  })
    .filter(({ function: definition }) => (
      definition.name !== 'terminal_read' && definition.name !== 'terminal_state'
    ))
    .map(({ function: definition }) => ({
      type: 'function',
      name: definition.name,
      description: definition.name === 'terminal_execute'
        ? 'Request execution of one command exactly once in the same visible terminal. Every native Codex command requires explicit user approval, streams live output to that public terminal, and returns its final structured result. Filesystem reads and edits must use the workspace mechanism described by the current binding.'
        : definition.description,
      deferLoading: false,
      inputSchema: definition.parameters,
    }));
}

export async function executeCodexDynamicTool(
  gateway: ToolGateway,
  fileAccessMode: AgentFileAccessMode,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'terminal_execute': {
      const result = await gateway.terminal.execute(
        requireString(args, 'command', name),
        typeof args.reason === 'string' ? args.reason : undefined,
      );
      const output = boundedText(result.output);
      return {
        ok: result.status === 'completed',
        ...result,
        output: output.value,
        ...(output.truncated ? { outputTruncated: true } : {}),
      };
    }
    case 'workspace_list': {
      const workspace = requireWorkspace(gateway, fileAccessMode, name);
      const listed = await workspace.listDirectory(
        typeof args.path === 'string' ? args.path : '.',
      );
      const entries = listed.entries.slice(0, MAX_LIST_ENTRIES);
      const candidate = (count: number) => ({
        ok: true,
        path: listed.path,
        entries: entries.slice(0, count),
        truncated: listed.truncated || count < listed.entries.length,
      });
      return candidate(largestFittingPrefix(entries, candidate));
    }
    case 'workspace_read_file': {
      const workspace = requireWorkspace(gateway, fileAccessMode, name);
      const requestedPath = requirePath(args, name);
      return renderWorkspaceReadPage(
        prepareWorkspaceReadPage(await workspace.readFile(requestedPath), requestedPath, args),
        MAX_RESULT_CONTENT_CHARS,
      );
    }
    case 'workspace_stat':
      return {
        ok: true,
        ...await requireWorkspace(gateway, fileAccessMode, name).stat(requirePath(args, name)),
      };
    case 'workspace_search': {
      const workspace = requireWorkspace(gateway, fileAccessMode, name);
      const query = requireString(args, 'query', name);
      const path = typeof args.path === 'string' ? args.path : '.';
      const fingerprint = continuationFingerprint('workspace-search', { query, path });
      const offset = decodeOffsetCursor(
        typeof args.cursor === 'string' ? args.cursor : undefined,
        'workspace-search',
        fingerprint,
      );
      const pageSize = boundedInteger(args.maxResults, 100, 1, 200);
      const result = await workspace.search(query, { path, maxResults: pageSize, resultOffset: offset });
      const candidate = (count: number) => {
        const hasMore = count < result.matches.length || result.nextOffset !== undefined;
        const nextOffset = hasMore ? offset + count : undefined;
        return {
        ok: true,
        query: result.query,
        matches: result.matches.slice(0, count),
        filesScanned: result.filesScanned,
        truncated: result.truncated || count < result.matches.length,
        ...(nextOffset !== undefined && nextOffset <= 10_000
          ? { nextCursor: encodeOffsetCursor('workspace-search', fingerprint, nextOffset) }
          : {}),
        };
      };
      const count = largestFittingPrefix(result.matches, candidate);
      if (result.matches.length > 0 && count === 0) {
        throw new Error('workspace_search result metadata exceeds the safe dynamic-tool limit.');
      }
      return candidate(count);
    }
    case 'workspace_glob': {
      const workspace = requireWorkspace(gateway, fileAccessMode, name);
      const pattern = requireString(args, 'pattern', name);
      const path = typeof args.path === 'string' ? args.path : '.';
      const fingerprint = continuationFingerprint('workspace-glob', { pattern, path });
      const offset = decodeOffsetCursor(
        typeof args.cursor === 'string' ? args.cursor : undefined,
        'workspace-glob',
        fingerprint,
      );
      const pageSize = boundedInteger(args.maxResults, 100, 1, 500);
      const result = await workspace.glob(pattern, { path, maxResults: pageSize, resultOffset: offset });
      const candidate = (count: number) => {
        const hasMore = count < result.paths.length || result.nextOffset !== undefined;
        const nextOffset = hasMore ? offset + count : undefined;
        return {
        ok: true,
        pattern: result.pattern,
        paths: result.paths.slice(0, count),
        truncated: result.truncated || count < result.paths.length,
        ...(nextOffset !== undefined && nextOffset <= 10_000
          ? { nextCursor: encodeOffsetCursor('workspace-glob', fingerprint, nextOffset) }
          : {}),
        };
      };
      const count = largestFittingPrefix(result.paths, candidate);
      if (result.paths.length > 0 && count === 0) {
        throw new Error('workspace_glob result metadata exceeds the safe dynamic-tool limit.');
      }
      return candidate(count);
    }
    case 'workspace_apply_patch': {
      const result = await requireWorkspace(gateway, fileAccessMode, name).applyPatch(
        requirePath(args, name),
        requireString(args, 'expectedSha256', name),
        args.patches as never,
      );
      const diff = typeof result.diff === 'string' ? boundedText(result.diff) : undefined;
      return {
        ok: true,
        ...result,
        ...(diff ? { diff: diff.value, diffTruncated: result.diffTruncated || diff.truncated } : {}),
      };
    }
    case 'workspace_write_file': {
      const expectedSha256 = args.expectedSha256;
      if (expectedSha256 !== null && typeof expectedSha256 !== 'string') {
        throw new Error('workspace_write_file.expectedSha256 must be a SHA-256 string or null.');
      }
      const result = await requireWorkspace(gateway, fileAccessMode, name).writeFile(
        requirePath(args, name),
        typeof args.content === 'string' ? args.content : (() => { throw new Error('workspace_write_file.content must be a string.'); })(),
        expectedSha256,
      );
      const diff = typeof result.diff === 'string' ? boundedText(result.diff) : undefined;
      return {
        ok: true,
        ...result,
        ...(diff ? { diff: diff.value, diffTruncated: result.diffTruncated || diff.truncated } : {}),
      };
    }
    case 'workspace_mkdir': {
      const path = requirePath(args, name);
      await requireWorkspace(gateway, fileAccessMode, name).mkdir(path);
      return { ok: true, path };
    }
    case 'workspace_rename': {
      const source = requirePath(args, name, 'source');
      const destination = requirePath(args, name, 'destination');
      await requireWorkspace(gateway, fileAccessMode, name).rename(source, destination);
      return { ok: true, source, destination };
    }
    case 'workspace_delete': {
      const path = requirePath(args, name);
      const recursive = args.recursive === true;
      await requireWorkspace(gateway, fileAccessMode, name).delete(path, { recursive });
      return { ok: true, path, recursive };
    }
    default:
      throw new Error(`Unsupported App Server dynamic tool: ${name}`);
  }
}
