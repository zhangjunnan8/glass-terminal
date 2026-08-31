// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatOpenAICompletions } from '@langchain/openai';
import type {
  TerminalCommandResult,
  TerminalTool,
  ToolGateway,
  WorkspaceFileReadResult,
  WorkspaceTool,
} from '../../shared/tools';
import { LangChainBackend } from './langchain-backend';

/**
 * Gated real-model integration test. Runs only when
 * `AI_TERMINAL_DEEPSEEK_API_KEY` is provided, mirroring the SSH/SFTP gated
 * integration tests. Never reads or persists the key; it is supplied only via
 * the process environment.
 */
const API_KEY = process.env.AI_TERMINAL_DEEPSEEK_API_KEY;
const BASE_URL = process.env.AI_TERMINAL_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const MODEL = process.env.AI_TERMINAL_DEEPSEEK_MODEL ?? 'deepseek-chat';
const enabled = Boolean(API_KEY);

const TERMINAL_MARKER = 'REAL_DEEPSEEK_TERMINAL_OUTPUT';
const WORKSPACE_CONTENT = 'REAL_DEEPSEEK_WORKSPACE_CONTENT_42';

function recordingTerminal(executed: string[]): TerminalTool {
  return {
    execute: async (command) => {
      executed.push(command);
      return {
        commandId: 'real-deepseek-exec',
        command,
        status: 'completed',
        exitCode: 0,
        output: TERMINAL_MARKER,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        durationMs: 1,
      } satisfies TerminalCommandResult;
    },
    sendInput: async () => { throw new Error('terminal.sendInput is disabled.'); },
    interrupt: async () => { throw new Error('terminal.interrupt is disabled.'); },
    readVisible: async () => '',
    readHistory: async () => '',
    getState: async () => ({
      terminalId: 't1',
      sessionId: 's1',
      transport: 'local',
      shellKind: 'posix',
      status: 'connected',
      terminalInputMode: 'human',
    }),
  };
}

function minimalWorkspace(root: string, readPaths: string[]): WorkspaceTool {
  const resolve = (path: string): string => {
    const absolute = join(root, path);
    if (absolute !== root && !absolute.startsWith(`${root}/`) && !absolute.startsWith(`${root}\\`)) {
      throw new Error('workspace path escapes the root.');
    }
    return absolute;
  };
  const notImplemented = async (): Promise<never> => {
    throw new Error('not implemented for the DeepSeek real-model spike.');
  };
  return {
    listDirectory: async () => ({ path: '.', entries: [], truncated: false }),
    readFile: async (path) => {
      readPaths.push(path);
      const content = readFileSync(resolve(path), 'utf8');
      return {
        path,
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        sha256: createHash('sha256').update(content).digest('hex'),
      } satisfies WorkspaceFileReadResult;
    },
    writeFile: notImplemented,
    applyPatch: notImplemented,
    search: async () => ({ query: '', matches: [], filesScanned: 0, truncated: false }),
    glob: async () => ({ pattern: '', paths: [], truncated: false }),
    stat: async (path) => ({ path, type: 'file' as const, size: 0 }),
    mkdir: notImplemented,
    rename: notImplemented,
    delete: notImplemented,
  };
}

function buildGateway(terminal: TerminalTool, workspace?: WorkspaceTool): ToolGateway {
  const workspaceEnabled = Boolean(workspace);
  return {
    context: {
      sessionId: 's1',
      terminal: { type: 'local', terminalId: 't1', shellKind: 'posix' },
      ...(workspaceEnabled ? { workspace: { backend: 'local' as const, root: '/' } } : {}),
      permissions: {
        terminal: { read: true, execute: true, sendInput: false, interrupt: true },
        workspace: {
          enabled: workspaceEnabled,
          mode: workspaceEnabled ? ('read-only' as const) : ('off' as const),
          read: workspaceEnabled,
          write: false,
          create: false,
          delete: false,
          readablePaths: workspaceEnabled ? ['/'] : [],
          writablePaths: [],
          fullAccess: false,
        },
      },
    },
    terminal,
    workspace,
  };
}

describe.runIf(enabled)('real DeepSeek via LangChain harness', () => {
  it('routes a terminal command through the shared terminal tool', async () => {
    const executed: string[] = [];
    const gateway = buildGateway(recordingTerminal(executed));
    const model = new ChatOpenAICompletions({
      model: MODEL,
      apiKey: API_KEY,
      temperature: 0,
      maxRetries: 1,
      timeout: 90_000,
      configuration: { baseURL: BASE_URL },
    });
    const backend = new LangChainBackend({ modelFactory: () => Promise.resolve(model) });
    const thread = await backend.createThread({ id: 'deepseek-real-terminal' });

    const result = await backend.sendMessage({
      thread,
      prompt: 'Run the exact shell command `echo REAL_DEEPSEEK_TERMINAL_OUTPUT` with the terminal_execute tool, then tell me what it printed.',
      systemPrompt: 'You are a terminal assistant. Use the provided tools and run the command exactly as instructed.',
      terminalContext: '',
      fileAccessMode: 'off',
      gateway,
      signal: new AbortController().signal,
    });

    expect(executed).toContain('echo REAL_DEEPSEEK_TERMINAL_OUTPUT');
    expect(result.finalText.length).toBeGreaterThan(0);
    expect(result.rounds).toBeGreaterThan(0);
  }, 120_000);

  it('reads a workspace file through the workspace tool (never cat)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-deepseek-real-'));
    const readPaths: string[] = [];
    try {
      writeFileSync(join(root, 'hello.txt'), `${WORKSPACE_CONTENT}\n`);
      const executed: string[] = [];
      const gateway = buildGateway(
        recordingTerminal(executed),
        minimalWorkspace(root, readPaths),
      );
      const model = new ChatOpenAICompletions({
        model: MODEL,
        apiKey: API_KEY,
        temperature: 0,
        maxRetries: 1,
        timeout: 90_000,
        configuration: { baseURL: BASE_URL },
      });
      const backend = new LangChainBackend({ modelFactory: () => Promise.resolve(model) });
      const thread = await backend.createThread({ id: 'deepseek-real-workspace' });

      const result = await backend.sendMessage({
        thread,
        prompt: 'Read the file `hello.txt` using the file_read tool, then tell me its exact contents.',
        systemPrompt: 'You are a coding assistant. Read files with the file_read tool; never use cat.',
        terminalContext: '',
        fileAccessMode: 'read-only',
        gateway,
        signal: new AbortController().signal,
      });

      expect(readPaths).toContain('hello.txt');
      expect(executed).toHaveLength(0);
      expect(result.finalText).toContain(WORKSPACE_CONTENT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
