import { describe, expect, it, vi } from 'vitest';
import type { ProviderProfile } from '../../shared/provider';
import type { ToolGateway, WorkspaceTool } from '../../shared/tools';
import type { ProviderStore } from '../providers/provider-store';
import {
  AgentLoop,
} from './agent-loop';
import type {
  AgentCompletion,
  AgentCompletionRequest,
  AgentProviderRuntime,
} from './agent-loop';
import { GenericOpenAiProvider } from './generic-provider';

class SequencedProvider implements AgentProviderRuntime {
  readonly requests: AgentCompletionRequest[] = [];

  constructor(private readonly completions: AgentCompletion[]) {}

  async complete(request: AgentCompletionRequest): Promise<AgentCompletion> {
    this.requests.push(request);
    const completion = this.completions.shift();
    if (!completion) throw new Error('No fake completion remains.');
    return completion;
  }
}

function fakeToolGateway(overrides: {
  terminal?: Partial<ToolGateway['terminal']>;
  workspace?: Partial<WorkspaceTool> | null;
} = {}): ToolGateway {
  const terminal: ToolGateway['terminal'] = {
    execute: async (command) => ({
      commandId: 'unused',
      command,
      status: 'completed',
      exitCode: null,
      output: '',
      startedAt: 0,
    }),
    sendInput: async () => undefined,
    interrupt: async () => undefined,
    readVisible: async () => '',
    readHistory: async () => '',
    getState: async () => ({
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      transport: 'local',
      shellKind: 'powershell',
      status: 'connected',
      terminalInputMode: 'human',
    }),
    ...overrides.terminal,
  };
  const workspace: WorkspaceTool = {
    listDirectory: async (path = '.') => ({ path, entries: [], truncated: false }),
    readFile: async (path) => ({ path, content: '', bytes: 0, sha256: 'a'.repeat(64) }),
    writeFile: async (path, content, expectedSha256) => ({
      path,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: expectedSha256 ?? 'a'.repeat(64),
      created: expectedSha256 === null,
    }),
    applyPatch: async (path, expectedSha256) => ({
      path,
      bytes: 0,
      sha256: expectedSha256,
      created: false,
    }),
    search: async (query) => ({ query, matches: [], filesScanned: 0, truncated: false }),
    glob: async (pattern) => ({ pattern, paths: [], truncated: false }),
    stat: async (path) => ({ path, type: 'file', size: 0 }),
    mkdir: async () => undefined,
    rename: async () => undefined,
    delete: async () => undefined,
    ...(overrides.workspace ?? {}),
  };
  const context: ToolGateway['context'] = {
    sessionId: 'session-1',
    terminal: { type: 'local', terminalId: 'terminal-1' },
    ...(overrides.workspace === null ? {} : {
      workspace: { backend: 'local' as const, root: '/work' },
    }),
    permissions: {
      terminal: { read: true, execute: true, sendInput: true, interrupt: true },
      workspace: {
        enabled: overrides.workspace !== null,
        mode: 'read-write',
        read: true,
        write: true,
        create: true,
        delete: true,
        readablePaths: ['/work'],
        writablePaths: ['/work'],
        fullAccess: false,
      },
    },
  };
  return {
    context,
    terminal,
    ...(overrides.workspace === null ? {} : { workspace }),
  };
}

