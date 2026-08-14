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
