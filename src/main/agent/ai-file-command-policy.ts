import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ShellProfile } from '../../shared/terminal';
import type { WorkspaceToolPermissions } from '../../shared/tools';

export type FileCommandCategory = 'read' | 'search' | 'list' | 'stat';
export type FileCommandPolicyDisposition =
  | 'allow'
  | 'workspace-tool-required'
  | 'exception-approval';

export interface FileCommandPolicyInput {
  command: string;
  shellKind: ShellProfile['kind'];
  workspace: WorkspaceToolPermissions;
}

export interface FileCommandPolicyResult {
  disposition: FileCommandPolicyDisposition;
  categories: FileCommandCategory[];
  commandNames: string[];
  suggestedTools: string[];
  reasonCode?:
    | 'WORKSPACE_TOOL_EQUIVALENT'
    | 'WORKSPACE_TOOLS_UNAVAILABLE'
    | 'WORKSPACE_SCOPE_INSUFFICIENT'
    | 'NON_EQUIVALENT_TERMINAL_SEMANTICS';
}

export interface WorkspaceToolPolicyErrorResult {
  ok: false;
  code: 'WORKSPACE_TOOL_REQUIRED';
  error: string;
  categories: FileCommandCategory[];
  suggestedTools: string[];
  retryCount: number;
  halted: boolean;
}

export class WorkspaceToolPolicyError extends Error {
  readonly toolResult: WorkspaceToolPolicyErrorResult;
  readonly haltAgentTurn: boolean;

  constructor(result: WorkspaceToolPolicyErrorResult) {
    super(result.halted
      ? 'AI repeatedly attempted to bypass the authorized Workspace file tools; this turn was stopped.'
      : 'This filesystem operation must use an authorized Workspace tool.');
    this.name = 'WorkspaceToolPolicyError';
    this.toolResult = result;
    this.haltAgentTurn = result.halted;
  }
}

interface LexedCommand {
  segments: string[][];
  hasRedirection: boolean;
}

interface RecognizedCommand {
  category: FileCommandCategory;
  name: string;
  args: string[];
  nonEquivalent: boolean;
}

const POWERSHELL_COMMANDS = new Map<string, FileCommandCategory>([
  ['get-content', 'read'], ['gc', 'read'], ['cat', 'read'], ['type', 'read'],
  ['select-string', 'search'], ['sls', 'search'],
  ['get-childitem', 'list'], ['gci', 'list'], ['dir', 'list'], ['ls', 'list'],
  ['get-item', 'stat'], ['test-path', 'stat'],
]);

const CMD_COMMANDS = new Map<string, FileCommandCategory>([
  ['type', 'read'], ['more', 'read'],
  ['find', 'search'], ['findstr', 'search'],
  ['dir', 'list'],
  ['if', 'stat'],
]);

const POSIX_COMMANDS = new Map<string, FileCommandCategory>([
  ['cat', 'read'], ['head', 'read'], ['tail', 'read'], ['more', 'read'], ['less', 'read'],
  ['grep', 'search'], ['egrep', 'search'], ['fgrep', 'search'], ['rg', 'search'],
  ['ls', 'list'], ['find', 'list'],
  ['stat', 'stat'], ['test', 'stat'], ['[', 'stat'],
]);

const SUGGESTED_TOOLS: Record<FileCommandCategory, readonly string[]> = {
  read: ['workspace_read_file'],
  search: ['workspace_search'],
  list: ['workspace_list', 'workspace_glob'],
  stat: ['workspace_stat'],
};

function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/**
 * Small command-position lexer, deliberately not a shell parser. It only
 * recognizes literal command words and one wrapper layer; dynamic/obfuscated
 * commands remain under the existing terminal approval boundary.
 */
