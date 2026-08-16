import { describe, expect, it, vi } from 'vitest';
import type { ToolGateway } from '../../shared/tools';
import type {
  AgentCompletion,
  AgentCompletionRequest,
  AgentProviderRuntime,
} from './agent-loop';
import { GenericHarnessBackend } from './generic-harness-backend';

function fakeGateway(getState = vi.fn(async () => ({
  terminalId: 'terminal-1',
  sessionId: 'session-1',
  transport: 'local' as const,
  shellKind: 'powershell',
  status: 'connected' as const,
  terminalInputMode: 'human' as const,
}))): ToolGateway {
  return {
    context: {
      sessionId: 'session-1',
      terminal: { type: 'local', terminalId: 'terminal-1' },
      permissions: {
        terminal: { read: true, execute: true, sendInput: false, interrupt: true },
        workspace: {
          enabled: false,
          mode: 'off',
          read: false,
          write: false,
          create: false,
          delete: false,
          readablePaths: [],
          writablePaths: [],
          fullAccess: false,
        },
      },
    },
    terminal: {
      execute: vi.fn(),
      sendInput: vi.fn(),
      interrupt: vi.fn(),
      readVisible: vi.fn(async () => ''),
      readHistory: vi.fn(async () => ''),
      getState,
    },
  };
}

function sendInput(
  thread: Awaited<ReturnType<GenericHarnessBackend['createThread']>>,
  gateway: ToolGateway,
  prompt: string,
  signal = new AbortController().signal,
) {
  return {
    thread,
    prompt,
    systemPrompt: 'Use only injected tools.',
    terminalContext: '$ ',
    fileAccessMode: 'off' as const,
    gateway,
    signal,
  };
}

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

