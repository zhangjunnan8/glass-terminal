import { describe, expect, it, vi } from 'vitest';
import type { ProviderProfile } from '../../shared/provider';
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
    const loop = new AgentLoop(provider, {
      readTerminal: async () => '',
      getTerminalState: async () => ({}),
      executeCommand: async () => ({
        executionId: 'unused',
        command: 'unused',
        status: 'completed',
        output: '',
      }),
    }, (event) => events.push(event));

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
      executionId: 'execution-1',
      command: 'pwd',
      status: 'completed',
      exitCode: 0,
      output: '/home/tester\n',
      durationMs: 12,
    });
    const loop = new AgentLoop(provider, {
      readTerminal: async () => 'visible terminal',
      getTerminalState: async () => ({ transport: 'ssh' }),
      executeCommand,
    });

    const result = await loop.run({
      systemPrompt: 'Use terminal tools.',
      userPrompt: 'Where am I?',
      terminalContext: '$ ',
      signal: new AbortController().signal,
    });

    expect(result.rounds).toBe(3);
    expect(result.finalText).toBe('The command completed successfully.');
    expect(executeCommand).toHaveBeenCalledWith({ command: 'pwd', reason: 'inspect cwd' });
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
    const loop = new AgentLoop(provider, {
      readTerminal: async () => '',
      getTerminalState: async () => ({}),
      executeCommand,
    });

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
    const chunk = new Uint8Array(1024 * 1024);
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
    })).rejects.toThrow('Provider response is too large.');
    expect(pulls).toBeLessThan(8);
    expect(cancelled).toBe(true);
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