function lexCommand(command: string, shellKind: ShellProfile['kind']): LexedCommand {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  let hasRedirection = false;

  const pushToken = (): void => {
    if (token) tokens.push(token);
    token = '';
  };
  const pushSegment = (): void => {
    pushToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote) {
      token += char;
      if (shellKind === 'powershell' && char === '`' && next) {
        token += next;
        index += 1;
      } else if (shellKind !== 'powershell' && char === '\\' && next) {
        token += next;
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      token += char;
      continue;
    }
    if (shellKind === 'powershell' && char === '`' && next) {
      token += char + next;
      index += 1;
      continue;
    }
    if (shellKind !== 'powershell' && shellKind !== 'cmd' && char === '\\' && next) {
      token += char + next;
      index += 1;
      continue;
    }
    if (char === '#'
      && shellKind !== 'cmd'
      && (token.length === 0)
      && (tokens.length === 0 || /\s/u.test(command[index - 1] ?? ' '))) {
      pushSegment();
      while (index + 1 < command.length && command[index + 1] !== '\n') index += 1;
      continue;
    }
    if (/\s/u.test(char)) {
      if (char === '\n' || char === '\r') pushSegment();
      else pushToken();
      continue;
    }
    if (char === ';' || char === '|'
      || (char === '&' && next === '&')) {
      pushSegment();
      if (next === char) index += 1;
      continue;
    }
    if (char === '<' || char === '>') {
      hasRedirection = true;
      pushToken();
      if (next === char) index += 1;
      continue;
    }
    token += char;
  }
  pushSegment();
  return { segments, hasRedirection };
}

function commandMap(shellKind: ShellProfile['kind']): Map<string, FileCommandCategory> {
  if (shellKind === 'powershell') return POWERSHELL_COMMANDS;
  if (shellKind === 'cmd') return CMD_COMMANDS;
  return POSIX_COMMANDS;
}

function wrapperPayload(
  tokens: readonly string[],
  shellKind: ShellProfile['kind'],
): { shellKind: ShellProfile['kind']; command: string } | undefined {
  const executable = path.win32.basename(unquote(tokens[0] ?? '')).toLocaleLowerCase('en-US');
  const powershell = ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(executable);
  const cmd = executable === 'cmd' || executable === 'cmd.exe';
  const posix = ['sh', 'bash', 'zsh', 'dash', 'fish'].includes(executable);
  let marker = -1;
  if (powershell) {
    marker = tokens.findIndex((value, index) => index > 0
      && ['-command', '-c'].includes(unquote(value).toLocaleLowerCase('en-US')));
  } else if (cmd) {
    marker = tokens.findIndex((value, index) => index > 0
      && unquote(value).toLocaleLowerCase('en-US') === '/c');
  } else if (posix) {
    marker = tokens.findIndex((value, index) => index > 0 && unquote(value) === '-c');
  }
  if (marker < 0 || marker + 1 >= tokens.length) return undefined;
  return {
    shellKind: powershell ? 'powershell' : cmd ? 'cmd' : 'posix',
    command: tokens.slice(marker + 1).map(unquote).join(' '),
  };
}

function normalizeCommandName(value: string): string {
  return path.win32.basename(unquote(value)).toLocaleLowerCase('en-US');
}