describe('AgentLoop', () => {
  it('forwards provider text deltas before publishing the completed assistant message', async () => {
    const events: Array<{ type: string; text?: string }> = [];
    const provider: AgentProviderRuntime = {
      async complete(request) {
        request.onTextDelta?.('正在');
        await Promise.resolve();
        request.onTextDelta?.('生成');
        return { message: { role: 'assistant', content: '正在生成' } };
      },
    };
    const loop = new AgentLoop(provider, fakeToolGateway(), (event) => events.push(event));

    await loop.run({
      systemPrompt: 'Use terminal tools.',
      userPrompt: 'Stream a response.',
      terminalContext: '',
      signal: new AbortController().signal,
    });

    expect(events).toEqual([
      { type: 'assistant_delta', text: '正在' },
      { type: 'assistant_delta', text: '生成' },
      { type: 'assistant_text', text: '正在生成' },
    ]);
  });

  it('iterates read → approved execution → result → final answer', async () => {
    const provider = new SequencedProvider([
      {
        message: {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'read-1', name: 'terminal_read', arguments: '{"maxChars":500}' }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: 'I will inspect the working directory.',
          toolCalls: [{
            id: 'exec-1',
            name: 'terminal_execute',
            arguments: '{"command":"pwd","reason":"inspect cwd"}',
          }],
        },
      },
      { message: { role: 'assistant', content: 'The command completed successfully.' } },
    ]);
    const executeCommand = vi.fn().mockResolvedValue({
      commandId: 'execution-1',
      command: 'pwd',
      status: 'completed',
      exitCode: 0,
      output: '/home/tester\n',
      startedAt: 0,
      durationMs: 12,
    });
    const loop = new AgentLoop(provider, fakeToolGateway({ terminal: {
      readVisible: async () => 'visible terminal',
      getState: async () => ({
        terminalId: 'terminal-1',
        sessionId: 'session-1',
        transport: 'ssh',
        shellKind: 'bash',
        status: 'connected',
        terminalInputMode: 'human',
      }),
      execute: executeCommand,
    } }));

    const result = await loop.run({
      systemPrompt: 'Use terminal tools.',
      userPrompt: 'Where am I?',
      terminalContext: '$ ',
      signal: new AbortController().signal,
    });

    expect(result.rounds).toBe(3);
    expect(result.finalText).toBe('The command completed successfully.');
    expect(executeCommand).toHaveBeenCalledWith('pwd', 'inspect cwd');
    expect(provider.requests[2].messages).toContainEqual(expect.objectContaining({
      role: 'tool',
      toolCallId: 'exec-1',
    }));
  });

  it('returns unsupported tool errors to the Provider instead of executing them', async () => {
    const provider = new SequencedProvider([
      {
        message: {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'bad-1', name: 'hidden_shell', arguments: '{}' }],
        },
      },
      { message: { role: 'assistant', content: 'I cannot use that tool.' } },
    ]);
    const executeCommand = vi.fn();
    const loop = new AgentLoop(provider, fakeToolGateway({ terminal: {
      execute: executeCommand,
    } }));

    await loop.run({
      systemPrompt: 'Use terminal tools.',
      userPrompt: 'Run something.',
      terminalContext: '',
      signal: new AbortController().signal,
    });

    expect(executeCommand).not.toHaveBeenCalled();
    const toolMessage = provider.requests[1].messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('Unsupported terminal tool');
  });

  it('exposes file tools only at the explicit access level and denies an unadvertised write', async () => {
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: null, toolCalls: [{
        id: 'write-1', name: 'file_write',
        arguments: '{"path":"a.ts","content":"x","expectedSha256":null}',
      }] } },
      { message: { role: 'assistant', content: 'Write was denied.' } },
    ]);
    const writeFile = vi.fn();
    const loop = new AgentLoop(provider, fakeToolGateway({ workspace: { writeFile } }));

    await loop.run({
      systemPrompt: 'test', userPrompt: 'test', terminalContext: '',
      fileAccessMode: 'read-only', signal: new AbortController().signal,
    });

    expect(provider.requests[0].tools.map((tool) => tool.name)).toContain('file_read');
    expect(provider.requests[0].tools.map((tool) => tool.name)).not.toContain('file_write');
    expect(writeFile).not.toHaveBeenCalled();
    expect(provider.requests[1].messages).toContainEqual(expect.objectContaining({
      role: 'tool', content: expect.stringContaining('requires read-write access'),
    }));
  });

  it('keeps a file read for one reasoning step then compacts file contents and write arguments', async () => {
    let requestIndex = 0;
    const provider: AgentProviderRuntime = {
      async complete(request) {
        requestIndex += 1;
        if (requestIndex === 1) return { message: { role: 'assistant', content: null, toolCalls: [{
          id: 'read-1', name: 'file_read', arguments: '{"path":"a.ts"}',
        }] } };
        if (requestIndex === 2) {
          expect(request.messages).toContainEqual(expect.objectContaining({
            role: 'tool', toolCallId: 'read-1', content: expect.stringContaining('const value = 1'),
          }));
          return { message: { role: 'assistant', content: null, toolCalls: [{
            id: 'patch-1', name: 'file_patch', arguments: JSON.stringify({
              path: 'a.ts', expectedSha256: 'a'.repeat(64),
              patches: [{ search: '1', replace: '2' }],
            }),
          }] } };
        }
        return { message: { role: 'assistant', content: 'done' } };
      },
    };
    const loop = new AgentLoop(provider, fakeToolGateway({ workspace: {
      readFile: async () => ({
        path: '/work/a.ts', content: 'const value = 1;', bytes: 16, sha256: 'a'.repeat(64),
      }),
      applyPatch: async () => ({
        path: '/work/a.ts', bytes: 16, sha256: 'b'.repeat(64), created: false,
      }),
    } }));

    const result = await loop.run({
      systemPrompt: 'test', userPrompt: 'test', terminalContext: '',
      fileAccessMode: 'read-write', signal: new AbortController().signal,
    });
    expect(JSON.stringify(result.messages)).not.toContain('const value = 1');
    expect(JSON.stringify(result.messages)).not.toContain('"search":"1"');
    expect(JSON.stringify(result.messages)).toContain('historyCompacted');
  });

  it('caps aggregate file read and directory-list results for one turn', async () => {
    const completedResults: string[] = [];
    const calls = Array.from({ length: 64 }, (_, index) => ({
      id: `list-${index}`, name: 'file_list', arguments: '{"path":"."}',
    }));
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: null, toolCalls: calls } },
      { message: { role: 'assistant', content: 'batched' } },
    ]);
    const loop = new AgentLoop(provider, fakeToolGateway({ workspace: {
      listDirectory: async () => ({
        path: '/work', truncated: false,
        entries: [{
          name: 'x'.repeat(40_000), path: '/work/x', type: 'file', size: 1,
        }],
      }),
    } }), (event) => {
      if (event.type === 'tool_completed' && event.result) completedResults.push(event.result);
    });

    await loop.run({
      systemPrompt: 'test', userPrompt: 'test', terminalContext: '',
      fileAccessMode: 'read-only', signal: new AbortController().signal,
    });
    expect(completedResults.some((result) => result.includes('读取/列表结果超过'))).toBe(true);
  });
});

