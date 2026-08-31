import type { AgentFileAccessMode } from '../../shared/agent';
import type { ShellProfile } from '../../shared/terminal';
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
  shellKind?: ShellProfile['kind'];
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
const riskProperties = {
  riskLevel: { type: 'string', enum: ['normal', 'elevated'] },
  riskReason: string({ maxLength: 1_024 }),
};

function terminalTools(shellKind?: ShellProfile['kind']): AgentFunctionToolDefinition[] {
  const shellLabel = shellKind ?? 'current';
  return [
  tool(
    'terminal_execute',
    `Request execution of one command in the same visible ${shellLabel} terminal. `
      + 'Approval follows the selected mode: all operations, risky operations, or Complete Access. '
      + 'Use the direct file_* tools for filesystem work so results stay structured and do not pollute the terminal.',
    object({
      command: string({ minLength: 1, description: 'The single shell command to execute.' }),
      reason: string({ description: 'Optional one-line justification.' }),
      riskLevel: { type: 'string', enum: ['normal', 'elevated'], description: 'Set elevated to request review; it can never reduce software-classified risk.' },
    }, ['command']),
  ),
  tool(
    'terminal_read',
    'Read a budget-bounded page of exact visible terminal history. The first call returns the newest page; pass nextCursor to read the next older page.',
    object({
      maxChars: integer({ minimum: 100, maximum: 30_000 }),
      cursor: string({ minLength: 1, maxLength: 512 }),
    }),
  ),
  tool(
    'terminal_state',
    'Get the current terminal transport, shell, cwd/user, and control state.',
    object({}),
  ),
  ];
}

const WORKSPACE_READ_TOOLS: readonly AgentFunctionToolDefinition[] = [
  tool(
    'file_list',
    'List one bounded directory directly. Relative paths start at the informational Workspace/default file root; absolute paths are supported.',
    object({
      ...riskProperties,
      path: { ...optionalPath, description: 'Directory path relative to the default file root; absolute paths are accepted.' },
    }),
  ),
  tool(
    'file_read',
    'Read one needed, bounded text file directly and return its SHA-256. '
      + 'Supports UTF-8 and Windows GBK (ANSI) encodings; edits keep the file\'s original encoding. '
      + 'Use startLine/endLine for a targeted range and pass nextCursor to continue a truncated page. '
      + 'Prefer small reads; never use cat/Get-Content/type in the terminal for this. Sensitive paths may require approval.',
    object({
      ...riskProperties,
      path: { ...path, description: 'File path relative to the default file root; absolute paths are accepted.' },
      startLine: integer({ minimum: 1, maximum: 10_000_000 }),
      endLine: integer({ minimum: 1, maximum: 10_000_000 }),
      cursor: string({ minLength: 1, maxLength: 2_048 }),
    }, ['path']),
  ),
  tool(
    'file_stat',
    'Inspect one file, directory, or symbolic link without reading its contents.',
    object({ ...riskProperties, path }, ['path']),
  ),
  tool(
    'file_search',
    'Search bounded text files for literal text and return structured line/column previews. Pass nextCursor to continue a truncated result page.',
    object({
      ...riskProperties,
      query: string({ minLength: 1, maxLength: 4_096 }),
      path: optionalPath,
      maxResults: integer({ minimum: 1, maximum: 200 }),
      cursor: string({ minLength: 1, maxLength: 2_048 }),
    }, ['query']),
  ),
  tool(
    'file_glob',
    'Find bounded paths matching a glob pattern; pass nextCursor to continue a truncated result page.',
    object({
      ...riskProperties,
      pattern: string({ minLength: 1, maxLength: 4_096 }),
      path: optionalPath,
      maxResults: integer({ minimum: 1, maximum: 500 }),
      cursor: string({ minLength: 1, maxLength: 2_048 }),
    }, ['pattern']),
  ),
];

const WORKSPACE_WRITE_TOOLS: readonly AgentFunctionToolDefinition[] = [
  tool(
    'file_patch',
    'Preferred way to modify an existing file. Atomically apply exact, unique text replacements and return a diff. '
      + 'Works on UTF-8 and Windows GBK (ANSI) text; the file keeps its original encoding on write-back. '
      + 'expectedSha256 must come from the latest file_read; re-read after a conflict.',
    object({
      ...riskProperties,
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
    'file_write',
    'Atomically create or replace one bounded UTF-8 text file. For an existing file prefer file_patch; pass null only when the path must not exist.',
    object({
      ...riskProperties,
      path,
      content: string({ maxLength: 131_072 }),
      expectedSha256: { anyOf: [sha256, { type: 'null' }] },
    }, ['path', 'content', 'expectedSha256']),
  ),
  tool(
    'file_mkdir',
    'Create one directory directly without running a shell command.',
    object({ ...riskProperties, path }, ['path']),
  ),
  tool(
    'file_rename',
    'Rename or move one path to another path on the same filesystem.',
    object({ ...riskProperties, source: path, destination: path }, ['source', 'destination']),
  ),
  tool(
    'file_delete',
    'Delete one path. Recursive directory deletion must be explicitly requested and is reviewed in All/Risky modes.',
    object({ ...riskProperties, path, recursive: { type: 'boolean' } }, ['path']),
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
  const tools = terminalTools(exposure.shellKind);
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
    shellKind: gateway.context.terminal.shellKind,
  });
}
