import type { AgentFileAccessMode } from '../../shared/agent';
import type { ToolGateway } from '../../shared/tools';

export interface AgentFunctionToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentToolExposure {
  fileAccessMode: AgentFileAccessMode;
  workspaceAvailable: boolean;
  workspaceEnabled: boolean;
  workspaceRead: boolean;
}

const string = (
  constraints: Record<string, unknown> = {},
): Record<string, unknown> => ({ type: 'string', ...constraints });
const integer = (
  constraints: Record<string, unknown> = {},
): Record<string, unknown> => ({ type: 'integer', ...constraints });
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const tool = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): AgentFunctionToolDefinition => ({
  type: 'function',
  function: { name, description, parameters },
});

const path = string({ minLength: 1, maxLength: 4_096 });
const optionalPath = string({ maxLength: 4_096 });
const sha256 = string({ pattern: '^[a-fA-F0-9]{64}$' });

const TERMINAL_TOOLS: readonly AgentFunctionToolDefinition[] = [
  tool(
    'terminal_execute',
    'Request execution of one command in the same visible terminal. '
      + 'User approval is required unless Full Takeover is explicitly active.',
    object({
      command: string({ minLength: 1, description: 'The single shell command to execute.' }),
      reason: string({ description: 'Optional one-line justification.' }),
    }, ['command']),
  ),
  tool(
    'terminal_read',
    'Read a bounded recent portion of the exact visible terminal history.',
    object({ maxChars: integer({ minimum: 100, maximum: 30_000 }) }),
  ),
  tool(
    'terminal_state',
    'Get the current terminal transport, shell, cwd/user, and control state.',
    object({}),
  ),
];

const WORKSPACE_READ_TOOLS: readonly AgentFunctionToolDefinition[] = [
  tool(
    'workspace_list',
    'List one bounded directory inside the explicit Workspace Root without running a shell command.',
    object({
      path: { ...optionalPath, description: 'Directory path relative to the Workspace Root.' },
    }),
  ),
  tool(
    'workspace_read_file',
    'Read one needed, bounded text file inside the Workspace Root and return its SHA-256. '
      + 'Supports UTF-8 and Windows GBK (ANSI) encodings; edits keep the file\'s original encoding. '
      + 'Prefer small, targeted reads; never use cat/Get-Content/type in the terminal for this.',
    object({
      path: { ...path, description: 'File path relative to the Workspace Root.' },
    }, ['path']),
  ),
  tool(
    'workspace_stat',
    'Inspect one file, directory, or symbolic link inside the Workspace Root without reading its contents.',
    object({ path }, ['path']),
  ),
  tool(
    'workspace_search',
    'Search bounded UTF-8 workspace files for literal text and return structured line/column previews. Use this instead of grep in the terminal.',
    object({
      query: string({ minLength: 1, maxLength: 4_096 }),
      path: optionalPath,
      maxResults: integer({ minimum: 1, maximum: 200 }),
    }, ['query']),
  ),
  tool(
    'workspace_glob',
    'Find bounded workspace paths matching a glob pattern without running find, dir, or another shell command.',
    object({
      pattern: string({ minLength: 1, maxLength: 4_096 }),
      path: optionalPath,
      maxResults: integer({ minimum: 1, maximum: 500 }),
    }, ['pattern']),
  ),
];

const WORKSPACE_WRITE_TOOLS: readonly AgentFunctionToolDefinition[] = [
  tool(
    'workspace_apply_patch',
    'Preferred way to modify an existing file. Atomically apply exact, unique text replacements and return a diff. '
      + 'Works on UTF-8 and Windows GBK (ANSI) text; the file keeps its original encoding on write-back. '
      + 'expectedSha256 must come from the latest workspace_read_file; re-read after a conflict.',
    object({
      path,
      expectedSha256: sha256,
      patches: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: object({
          search: string({ minLength: 1, maxLength: 131_072 }),
          replace: string({ maxLength: 131_072 }),
        }, ['search', 'replace']),
      },
    }, ['path', 'expectedSha256', 'patches']),
  ),
  tool(
    'workspace_write_file',
    'Atomically create one bounded UTF-8 text file. For an existing file prefer workspace_apply_patch; pass null only when the path must not exist.',
    object({
      path,
      content: string({ maxLength: 131_072 }),
      expectedSha256: { anyOf: [sha256, { type: 'null' }] },
    }, ['path', 'content', 'expectedSha256']),
  ),
  tool(
    'workspace_mkdir',
    'Create one directory inside the Workspace Root without running a shell command.',
    object({ path }, ['path']),
  ),
  tool(
    'workspace_rename',
    'Rename or move one workspace path to another path inside the same Workspace Root.',
    object({ source: path, destination: path }, ['source', 'destination']),
  ),
  tool(
    'workspace_delete',
    'Delete one workspace path. Recursive directory deletion must be explicitly requested.',
    object({ path, recursive: { type: 'boolean' } }, ['path']),
  ),
];

/**
 * Returns the exact OpenAI-compatible function definitions bound for a turn.
 * Keeping selection and schemas here makes estimation and Provider dispatch use
 * the same serialized objects instead of maintaining a second approximation.
 */
export function agentToolDefinitionsForAccess(
  exposure: AgentToolExposure,
): AgentFunctionToolDefinition[] {
  const tools = [...TERMINAL_TOOLS];
  if (
    !exposure.workspaceAvailable
    || !exposure.workspaceEnabled
    || exposure.fileAccessMode === 'off'
  ) return tools;
  if (exposure.workspaceRead) tools.push(...WORKSPACE_READ_TOOLS);
  if (
    exposure.fileAccessMode === 'read-write'
    || exposure.fileAccessMode === 'full-access'
  ) tools.push(...WORKSPACE_WRITE_TOOLS);
  return tools;
}

export function boundAgentToolDefinitions(
  gateway: ToolGateway,
  fileAccessMode: AgentFileAccessMode,
): AgentFunctionToolDefinition[] {
  const permissions = gateway.context.permissions.workspace;
  return agentToolDefinitionsForAccess({
    fileAccessMode,
    workspaceAvailable: Boolean(gateway.workspace),
    workspaceEnabled: permissions.enabled,
    workspaceRead: permissions.read,
  });
}