describe('GenericOpenAiProvider', () => {
  it('parses split SSE deltas and reconstructs streamed tool calls', async () => {
    const profile: ProviderProfile = {
      id: 'provider-1',
      name: 'Mock Provider',
      kind: 'generic-openai-compatible',
      baseUrl: 'https://provider.example/v1',
      modelId: 'model-1',
      apiKeyConfigured: true,
      isDefault: true,
      status: 'ready',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const providerStore = {
      get: () => profile,
      apiKey: async () => 'request-only-secret',
    } as unknown as ProviderStore;
    const wire = [
      'data: {"choices":[{"delta":{"content":"正在"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"处理"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"terminal_","arguments":"{\\"command\\":\\"who"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"execute","arguments":"ami\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const bytes = new TextEncoder().encode(wire);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 19));
        controller.enqueue(bytes.slice(19, 73));
        controller.enqueue(bytes.slice(73));
        controller.close();
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));
    const onTextDelta = vi.fn();
    const runtime = new GenericOpenAiProvider(profile.id, providerStore, fetchMock);

    const completion = await runtime.complete({
      messages: [{ role: 'user', content: 'Who am I?' }],
      tools: [],
      signal: new AbortController().signal,
      onTextDelta,
    });

    expect(onTextDelta.mock.calls.flat()).toEqual(['正在', '处理']);
    expect(completion.message).toEqual({
      role: 'assistant',
      content: '正在处理',
      toolCalls: [{
        id: 'call-1',
        name: 'terminal_execute',
        arguments: '{"command":"whoami"}',
      }],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ stream: true });
  });

  it.each([
    {
      name: 'clean EOF without a completion marker',
      suffix: '',
      message: /completion marker/,
    },
    {
      name: 'an unsafe length finish even when DONE follows',
      suffix: 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
      message: /ended unsafely \(length\)/,
    },
    {
      name: 'a stop finish that contradicts the assembled tool call',
      suffix: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      message: /finish reason stop does not match tool_calls/,
    },
    {
      name: 'a missing-delta stop finish that contradicts the assembled tool call',
      suffix: 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      message: /finish reason stop does not match tool_calls/,
    },
    {
      name: 'tool data sent after a safe finish reason',
      suffix: 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" "}}]}}]}\n\ndata: [DONE]\n\n',
      message: /data after its completion reason/,
    },
  ])('rejects a streamed tool call after $name', async ({ suffix, message }) => {
    const profile: ProviderProfile = {
      id: 'provider-1',
      name: 'Mock Provider',
      kind: 'generic-openai-compatible',
      baseUrl: 'https://provider.example/v1',
      modelId: 'model-1',
      apiKeyConfigured: true,
      isDefault: true,
      status: 'ready',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const providerStore = {
      get: () => profile,
      apiKey: async () => 'request-only-secret',
    } as unknown as ProviderStore;
    const wire = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"terminal_execute","arguments":"{\\"command\\":\\"whoami\\"}"}}]}}]}\n\n' + suffix;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(wire, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const runtime = new GenericOpenAiProvider(profile.id, providerStore, fetchMock);

    await expect(runtime.complete({
      messages: [{ role: 'user', content: 'Who am I?' }],
      tools: [],
      signal: new AbortController().signal,
    })).rejects.toThrow(message);
  });

  it('stops reading an oversized non-SSE response before buffering it all', async () => {
    const profile: ProviderProfile = {
      id: 'provider-1', name: 'Mock Provider', kind: 'generic-openai-compatible',
      baseUrl: 'https://provider.example/v1', modelId: 'model-1', apiKeyConfigured: true,
      isDefault: true, status: 'ready', createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const providerStore = {
      get: () => profile,
      apiKey: async () => 'request-only-secret',
    } as unknown as ProviderStore;
    const chunk = new Uint8Array(2 * 1024 * 1024);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls >= 8) controller.close();
      },
      cancel() { cancelled = true; },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const runtime = new GenericOpenAiProvider(profile.id, providerStore, fetchMock);

    await expect(runtime.complete({
      messages: [{ role: 'user', content: 'test' }],
      tools: [],
      signal: new AbortController().signal,
    })).rejects.toThrow(
      /Provider JSON 响应已接收 \d+ 字节，超过安全上限 8388608 字节（8 MiB）/,
    );
    expect(pulls).toBeLessThan(8);
    expect(cancelled).toBe(true);
  });

  it('rejects an oversized streamed tool call instead of returning truncated arguments', async () => {
    const profile: ProviderProfile = {
      id: 'provider-1', name: 'Mock Provider', kind: 'generic-openai-compatible',
      baseUrl: 'https://provider.example/v1', modelId: 'model-1', apiKeyConfigured: true,
      isDefault: true, status: 'ready', createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const providerStore = {
      get: () => profile,
      apiKey: async () => 'request-only-secret',
    } as unknown as ProviderStore;
    const argumentsFragment = 'x'.repeat(1024 * 1024 + 1);
    const wire = `data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call-too-large',
            type: 'function',
            function: { name: 'terminal_execute', arguments: argumentsFragment },
          }],
        },
      }],
    })}\n\n`;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(wire, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const runtime = new GenericOpenAiProvider(profile.id, providerStore, fetchMock);

    await expect(runtime.complete({
      messages: [{ role: 'user', content: 'test' }],
      tools: [],
      signal: new AbortController().signal,
    })).rejects.toThrow(
      /参数长度 1048577 超过安全上限 1048576 字符；未完整的工具调用不会执行/,
    );
  });

  it('allows normal SSE protocol overhead beyond the old four MiB aggregate limit', async () => {
    const profile: ProviderProfile = {
      id: 'provider-1', name: 'Mock Provider', kind: 'generic-openai-compatible',
      baseUrl: 'https://provider.example/v1', modelId: 'model-1', apiKeyConfigured: true,
      isDefault: true, status: 'ready', createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const providerStore = {
      get: () => profile,
      apiKey: async () => 'request-only-secret',
    } as unknown as ProviderStore;
    const paddingLine = `: ${'x'.repeat(1022)}\n`;
    const wire = paddingLine.repeat(4_200)
      + 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n';
    expect(new TextEncoder().encode(wire).byteLength).toBeGreaterThan(4 * 1024 * 1024);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(wire, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const runtime = new GenericOpenAiProvider(profile.id, providerStore, fetchMock);

    await expect(runtime.complete({
      messages: [{ role: 'user', content: 'test' }],
      tools: [],
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ message: { content: 'ok' } });
  });

  it.each(['length', 'content_filter', undefined])(
    'rejects a JSON tool completion with unsafe finish reason %s',
    async (finishReason) => {
      const profile: ProviderProfile = {
        id: 'provider-1', name: 'Mock Provider', kind: 'generic-openai-compatible',
        baseUrl: 'https://provider.example/v1', modelId: 'model-1', apiKeyConfigured: true,
        isDefault: true, status: 'ready', createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      const providerStore = {
        get: () => profile,
        apiKey: async () => 'request-only-secret',
      } as unknown as ProviderStore;
      const payload = {
        choices: [{
          ...(finishReason ? { finish_reason: finishReason } : {}),
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-unsafe', type: 'function',
              function: { name: 'terminal_execute', arguments: '{"command":"whoami"}' },
            }],
          },
        }],
      };
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      const runtime = new GenericOpenAiProvider(profile.id, providerStore, fetchMock);

      await expect(runtime.complete({
        messages: [{ role: 'user', content: 'Who am I?' }],
        tools: [],
        signal: new AbortController().signal,
      })).rejects.toThrow('JSON completion ended unsafely');
    },
  );

  it('maps the OpenAI-compatible tool-call protocol without exposing the key in messages', async () => {
    const profile: ProviderProfile = {
      id: 'provider-1',
      name: 'Mock Provider',
      kind: 'generic-openai-compatible',
      baseUrl: 'https://provider.example/v1',
      modelId: 'model-1',
      apiKeyConfigured: true,
      isDefault: true,
      status: 'ready',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const providerStore = {
      get: () => profile,
      apiKey: async () => 'request-only-secret',
    } as unknown as ProviderStore;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'terminal_execute', arguments: '{"command":"whoami"}' },
          }],
        },
      }],
    }), { status: 200 }));
    const runtime = new GenericOpenAiProvider(profile.id, providerStore, fetchMock);

    const completion = await runtime.complete({
      messages: [{ role: 'user', content: 'Who am I?' }],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(completion.message.toolCalls?.[0]).toMatchObject({
      name: 'terminal_execute',
      arguments: '{"command":"whoami"}',
    });
    const request = fetchMock.mock.calls[0][1]!;
    expect(request.headers).toMatchObject({ Authorization: 'Bearer request-only-secret' });
    expect(String(request.body)).not.toContain('request-only-secret');
  });
});
