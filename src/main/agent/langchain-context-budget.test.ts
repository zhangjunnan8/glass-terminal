// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatOpenAICompletions } from '@langchain/openai';
import type { AgentBackendEvent } from './agent-backend';
import type { TerminalTool, ToolGateway, WorkspaceTool } from '../../shared/tools';
import { LangChainBackend } from './langchain-backend';
import { WorkspaceToolPolicyError } from './ai-file-command-policy';

interface ProviderRequest {
  messages?: Array<{ role?: string; content?: string }>;
}

interface ToolResponse {
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

const servers: Server[] = [];

async function providerServer(
  responseFor: (index: number, request: ProviderRequest) => ToolResponse | { content: string },
): Promise<{ baseUrl: string; requests: ProviderRequest[] }> {
  const requests: ProviderRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body) as ProviderRequest;
      const spec = responseFor(requests.length, parsed);
      requests.push(parsed);
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      if ('toolCalls' in spec) {
        response.write(`data: ${JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: spec.toolCalls.map((call, index) => ({
                index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            },
            finish_reason: null,
          }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: spec.content }, finish_reason: null }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

function terminal(): TerminalTool {
  return {
    execute: vi.fn(async (command: string) => ({
      commandId: 'command',
      command,
      status: 'completed' as const,
      exitCode: 0,
      output: '',
      startedAt: 0,
    })),
    sendInput: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    readVisible: vi.fn(async () => ''),
    readHistory: vi.fn(async () => ''),
    readVisiblePage: vi.fn(async () => ({ output: '', truncated: false })),
    getState: vi.fn(async () => ({
      terminalId: 'terminal',
      sessionId: 'session',
      transport: 'local' as const,
      shellKind: 'powershell',
      status: 'connected' as const,
      terminalInputMode: 'human' as const,
    })),
  };
}

function workspace(overrides: Partial<WorkspaceTool> = {}): WorkspaceTool {
  return {
    listDirectory: vi.fn(async () => ({ path: '/work', entries: [], truncated: false })),
    readFile: vi.fn(async (path: string) => ({
      path: `/work/${path}`,
      content: '',
      bytes: 0,
      sha256: 'a'.repeat(64),
    })),
    writeFile: vi.fn(async (path: string, content: string) => ({
      path,
      bytes: Buffer.byteLength(content),
      sha256: 'b'.repeat(64),
      created: true,
    })),
    applyPatch: vi.fn(async () => ({
      path: '/work/a.txt', bytes: 1, sha256: 'c'.repeat(64), created: false,
    })),
    search: vi.fn(async (query: string) => ({
      query, matches: [], filesScanned: 0, truncated: false,
    })),
    glob: vi.fn(async (pattern: string) => ({ pattern, paths: [], truncated: false })),
    stat: vi.fn(async (path: string) => ({ path, type: 'file' as const, size: 0 })),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ...overrides,
  };
}

function gateway(mode: 'off' | 'read-only' | 'read-write', files?: WorkspaceTool): ToolGateway {
  const enabled = mode !== 'off';
  const writable = mode === 'read-write';
  return {
    context: {
      sessionId: 'session',
      terminal: { type: 'local', terminalId: 'terminal', shellKind: 'posix' },
      ...(enabled ? { workspace: { backend: 'local', root: '/work' } } : {}),
      permissions: {
        terminal: { read: true, execute: true, sendInput: false, interrupt: true },
        workspace: {
          enabled,
          mode,
          read: enabled,
          write: writable,
          create: writable,
          delete: writable,
          readablePaths: enabled ? ['/work'] : [],
          writablePaths: writable ? ['/work'] : [],
          fullAccess: false,
        },
      },
    },
    terminal: terminal(),
    ...(enabled ? { workspace: files ?? workspace() } : {}),
  };
}

function backend(baseUrl: string): LangChainBackend {
  const model = new ChatOpenAICompletions({
    model: 'budget-test',
    apiKey: 'fake',
    temperature: 0,
    maxRetries: 0,
    configuration: { baseURL: baseUrl },
  });
  return new LangChainBackend({
    modelFactory: () => Promise.resolve(model),
    contextWindowTokens: 8_192,
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => (
    new Promise<void>((resolve) => server.close(() => resolve()))
  )));
});

describe('LangChain dynamic context budget', () => {
  it('rejects an incompressible Chinese prompt before resolving or calling a Provider', async () => {
    const modelFactory = vi.fn(async (): Promise<never> => {
      throw new Error('model factory must not run');
    });
    const harness = new LangChainBackend({
      modelFactory,
      contextWindowTokens: 8_192,
    });
    const thread = await harness.createThread({ id: 'too-long-prompt' });

    await expect(harness.sendMessage({
      thread,
      prompt: '超'.repeat(8_000),
      systemPrompt: 'system',
      terminalContext: '',
      fileAccessMode: 'off',
      gateway: gateway('off'),
      signal: new AbortController().signal,
    })).rejects.toThrow(/保守估算.*安全输入上限.*未向 Provider/u);
    expect(modelFactory).not.toHaveBeenCalled();
  });

  it('pages a large CJK file result to the live remaining budget and preserves a cursor', async () => {
    const provider = await providerServer((index) => index === 0
      ? { toolCalls: [{ id: 'read-big', name: 'workspace_read_file', args: { path: 'big.txt' } }] }
      : { content: 'page consumed' });
    const content = '上下文'.repeat(4_000);
    const files = workspace({
      readFile: vi.fn(async () => ({
        path: '/work/big.txt',
        content,
        bytes: Buffer.byteLength(content),
        sha256: 'd'.repeat(64),
      })),
    });
    const harness = backend(provider.baseUrl);
    const thread = await harness.createThread({ id: 'large-read-page' });
    const result = await harness.sendMessage({
      thread,
      prompt: 'read a bounded page',
      systemPrompt: 'system',
      terminalContext: '',
      fileAccessMode: 'read-only',
      gateway: gateway('read-only', files),
      signal: new AbortController().signal,
    });

    expect(result.haltedError).toBeUndefined();
    expect(provider.requests).toHaveLength(2);
    const toolMessage = provider.requests[1]!.messages!.find((message) => message.role === 'tool');
    const page = JSON.parse(toolMessage!.content!) as Record<string, unknown>;
    expect(page).toMatchObject({ ok: true, truncated: true, path: '/work/big.txt' });
    expect(typeof page.nextCursor).toBe('string');
    expect(String(page.content).length).toBeGreaterThan(0);
    expect(String(page.content).length).toBeLessThan(content.length);
  });

  it('reserves complete tool-result slots across a multi-tool assistant group', async () => {
    const provider = await providerServer((index) => index === 0
      ? {
        toolCalls: [
          { id: 'read-one', name: 'workspace_read_file', args: { path: 'a.txt' } },
          { id: 'stat-one', name: 'workspace_stat', args: { path: 'a.txt' } },
        ],
      }
      : { content: 'both consumed' });
    const files = workspace({
      readFile: vi.fn(async () => ({
        path: '/work/a.txt', content: '内容'.repeat(1_000), bytes: 6_000, sha256: 'e'.repeat(64),
      })),
    });
    const harness = backend(provider.baseUrl);
    const thread = await harness.createThread({ id: 'multi-tool-budget' });
    const events: AgentBackendEvent[] = [];
    const result = await harness.sendMessage({
      thread,
      prompt: 'read and stat',
      systemPrompt: 'system',
      terminalContext: '',
      fileAccessMode: 'read-only',
      gateway: gateway('read-only', files),
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    expect(result.haltedError).toBeUndefined();
    const toolMessages = provider.requests[1]!.messages!.filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(events.filter((event) => event.type === 'tool_completed')).toHaveLength(2);
  });

  it('never trims or executes an oversized write call and stops before another Provider request', async () => {
    const hugeContent = `WRITE-CANARY-${'改'.repeat(7_000)}`;
    const provider = await providerServer(() => ({
      toolCalls: [{
        id: 'write-huge',
        name: 'workspace_write_file',
        args: { path: 'large.txt', content: hugeContent, expectedSha256: null },
      }],
    }));
    const writeFile = vi.fn(async () => ({
      path: '/work/large.txt', bytes: 1, sha256: 'f'.repeat(64), created: true,
    }));
    const files = workspace({ writeFile });
    const summarize = vi.fn(async () => 'provider summary must not run after tool overflow');
    const model = new ChatOpenAICompletions({
      model: 'budget-test',
      apiKey: 'fake',
      temperature: 0,
      maxRetries: 0,
      configuration: { baseURL: provider.baseUrl },
    });
    const harness = new LangChainBackend({
      modelFactory: () => Promise.resolve(model),
      contextWindowTokens: 8_192,
      summarize,
    });
    const thread = await harness.resume({
      id: 'oversized-write',
      priorMessages: [
        { role: 'user', content: `older context ${'旧'.repeat(800)}` },
        { role: 'assistant', content: 'older answer' },
      ],
    });
    const events: AgentBackendEvent[] = [];
    const result = await harness.sendMessage({
      thread,
      prompt: 'write the supplied content',
      systemPrompt: 'system',
      terminalContext: '',
      fileAccessMode: 'read-write',
      gateway: gateway('read-write', files),
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    expect(writeFile).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(1);
    expect(result.haltedError).toMatch(/工具.*安全输入上限/u);
    const completed = events.find((event) => event.type === 'tool_completed');
    expect(completed?.result).toContain('CONTEXT_BUDGET_EXCEEDED');
    expect(JSON.stringify(result.contextPersistence?.messages)).toContain(hugeContent);
  });

  it('stops the turn after the bounded repeated Workspace-tool policy violation', async () => {
    const provider = await providerServer((index) => ({
      toolCalls: [{
        id: `file-policy-${index}`,
        name: 'terminal_execute',
        args: { command: 'cat README.md' },
      }],
    }));
    let retryCount = 0;
    const policyTerminal = terminal();
    policyTerminal.execute = vi.fn(async () => {
      retryCount += 1;
      const halted = retryCount >= 3;
      throw new WorkspaceToolPolicyError({
        ok: false,
        code: 'WORKSPACE_TOOL_REQUIRED',
        error: halted ? 'Repeated attempts stopped.' : 'Use workspace_read_file.',
        categories: ['read'],
        suggestedTools: ['workspace_read_file'],
        retryCount,
        halted,
      });
    });
    const policyGateway: ToolGateway = {
      ...gateway('read-only'),
      terminal: policyTerminal,
    };
    const harness = backend(provider.baseUrl);
    const thread = await harness.createThread({ id: 'repeated-file-policy' });
    const events: AgentBackendEvent[] = [];
    const result = await harness.sendMessage({
      thread,
      prompt: 'keep reading with the terminal',
      systemPrompt: 'system',
      terminalContext: '',
      fileAccessMode: 'read-only',
      gateway: policyGateway,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    expect(provider.requests).toHaveLength(3);
    expect(policyTerminal.execute).toHaveBeenCalledTimes(3);
    expect(result.haltedError).toMatch(/repeatedly attempted to bypass/i);
    const completed = events.filter((event) => event.type === 'tool_completed');
    expect(completed).toHaveLength(3);
    expect(completed.at(-1)?.result).toContain('"halted":true');
  });
});
