import { describe, expect, it, vi } from 'vitest';
import type { ProviderProfile } from '../../shared/provider';
import type {
  ToolGateway,
  WorkspaceTool,
  WorkspaceToolPermissions,
} from '../../shared/tools';
import type { ProviderStore } from '../providers/provider-store';
import {
  AgentLoop,
} from './agent-loop';
import type {
  AgentCompletion,
  AgentCompletionRequest,
  AgentProviderRuntime,
  AgentToolDefinition,
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
  workspacePermissions?: Partial<WorkspaceToolPermissions>;
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
        ...overrides.workspacePermissions,
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
  it('never invokes terminal or Workspace tools from a completion returned after cancellation', async () => {
    let resolveCompletion!: (completion: AgentCompletion) => void;
    const provider: AgentProviderRuntime = {
      complete: vi.fn(() => new Promise<AgentCompletion>((resolve) => {
        resolveCompletion = resolve;
      })),
    };
    const execute = vi.fn();
    const writeFile = vi.fn();
    const controller = new AbortController();
    const events: string[] = [];
    const loop = new AgentLoop(
      provider,
      fakeToolGateway({ terminal: { execute }, workspace: { writeFile } }),
      (event) => events.push(event.type),
    );

    const turn = loop.run({
      systemPrompt: 'Use injected tools.',
      userPrompt: 'Make a change.',
      terminalContext: '',
      fileAccessMode: 'read-write',
      signal: controller.signal,
    });
    const rejection = expect(turn).rejects.toThrow('cancelled by takeover');
    controller.abort(new Error('cancelled by takeover'));
    resolveCompletion({
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'late-write',
            name: 'workspace_write_file',
            arguments: JSON.stringify({
              path: 'late.txt',
              content: 'must not be written',
              expectedSha256: null,
            }),
          },
          {
            id: 'late-command',
            name: 'terminal_execute',
            arguments: JSON.stringify({ command: 'echo must-not-run' }),
          },
        ],
      },
    });

    await rejection;
    expect(writeFile).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('rechecks cancellation after tool_started before invoking the gateway', async () => {
    const controller = new AbortController();
    const execute = vi.fn();
    const provider = new SequencedProvider([{
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [{
          id: 'command-1',
          name: 'terminal_execute',
          arguments: JSON.stringify({ command: 'echo must-not-run' }),
        }],
      },
    }]);
    const loop = new AgentLoop(
      provider,
      fakeToolGateway({ terminal: { execute } }),
      (event) => {
        if (event.type === 'tool_started') {
          controller.abort(new Error('cancelled at tool boundary'));
        }
      },
    );

    await expect(loop.run({
      systemPrompt: 'Use injected tools.',
      userPrompt: 'Run a command.',
      terminalContext: '',
      signal: controller.signal,
    })).rejects.toThrow('cancelled at tool boundary');
    expect(execute).not.toHaveBeenCalled();
  });

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
    expect(toolMessage?.content).toContain('Unsupported tool');
  });

  it('advertises only canonical workspace tools at the explicit access level and denies a write', async () => {
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: null, toolCalls: [{
        id: 'write-1', name: 'workspace_write_file',
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

    const advertised = provider.requests[0].tools.map((tool) => tool.name);
    expect(advertised).toEqual(expect.arrayContaining([
      'workspace_list',
      'workspace_read_file',
      'workspace_stat',
      'workspace_search',
      'workspace_glob',
    ]));
    expect(advertised).not.toContain('workspace_write_file');
    expect(advertised.every((name) => !name.startsWith('file_'))).toBe(true);
    expect(writeFile).not.toHaveBeenCalled();
    expect(provider.requests[1].messages).toContainEqual(expect.objectContaining({
      role: 'tool', content: expect.stringContaining('requires read-write access'),
    }));
  });

  it('advertises workspace schemas from granular gateway capabilities', async () => {
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: 'capabilities inspected' } },
    ]);
    const loop = new AgentLoop(provider, fakeToolGateway({
      workspacePermissions: {
        read: false,
        write: false,
        create: true,
        delete: true,
        writablePaths: ['/work'],
      },
    }));

    await loop.run({
      systemPrompt: 'test', userPrompt: 'inspect', terminalContext: '',
      fileAccessMode: 'read-write', signal: new AbortController().signal,
    });

    const advertised = provider.requests[0].tools.map((tool) => tool.name);
    expect(advertised).toEqual(expect.arrayContaining([
      'workspace_write_file',
      'workspace_mkdir',
      'workspace_delete',
    ]));
    expect(advertised).not.toEqual(expect.arrayContaining([
      'workspace_list',
      'workspace_read_file',
      'workspace_stat',
      'workspace_search',
      'workspace_glob',
      'workspace_apply_patch',
      'workspace_rename',
    ]));
  });

  it('does not advertise capabilities with no usable path scope', async () => {
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: 'no scoped tools' } },
    ]);
    const loop = new AgentLoop(provider, fakeToolGateway({
      workspacePermissions: {
        read: true,
        write: true,
        create: true,
        delete: true,
        readablePaths: [],
        writablePaths: [],
        fullAccess: false,
      },
    }));

    await loop.run({
      systemPrompt: 'test', userPrompt: 'inspect', terminalContext: '',
      fileAccessMode: 'read-write', signal: new AbortController().signal,
    });

    expect(provider.requests[0].tools.map((tool) => tool.name)
      .filter((name) => name.startsWith('workspace_'))).toEqual([]);
  });

  it('treats full-access as write-capable without bypassing granular flags', async () => {
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: null, toolCalls: [{
        id: 'create-1',
        name: 'workspace_write_file',
        arguments: '{"path":"D:\\\\outside\\\\new.ts","content":"x","expectedSha256":null}',
      }] } },
      { message: { role: 'assistant', content: 'created' } },
    ]);
    const writeFile = vi.fn().mockResolvedValue({
      path: 'D:\\outside\\new.ts',
      bytes: 1,
      sha256: 'b'.repeat(64),
      created: true,
    });
    const loop = new AgentLoop(provider, fakeToolGateway({
      workspace: { writeFile },
      workspacePermissions: { mode: 'full-access', fullAccess: true, create: true },
    }));

    await loop.run({
      systemPrompt: 'test', userPrompt: 'create', terminalContext: '',
      fileAccessMode: 'full-access', signal: new AbortController().signal,
    });

    expect(provider.requests[0].tools.map((tool) => tool.name)).toContain('workspace_write_file');
    expect(writeFile).toHaveBeenCalledOnce();

    const noCreateProvider = new SequencedProvider([
      { message: { role: 'assistant', content: 'no create tool' } },
    ]);
    const noCreateLoop = new AgentLoop(noCreateProvider, fakeToolGateway({
      workspacePermissions: { mode: 'full-access', fullAccess: true, create: false },
    }));
    await noCreateLoop.run({
      systemPrompt: 'test', userPrompt: 'inspect', terminalContext: '',
      fileAccessMode: 'full-access', signal: new AbortController().signal,
    });
    expect(noCreateProvider.requests[0].tools.map((tool) => tool.name))
      .not.toContain('workspace_mkdir');
  });

  it('executes workspace_stat as a read-only tool and compacts its history', async () => {
    let statResultSeen = false;
    const provider: AgentProviderRuntime = {
      async complete(request) {
        if (!statResultSeen) {
          statResultSeen = request.messages.some((message) => (
            message.role === 'tool'
            && message.toolCallId === 'stat-1'
            && message.content.includes('2026-08-16T00:00:00.000Z')
          ));
        }
        if (!statResultSeen) {
          return { message: { role: 'assistant', content: null, toolCalls: [{
            id: 'stat-1', name: 'workspace_stat', arguments: '{"path":"src/main.ts"}',
          }] } };
        }
        return { message: { role: 'assistant', content: 'stat complete' } };
      },
    };
    const stat = vi.fn(async (path: string) => ({
      path: `/work/${path}`,
      type: 'file' as const,
      size: 42,
      mode: 0o100644,
      modifiedAt: '2026-08-16T00:00:00.000Z',
    }));
    const loop = new AgentLoop(provider, fakeToolGateway({ workspace: { stat } }));

    const result = await loop.run({
      systemPrompt: 'test', userPrompt: 'inspect', terminalContext: '',
      fileAccessMode: 'read-only', signal: new AbortController().signal,
    });

    expect(stat).toHaveBeenCalledWith('src/main.ts');
    expect(statResultSeen).toBe(true);
    expect(JSON.stringify(result.messages)).not.toContain('2026-08-16T00:00:00.000Z');
    expect(JSON.stringify(result.messages)).toContain('historyCompacted');
  });

  it('keeps a file read for one reasoning step then compacts file contents and write arguments', async () => {
    let requestIndex = 0;
    let advertisedTools: AgentToolDefinition[] = [];
    const provider: AgentProviderRuntime = {
      async complete(request) {
        requestIndex += 1;
        if (requestIndex === 1) advertisedTools = request.tools;
        if (requestIndex === 1) return { message: { role: 'assistant', content: null, toolCalls: [{
          id: 'read-1', name: 'workspace_read_file', arguments: '{"path":"a.ts"}',
        }] } };
        if (requestIndex === 2) {
          expect(request.messages).toContainEqual(expect.objectContaining({
            role: 'tool', toolCallId: 'read-1', content: expect.stringContaining('const value = 1'),
          }));
          return { message: { role: 'assistant', content: null, toolCalls: [{
            id: 'patch-1', name: 'workspace_apply_patch', arguments: JSON.stringify({
              path: 'a.ts', expectedSha256: 'a'.repeat(64),
              patches: [{ search: '1', replace: '2' }],
            }),
          }] } };
        }
        expect(request.messages).toContainEqual(expect.objectContaining({
          role: 'tool',
          toolCallId: 'patch-1',
          content: expect.stringContaining('@@ -1 +1 @@'),
        }));
        return { message: { role: 'assistant', content: 'done' } };
      },
    };
    const loop = new AgentLoop(provider, fakeToolGateway({ workspace: {
      readFile: async () => ({
        path: '/work/a.ts', content: 'const value = 1;', bytes: 16, sha256: 'a'.repeat(64),
      }),
      applyPatch: async () => ({
        path: '/work/a.ts', bytes: 16, sha256: 'b'.repeat(64), created: false,
        diff: '@@ -1 +1 @@\n-const value = 1;\n+const value = 2;',
        additions: 1,
        deletions: 1,
      }),
    } }));

    const result = await loop.run({
      systemPrompt: 'test', userPrompt: 'test', terminalContext: '',
      fileAccessMode: 'read-write', signal: new AbortController().signal,
    });
    expect(JSON.stringify(result.messages)).not.toContain('const value = 1');
    expect(JSON.stringify(result.messages)).not.toContain('"search":"1"');
    expect(JSON.stringify(result.messages)).not.toContain('@@ -1 +1 @@');
    expect(JSON.stringify(result.messages)).toContain('historyCompacted');
    const compactedPatch = result.messages.find((message) => (
      message.role === 'tool' && message.toolCallId === 'patch-1'
    ));
    expect(compactedPatch?.role === 'tool' ? JSON.parse(compactedPatch.content) : null)
      .toMatchObject({ additions: 1, deletions: 1 });
    expect(advertisedTools.findIndex((tool) => tool.name === 'workspace_apply_patch'))
      .toBeLessThan(advertisedTools.findIndex((tool) => tool.name === 'workspace_write_file'));
    expect(advertisedTools.find((tool) => tool.name === 'workspace_apply_patch')?.description)
      .toContain('Preferred');
    expect(advertisedTools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'workspace_apply_patch',
      'workspace_write_file',
      'workspace_mkdir',
      'workspace_rename',
      'workspace_delete',
    ]));
    expect(advertisedTools.every((tool) => !tool.name.startsWith('file_'))).toBe(true);
  });

  it('executes structured search and glob without retaining queries or full results', async () => {
    let requestIndex = 0;
    const provider: AgentProviderRuntime = {
      async complete(request) {
        requestIndex += 1;
        if (requestIndex === 1) {
          return { message: { role: 'assistant', content: null, toolCalls: [{
            id: 'search-1',
            name: 'workspace_search',
            arguments: JSON.stringify({
              query: 'SensitiveNeedle', path: 'src', maxResults: 3,
            }),
          }] } };
        }
        if (requestIndex === 2) {
          expect(request.messages).toContainEqual(expect.objectContaining({
            role: 'tool',
            toolCallId: 'search-1',
            content: expect.stringContaining('matched line'),
          }));
          return { message: { role: 'assistant', content: null, toolCalls: [{
            id: 'glob-1',
            name: 'workspace_glob',
            arguments: JSON.stringify({ pattern: '**/*.ts', maxResults: 5 }),
          }] } };
        }
        expect(request.messages).toContainEqual(expect.objectContaining({
          role: 'tool',
          toolCallId: 'glob-1',
          content: expect.stringContaining('src/main.ts'),
        }));
        return { message: { role: 'assistant', content: 'found' } };
      },
    };
    const search = vi.fn().mockResolvedValue({
      query: 'SensitiveNeedle',
      matches: [{ path: '/work/src/main.ts', line: 4, column: 2, preview: 'matched line' }],
      filesScanned: 7,
      truncated: false,
    });
    const glob = vi.fn().mockResolvedValue({
      pattern: '**/*.ts',
      paths: ['/work/src/main.ts', '/work/src/other.ts'],
      truncated: false,
    });
    const execute = vi.fn();
    const loop = new AgentLoop(provider, fakeToolGateway({
      terminal: { execute },
      workspace: { search, glob },
    }));

    const result = await loop.run({
      systemPrompt: 'test', userPrompt: 'locate code', terminalContext: '',
      fileAccessMode: 'read-only', signal: new AbortController().signal,
    });

    expect(search).toHaveBeenCalledWith('SensitiveNeedle', { path: 'src', maxResults: 3 });
    expect(glob).toHaveBeenCalledWith('**/*.ts', { maxResults: 5 });
    expect(execute).not.toHaveBeenCalled();
    const compacted = JSON.stringify(result.messages);
    expect(compacted).not.toContain('SensitiveNeedle');
    expect(compacted).not.toContain('**/*.ts');
    expect(compacted).not.toContain('matched line');
    const compactedSearch = result.messages.find((message) => (
      message.role === 'tool' && message.toolCallId === 'search-1'
    ));
    const compactedGlob = result.messages.find((message) => (
      message.role === 'tool' && message.toolCallId === 'glob-1'
    ));
    expect(compactedSearch?.role === 'tool' ? JSON.parse(compactedSearch.content) : null)
      .toMatchObject({ matches: 1, filesScanned: 7, truncated: false });
    expect(compactedGlob?.role === 'tool' ? JSON.parse(compactedGlob.content) : null)
      .toMatchObject({ paths: 2, truncated: false });
  });

  it('executes mkdir, rename, and explicitly recursive delete through workspace tools', async () => {
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: null, toolCalls: [
        { id: 'mkdir-1', name: 'workspace_mkdir', arguments: '{"path":"tmp"}' },
        {
          id: 'rename-1',
          name: 'workspace_rename',
          arguments: '{"source":"tmp","destination":"cache"}',
        },
        {
          id: 'delete-1',
          name: 'workspace_delete',
          arguments: '{"path":"cache","recursive":true}',
        },
      ] } },
      { message: { role: 'assistant', content: 'mutations complete' } },
    ]);
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const rename = vi.fn().mockResolvedValue(undefined);
    const deletePath = vi.fn().mockResolvedValue(undefined);
    const loop = new AgentLoop(provider, fakeToolGateway({ workspace: {
      mkdir,
      rename,
      delete: deletePath,
    } }));

    await loop.run({
      systemPrompt: 'test', userPrompt: 'reorganize', terminalContext: '',
      fileAccessMode: 'read-write', signal: new AbortController().signal,
    });

    expect(mkdir).toHaveBeenCalledWith('tmp');
    expect(rename).toHaveBeenCalledWith('tmp', 'cache');
    expect(deletePath).toHaveBeenCalledWith('cache', { recursive: true });
  });

  it('rejects manually invoked mkdir, rename, and delete calls in read-only mode', async () => {
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: null, toolCalls: [
        { id: 'mkdir-1', name: 'workspace_mkdir', arguments: '{"path":"tmp"}' },
        {
          id: 'rename-1',
          name: 'workspace_rename',
          arguments: '{"source":"tmp","destination":"cache"}',
        },
        { id: 'delete-1', name: 'workspace_delete', arguments: '{"path":"cache"}' },
      ] } },
      { message: { role: 'assistant', content: 'all denied' } },
    ]);
    const mkdir = vi.fn();
    const rename = vi.fn();
    const deletePath = vi.fn();
    const loop = new AgentLoop(provider, fakeToolGateway({ workspace: {
      mkdir,
      rename,
      delete: deletePath,
    } }));

    await loop.run({
      systemPrompt: 'test', userPrompt: 'mutate', terminalContext: '',
      fileAccessMode: 'read-only', signal: new AbortController().signal,
    });

    expect(mkdir).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(deletePath).not.toHaveBeenCalled();
    const toolResults = provider.requests[1].messages.filter((message) => message.role === 'tool');
    expect(toolResults).toHaveLength(3);
    expect(toolResults.every((message) => message.content.includes('requires read-write access')))
      .toBe(true);
    const advertised = provider.requests[0].tools.map((tool) => tool.name);
    expect(advertised).not.toContain('workspace_mkdir');
    expect(advertised).not.toContain('workspace_rename');
    expect(advertised).not.toContain('workspace_delete');
  });

  it('keeps legacy file tool names executable without advertising duplicate schemas', async () => {
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: null, toolCalls: [{
        id: 'legacy-read', name: 'file_read', arguments: '{"path":"legacy.ts"}',
      }] } },
      { message: { role: 'assistant', content: 'legacy turn restored' } },
    ]);
    const readFile = vi.fn().mockResolvedValue({
      path: '/work/legacy.ts', content: 'legacy', bytes: 6, sha256: 'a'.repeat(64),
    });
    const loop = new AgentLoop(provider, fakeToolGateway({ workspace: { readFile } }));

    await loop.run({
      systemPrompt: 'test', userPrompt: 'resume', terminalContext: '',
      fileAccessMode: 'read-only', signal: new AbortController().signal,
    });

    expect(readFile).toHaveBeenCalledWith('legacy.ts');
    expect(provider.requests[0].tools.map((tool) => tool.name))
      .not.toContain('file_read');
  });

  it.each([
    {
      name: 'denies create without create permission',
      expectedSha256: null,
      permissions: { create: false, write: true },
      allowed: false,
    },
    {
      name: 'allows create without overwrite permission',
      expectedSha256: null,
      permissions: { create: true, write: false },
      allowed: true,
    },
    {
      name: 'allows overwrite without create permission',
      expectedSha256: 'a'.repeat(64),
      permissions: { create: false, write: true },
      allowed: true,
    },
    {
      name: 'denies overwrite without write permission',
      expectedSha256: 'a'.repeat(64),
      permissions: { create: true, write: false },
      allowed: false,
    },
  ])('$name', async ({ expectedSha256, permissions, allowed }) => {
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: null, toolCalls: [{
        id: 'write-1',
        name: 'workspace_write_file',
        arguments: JSON.stringify({ path: 'a.ts', content: 'x', expectedSha256 }),
      }] } },
      { message: { role: 'assistant', content: allowed ? 'written' : 'denied' } },
    ]);
    const writeFile = vi.fn().mockResolvedValue({
      path: '/work/a.ts',
      bytes: 1,
      sha256: 'b'.repeat(64),
      created: expectedSha256 === null,
    });
    const loop = new AgentLoop(provider, fakeToolGateway({
      workspace: { writeFile },
      workspacePermissions: permissions,
    }));

    await loop.run({
      systemPrompt: 'test', userPrompt: 'write', terminalContext: '',
      fileAccessMode: 'read-write', signal: new AbortController().signal,
    });

    expect(writeFile).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (!allowed) {
      expect(provider.requests[1].messages).toContainEqual(expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('requires read-write access'),
      }));
    }
  });

  it('requires read plus write for overwrite and patch while create only needs create', async () => {
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: null, toolCalls: [
        {
          id: 'create-1',
          name: 'workspace_write_file',
          arguments: '{"path":"new.ts","content":"new","expectedSha256":null}',
        },
        {
          id: 'overwrite-1',
          name: 'workspace_write_file',
          arguments: JSON.stringify({
            path: 'old.ts', content: 'new', expectedSha256: 'a'.repeat(64),
          }),
        },
        {
          id: 'patch-1',
          name: 'workspace_apply_patch',
          arguments: JSON.stringify({
            path: 'old.ts',
            expectedSha256: 'a'.repeat(64),
            patches: [{ search: 'old', replace: 'new' }],
          }),
        },
      ] } },
      { message: { role: 'assistant', content: 'checked' } },
    ]);
    const writeFile = vi.fn().mockResolvedValue({
      path: '/work/new.ts', bytes: 3, sha256: 'b'.repeat(64), created: true,
    });
    const applyPatch = vi.fn();
    const loop = new AgentLoop(provider, fakeToolGateway({
      workspace: { writeFile, applyPatch },
      workspacePermissions: { read: false, write: true, create: true },
    }));

    await loop.run({
      systemPrompt: 'test', userPrompt: 'mutate', terminalContext: '',
      fileAccessMode: 'read-write', signal: new AbortController().signal,
    });

    expect(writeFile).toHaveBeenCalledOnce();
    expect(writeFile).toHaveBeenCalledWith('new.ts', 'new', null);
    expect(applyPatch).not.toHaveBeenCalled();
    const toolResults = provider.requests[1].messages.filter((message) => message.role === 'tool');
    expect(toolResults.find((message) => message.toolCallId === 'overwrite-1')?.content)
      .toContain('requires read-write access');
    expect(toolResults.find((message) => message.toolCallId === 'patch-1')?.content)
      .toContain('requires read-write access');
  });

  it.each(['write', 'create', 'delete'] as const)(
    'rejects workspace_rename when %s permission is missing',
    async (missingPermission) => {
      const provider = new SequencedProvider([
        { message: { role: 'assistant', content: null, toolCalls: [{
          id: 'rename-1',
          name: 'workspace_rename',
          arguments: '{"source":"from","destination":"to"}',
        }] } },
        { message: { role: 'assistant', content: 'denied' } },
      ]);
      const rename = vi.fn();
      const loop = new AgentLoop(provider, fakeToolGateway({
        workspace: { rename },
        workspacePermissions: { [missingPermission]: false },
      }));

      await loop.run({
        systemPrompt: 'test', userPrompt: 'rename', terminalContext: '',
        fileAccessMode: 'read-write', signal: new AbortController().signal,
      });

      expect(rename).not.toHaveBeenCalled();
      expect(provider.requests[1].messages).toContainEqual(expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('requires read-write access'),
      }));
    },
  );

  it('bounds oversized Workspace errors and charges them to the aggregate turn budget', async () => {
    const hugeError = new Error('sensitive-backend-error:'.padEnd(3 * 1024 * 1024, 'x'));
    const calls = Array.from({ length: 520 }, (_, index) => ({
      id: `search-error-${index}`,
      name: 'workspace_search',
      arguments: '{"query":"needle"}',
    }));
    let requestIndex = 0;
    let deliveredBytes = 0;
    let omittedResults = 0;
    const provider: AgentProviderRuntime = {
      async complete(request) {
        requestIndex += 1;
        if (requestIndex === 1) {
          return { message: { role: 'assistant', content: null, toolCalls: calls } };
        }
        const results = request.messages.filter((message) => message.role === 'tool');
        deliveredBytes = results.reduce((total, message) => (
          total + Buffer.byteLength(message.content, 'utf8')
        ), 0);
        omittedResults = results.filter((message) => (
          message.content === ''
          || message.content === '{}'
          || message.content.includes('"resultOmitted":true')
        )).length;
        return { message: { role: 'assistant', content: 'errors bounded' } };
      },
    };
    const completedResults: string[] = [];
    const search = vi.fn().mockRejectedValue(hugeError);
    const loop = new AgentLoop(provider, fakeToolGateway({ workspace: { search } }), (event) => {
      if (event.type === 'tool_completed') completedResults.push(event.result ?? '');
    });

    await loop.run({
      systemPrompt: 'test', userPrompt: 'search', terminalContext: '',
      fileAccessMode: 'read-only', signal: new AbortController().signal,
    });

    expect(search).toHaveBeenCalledTimes(520);
    expect(completedResults[0]?.length).toBeLessThan(5_000);
    expect(completedResults[0]).toContain('"errorTruncated":true');
    expect(completedResults.every((result) => result.length < 5_000)).toBe(true);
    expect(deliveredBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(omittedResults).toBeGreaterThan(0);
  });

  it('caps aggregate file read and directory-list results for one turn', async () => {
    const completedResults: string[] = [];
    const calls = Array.from({ length: 64 }, (_, index) => ({
      id: `list-${index}`, name: 'workspace_list', arguments: '{"path":"."}',
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
    expect(completedResults.some((result) => (
      result.includes('Workspace 工具结果超过')
    ))).toBe(true);
  });

  it('counts both write and patch diffs against the aggregate Workspace result budget', async () => {
    const completedResults: string[] = [];
    const writeCalls = Array.from({ length: 40 }, (_, index) => ({
      id: `write-${index}`,
      name: 'workspace_write_file',
      arguments: JSON.stringify({
        path: `generated-${index}.ts`,
        content: 'x',
        expectedSha256: null,
      }),
    }));
    const patchCalls = Array.from({ length: 40 }, (_, index) => ({
      id: `patch-${index}`,
      name: 'workspace_apply_patch',
      arguments: JSON.stringify({
        path: `existing-${index}.ts`,
        expectedSha256: 'a'.repeat(64),
        patches: [{ search: 'x', replace: 'y' }],
      }),
    }));
    const provider = new SequencedProvider([
      { message: { role: 'assistant', content: null, toolCalls: [
        ...writeCalls,
        ...patchCalls,
      ] } },
      { message: { role: 'assistant', content: 'bounded' } },
    ]);
    const diff = 'd'.repeat(30_000);
    const writeFile = vi.fn(async (path: string) => ({
      path: `/work/${path}`,
      bytes: 1,
      sha256: 'b'.repeat(64),
      created: true,
      diff,
      additions: 1,
      deletions: 0,
    }));
    const applyPatch = vi.fn(async (path: string) => ({
      path: `/work/${path}`,
      bytes: 1,
      sha256: 'c'.repeat(64),
      created: false,
      diff,
      additions: 1,
      deletions: 1,
    }));
    const loop = new AgentLoop(provider, fakeToolGateway({ workspace: {
      writeFile,
      applyPatch,
    } }), (event) => {
      if (event.type === 'tool_completed' && event.result) completedResults.push(event.result);
    });

    await loop.run({
      systemPrompt: 'test', userPrompt: 'mutate', terminalContext: '',
      fileAccessMode: 'read-write', signal: new AbortController().signal,
    });

    expect(writeFile).toHaveBeenCalledTimes(40);
    expect(applyPatch).toHaveBeenCalledTimes(40);
    expect(completedResults.some((result) => (
      result.includes('Workspace 工具结果超过')
    ))).toBe(true);
  });

  it('bounds aggregate mkdir, rename, and delete results before the next Provider request', async () => {
    const longPath = `tmp/${'x'.repeat(1_800)}`;
    const renameSource = `from/${'s'.repeat(900)}`;
    const renameDestination = `to/${'d'.repeat(900)}`;
    const mkdirCalls = Array.from({ length: 400 }, (_, index) => ({
      id: `mkdir-budget-${index}`,
      name: 'workspace_mkdir',
      arguments: JSON.stringify({ path: longPath }),
    }));
    const renameCalls = Array.from({ length: 400 }, (_, index) => ({
      id: `rename-budget-${index}`,
      name: 'workspace_rename',
      arguments: JSON.stringify({
        source: renameSource,
        destination: renameDestination,
      }),
    }));
    const deleteCalls = Array.from({ length: 400 }, (_, index) => ({
      id: `delete-budget-${index}`,
      name: 'workspace_delete',
      arguments: JSON.stringify({ path: longPath }),
    }));
    let requestIndex = 0;
    let deliveredBytes = 0;
    let omittedResults = 0;
    const provider: AgentProviderRuntime = {
      async complete(request) {
        requestIndex += 1;
        if (requestIndex === 1) {
          return { message: { role: 'assistant', content: null, toolCalls: [
            ...mkdirCalls,
            ...renameCalls,
            ...deleteCalls,
          ] } };
        }
        const results = request.messages.filter((message) => message.role === 'tool');
        deliveredBytes = results.reduce((total, message) => (
          total + Buffer.byteLength(message.content, 'utf8')
        ), 0);
        omittedResults = results.filter((message) => (
          message.content === ''
          || message.content === '{}'
          || message.content.includes('"resultOmitted":true')
          || message.content.includes('Workspace 工具结果超过')
        )).length;
        return { message: { role: 'assistant', content: 'mutations bounded' } };
      },
    };
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const rename = vi.fn().mockResolvedValue(undefined);
    const deletePath = vi.fn().mockResolvedValue(undefined);
    const loop = new AgentLoop(provider, fakeToolGateway({ workspace: {
      mkdir,
      rename,
      delete: deletePath,
    } }));

    await loop.run({
      systemPrompt: 'test', userPrompt: 'many mutations', terminalContext: '',
      fileAccessMode: 'read-write', signal: new AbortController().signal,
    });

    expect(mkdir).toHaveBeenCalledTimes(400);
    expect(rename).toHaveBeenCalledTimes(400);
    expect(deletePath).toHaveBeenCalledTimes(400);
    expect(deliveredBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(omittedResults).toBeGreaterThan(0);
  });
});

describe('GenericOpenAiProvider', () => {
  function runtimeProviderStore(
    profile: ProviderProfile,
    apiKey = 'request-only-secret',
  ): ProviderStore {
    const assertRuntimeRecipient = (
      _providerId: string,
      expectedRecipientRevision?: string,
    ) => {
      if (
        profile.status !== 'ready'
        || (
          expectedRecipientRevision !== undefined
          && profile.recipientRevision !== expectedRecipientRevision
        )
      ) throw new Error('Provider recipient changed.');
      return profile;
    };
    return {
      get: () => profile,
      apiKey: async () => apiKey,
      assertRuntimeRecipient,
      runtimeSnapshot: async (_providerId: string, expectedRecipientRevision: string) => ({
        profile: assertRuntimeRecipient(_providerId, expectedRecipientRevision),
        apiKey,
      }),
    } as unknown as ProviderStore;
  }

  it('rechecks recipient identity immediately before network dispatch', async () => {
    const original: ProviderProfile = {
      id: 'provider-race', name: 'Original', kind: 'generic-openai-compatible',
      baseUrl: 'https://old.example/v1', modelId: 'old-model',
      recipientRevision: 'old-recipient', apiKeyConfigured: true,
      isDefault: true, status: 'ready', createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    let current = original;
    const replacement: ProviderProfile = {
      ...original,
      baseUrl: 'https://new.example/v1',
      recipientRevision: 'new-recipient',
      updatedAt: new Date(1).toISOString(),
    };
    const assertRuntimeRecipient = (
      _providerId: string,
      expectedRecipientRevision?: string,
    ) => {
      if (current.recipientRevision !== expectedRecipientRevision) {
        throw new Error('Provider recipient changed before dispatch.');
      }
      return current;
    };
    const store = {
      get: () => current,
      runtimeSnapshot: async () => {
        queueMicrotask(() => { current = replacement; });
        return { profile: original, apiKey: 'old-secret' };
      },
      assertRuntimeRecipient,
    } as unknown as ProviderStore;
    const fetchMock = vi.fn<typeof fetch>();
    const runtime = new GenericOpenAiProvider(original.id, store, fetchMock);

    await expect(runtime.complete({
      messages: [{ role: 'user', content: 'must stay with old recipient' }],
      tools: [],
      signal: new AbortController().signal,
    })).rejects.toThrow('changed before dispatch');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never sends accumulated AgentLoop history after the recipient changes between rounds', async () => {
    const original: ProviderProfile = {
      id: 'provider-rounds', name: 'Original', kind: 'generic-openai-compatible',
      baseUrl: 'https://old.example/v1', modelId: 'old-model',
      recipientRevision: 'old-recipient', apiKeyConfigured: true,
      isDefault: true, status: 'ready', createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    let current = original;
    const replacement: ProviderProfile = {
      ...original,
      baseUrl: 'https://new.example/v1',
      modelId: 'new-model',
      recipientRevision: 'new-recipient',
      updatedAt: new Date(1).toISOString(),
    };
    const store = {
      get: () => current,
      assertRuntimeRecipient: (
        _providerId: string,
        expectedRecipientRevision?: string,
      ) => {
        if (current.recipientRevision !== expectedRecipientRevision) {
          throw new Error('Provider recipient changed between rounds.');
        }
        return current;
      },
      runtimeSnapshot: async (
        _providerId: string,
        expectedRecipientRevision: string,
      ) => {
        if (current.recipientRevision !== expectedRecipientRevision) {
          throw new Error('Provider recipient changed between rounds.');
        }
        return { profile: current, apiKey: 'old-secret' };
      },
    } as unknown as ProviderStore;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant', content: null,
          tool_calls: [{
            id: 'read-1', type: 'function',
            function: { name: 'terminal_read', arguments: '{}' },
          }],
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const runtime = new GenericOpenAiProvider(original.id, store, fetchMock);
    const loop = new AgentLoop(runtime, fakeToolGateway({
      terminal: {
        readVisible: async () => {
          current = replacement;
          return 'visible output';
        },
      },
    }));

    await expect(loop.run({
      systemPrompt: 'system',
      userPrompt: 'old-recipient private prompt',
      terminalContext: '',
      signal: new AbortController().signal,
    })).rejects.toThrow('changed between rounds');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe('https://old.example/v1/chat/completions');
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(replacement.baseUrl)))
      .toBe(false);
  });

  it('parses split SSE deltas and reconstructs streamed tool calls', async () => {
    const profile: ProviderProfile = {
      id: 'provider-1',
      name: 'Mock Provider',
      kind: 'generic-openai-compatible',
      baseUrl: 'https://provider.example/v1',
      modelId: 'model-1',
      recipientRevision: 'recipient-provider-1',
      apiKeyConfigured: true,
      isDefault: true,
      status: 'ready',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const providerStore = runtimeProviderStore(profile);
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
      recipientRevision: 'recipient-provider-1',
      apiKeyConfigured: true,
      isDefault: true,
      status: 'ready',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const providerStore = runtimeProviderStore(profile);
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
      baseUrl: 'https://provider.example/v1', modelId: 'model-1',
      recipientRevision: 'recipient-provider-1', apiKeyConfigured: true,
      isDefault: true, status: 'ready', createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const providerStore = runtimeProviderStore(profile);
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
      baseUrl: 'https://provider.example/v1', modelId: 'model-1',
      recipientRevision: 'recipient-provider-1', apiKeyConfigured: true,
      isDefault: true, status: 'ready', createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const providerStore = runtimeProviderStore(profile);
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
      baseUrl: 'https://provider.example/v1', modelId: 'model-1',
      recipientRevision: 'recipient-provider-1', apiKeyConfigured: true,
      isDefault: true, status: 'ready', createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const providerStore = runtimeProviderStore(profile);
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
        baseUrl: 'https://provider.example/v1', modelId: 'model-1',
        recipientRevision: 'recipient-provider-1', apiKeyConfigured: true,
        isDefault: true, status: 'ready', createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      const providerStore = runtimeProviderStore(profile);
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
      recipientRevision: 'recipient-provider-1',
      apiKeyConfigured: true,
      isDefault: true,
      status: 'ready',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const providerStore = runtimeProviderStore(profile);
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