describe('GenericHarnessBackend', () => {
  it('creates a thread and uses only the ToolGateway explicitly injected for that turn', async () => {
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: null, toolCalls: [{
        id: 'state-1', name: 'terminal_state', arguments: '{}',
      }] } },
      { message: { role: 'assistant', content: 'done' } },
    ]);
    const backend = new GenericHarnessBackend(provider);
    const thread = await backend.createThread({ id: 'thread-1' });
    const getState = vi.fn(async () => ({
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      transport: 'local' as const,
      shellKind: 'powershell',
      status: 'connected' as const,
      terminalInputMode: 'human' as const,
    }));
    const gateway = fakeGateway(getState);

    const result = await backend.sendMessage(sendInput(thread, gateway, 'inspect'));

    expect(result.finalText).toBe('done');
    expect(getState).toHaveBeenCalledOnce();
    expect(provider.requests[0].messages).toContainEqual(expect.objectContaining({
      role: 'user',
      content: expect.stringContaining('inspect'),
    }));
  });

  it('resumes cloned prior history and advances it after a successful message', async () => {
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: 'continued' } },
      { message: { role: 'assistant', content: 'again' } },
    ]);
    const backend = new GenericHarnessBackend(provider);
    const priorMessages = [{ role: 'user' as const, content: 'earlier' }];
    const thread = await backend.resume({ id: 'thread-1', priorMessages });
    priorMessages[0]!.content = 'caller mutation';

    await backend.sendMessage(sendInput(thread, fakeGateway(), 'next'));
    await backend.sendMessage(sendInput(thread, fakeGateway(), 'last'));

    expect(provider.requests[0].messages).toContainEqual({ role: 'user', content: 'earlier' });
    expect(provider.requests[1].messages).toContainEqual({
      role: 'assistant',
      content: 'continued',
    });
  });

  it('fails closed when a runtime caller omits the per-turn ToolGateway', async () => {
    const backend = new GenericHarnessBackend(new SequencedProvider([]));
    const thread = await backend.createThread({ id: 'thread-1' });

    await expect(backend.sendMessage({
      ...sendInput(thread, fakeGateway(), 'inspect'),
      gateway: undefined as unknown as ToolGateway,
    })).rejects.toThrow(/per-turn ToolGateway/i);
  });

  it('does not create or resume a thread after its caller signal is cancelled', async () => {
    const backend = new GenericHarnessBackend(new SequencedProvider([]));
    const controller = new AbortController();
    controller.abort(new Error('thread setup cancelled'));

    await expect(backend.createThread({ id: 'cancelled-create', signal: controller.signal }))
      .rejects.toThrow('thread setup cancelled');
    await expect(backend.resume({
      id: 'cancelled-resume',
      priorMessages: [],
      signal: controller.signal,
    })).rejects.toThrow('thread setup cancelled');
  });

  it('rejects stale handles after a thread is resumed again', async () => {
    const backend = new GenericHarnessBackend(new SequencedProvider([]));
    const stale = await backend.resume({ id: 'thread-1', priorMessages: [] });
    await backend.resume({ id: 'thread-1', priorMessages: [] });

    await expect(backend.sendMessage(sendInput(stale, fakeGateway(), 'inspect')))
      .rejects.toThrow(/stale/i);
  });

  it('does not invoke or retain late tool and final completions after interruption', async () => {
    const requests: AgentCompletionRequest[] = [];
    let resolveCompletion!: (completion: AgentCompletion) => void;
    const provider: AgentProviderRuntime = {
      complete(request) {
        requests.push(request);
        if (requests.length === 3) {
          return Promise.resolve({ message: { role: 'assistant', content: 'fresh final' } });
        }
        return new Promise((resolve) => { resolveCompletion = resolve; });
      },
    };
    const backend = new GenericHarnessBackend(provider);
    const thread = await backend.createThread({ id: 'thread-1' });
    const firstGateway = fakeGateway();

    const lateToolTurn = backend.sendMessage(sendInput(
      thread,
      firstGateway,
      'cancelled tool turn',
    ));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await backend.interrupt({ threadId: thread.id, reason: 'takeover' });
    resolveCompletion({
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [{
          id: 'late-command',
          name: 'terminal_execute',
          arguments: JSON.stringify({ command: 'echo must-not-run' }),
        }],
      },
    });
    await expect(lateToolTurn).rejects.toThrow(/interrupted: takeover/i);
    expect(firstGateway.terminal.execute).not.toHaveBeenCalled();

    const lateFinalTurn = backend.sendMessage(sendInput(
      thread,
      fakeGateway(),
      'cancelled final turn',
    ));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await backend.interrupt({ threadId: thread.id, reason: 'user' });
    resolveCompletion({ message: { role: 'assistant', content: 'late final' } });
    await expect(lateFinalTurn).rejects.toThrow(/interrupted: user/i);

    const recovered = await backend.sendMessage(sendInput(thread, fakeGateway(), 'fresh turn'));

    expect(recovered.finalText).toBe('fresh final');
    const recoveredRequest = JSON.stringify(requests[2].messages);
    expect(recoveredRequest).not.toContain('cancelled tool turn');
    expect(recoveredRequest).not.toContain('cancelled final turn');
    expect(recoveredRequest).not.toContain('late final');
    expect(recoveredRequest).not.toContain('must-not-run');
  });

  it('interrupts only the matching active thread', async () => {
    const signals = new Map<string, AbortSignal>();
    let completeSecond!: (completion: AgentCompletion) => void;
    const provider: AgentProviderRuntime = {
      complete(request) {
        const prompt = request.messages.at(-1)?.content ?? '';
        const key = prompt.includes('first') ? 'thread-1' : 'thread-2';
        signals.set(key, request.signal);
        if (key === 'thread-1') {
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(
              request.signal.reason instanceof Error
                ? request.signal.reason
                : new Error('aborted'),
            ), { once: true });
          });
        }
        return new Promise((resolve) => { completeSecond = resolve; });
      },
    };
    const backend = new GenericHarnessBackend(provider);
    const first = await backend.createThread({ id: 'thread-1' });
    const second = await backend.createThread({ id: 'thread-2' });
    const firstTurn = backend.sendMessage(sendInput(first, fakeGateway(), 'first'));
    const secondTurn = backend.sendMessage(sendInput(second, fakeGateway(), 'second'));
    await vi.waitFor(() => expect(signals.size).toBe(2));

    await backend.interrupt({ threadId: 'thread-1', reason: 'user' });

    expect(signals.get('thread-1')?.aborted).toBe(true);
    expect(signals.get('thread-2')?.aborted).toBe(false);
    await expect(firstTurn).rejects.toThrow(/interrupted: user/i);
    completeSecond({ message: { role: 'assistant', content: 'second complete' } });
    await expect(secondTurn).resolves.toMatchObject({ finalText: 'second complete' });
  });
});