function recognizeSegments(
  lexed: LexedCommand,
  shellKind: ShellProfile['kind'],
  depth: number,
): { recognized: RecognizedCommand[]; unknownSegments: number; hasRedirection: boolean } {
  const recognized: RecognizedCommand[] = [];
  let unknownSegments = 0;
  let hasRedirection = lexed.hasRedirection;
  const map = commandMap(shellKind);

  for (const original of lexed.segments) {
    const tokens = [...original];
    if (shellKind === 'powershell' && tokens[0] === '&') tokens.shift();
    if (!tokens.length) continue;
    if (shellKind === 'cmd') {
      const first = normalizeCommandName(tokens[0]!);
      if (first === 'rem' || first === '::') continue;
    }
    if (depth === 0) {
      const wrapped = wrapperPayload(tokens, shellKind);
      if (wrapped) {
        const nested = recognizeSegments(lexCommand(wrapped.command, wrapped.shellKind), wrapped.shellKind, 1);
        recognized.push(...nested.recognized);
        unknownSegments += nested.unknownSegments;
        hasRedirection ||= nested.hasRedirection;
        continue;
      }
    }
    const name = normalizeCommandName(tokens[0]!);
    const category = map.get(name);
    if (!category) {
      unknownSegments += 1;
      continue;
    }
    const args = tokens.slice(1).map(unquote);
    const loweredArgs = args.map((value) => value.toLocaleLowerCase('en-US'));
    const nonEquivalent = (
      shellKind === 'powershell'
        && category === 'read'
        && loweredArgs.some((value) => value === '-wait' || value.startsWith('-tail'))
    ) || (
      shellKind !== 'powershell'
        && name === 'tail'
        && loweredArgs.some((value) => value === '-f' || value === '--follow'
          || value.startsWith('--follow='))
    ) || (
      shellKind === 'cmd' && name === 'if'
      && loweredArgs[0] !== 'exist' && loweredArgs[0] !== 'not'
    );
    recognized.push({ category, name, args, nonEquivalent });
  }
  return { recognized, unknownSegments, hasRedirection };
}

function likelyAbsolutePaths(
  commands: readonly RecognizedCommand[],
  shellKind: ShellProfile['kind'],
): string[] {
  const candidates: string[] = [];
  for (const command of commands) {
    for (const value of command.args) {
      if (!value || value.startsWith('-') || (shellKind === 'cmd' && value.startsWith('/'))) continue;
      if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) candidates.push(value);
    }
  }
  return candidates;
}

function pathInside(candidate: string, root: string, shellKind: ShellProfile['kind']): boolean {
  const api = shellKind === 'powershell' || shellKind === 'cmd' ? path.win32 : path.posix;
  const relative = api.relative(api.resolve(root), api.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative));
}

export function classifyAiFileCommand(input: FileCommandPolicyInput): FileCommandPolicyResult {
  const analysis = recognizeSegments(lexCommand(input.command, input.shellKind), input.shellKind, 0);
  if (!analysis.recognized.length) {
    return { disposition: 'allow', categories: [], commandNames: [], suggestedTools: [] };
  }
  const categories = [...new Set(analysis.recognized.map((command) => command.category))];
  const commandNames = [...new Set(analysis.recognized.map((command) => command.name))];
  const suggestedTools = [...new Set(categories.flatMap((category) => SUGGESTED_TOOLS[category]))];
  if (
    analysis.hasRedirection
    || analysis.unknownSegments > 0
    || analysis.recognized.some((command) => command.nonEquivalent)
  ) {
    return {
      disposition: 'exception-approval',
      categories,
      commandNames,
      suggestedTools,
      reasonCode: 'NON_EQUIVALENT_TERMINAL_SEMANTICS',
    };
  }
  if (!input.workspace.enabled || !input.workspace.read) {
    return {
      disposition: 'exception-approval',
      categories,
      commandNames,
      suggestedTools,
      reasonCode: 'WORKSPACE_TOOLS_UNAVAILABLE',
    };
  }
  const absolutePaths = likelyAbsolutePaths(analysis.recognized, input.shellKind);
  if (
    !input.workspace.fullAccess
    && absolutePaths.some((candidate) => !input.workspace.readablePaths.some((root) => (
      pathInside(candidate, root, input.shellKind)
    )))
  ) {
    return {
      disposition: 'exception-approval',
      categories,
      commandNames,
      suggestedTools,
      reasonCode: 'WORKSPACE_SCOPE_INSUFFICIENT',
    };
  }
  return {
    disposition: 'workspace-tool-required',
    categories,
    commandNames,
    suggestedTools,
    reasonCode: 'WORKSPACE_TOOL_EQUIVALENT',
  };
}

export function fileCommandHash(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}
