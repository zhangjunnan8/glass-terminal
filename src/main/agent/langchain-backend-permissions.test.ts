// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ChatOpenAICompletions } from '@langchain/openai';
import type { AgentFileAccessMode } from '../../shared/agent';
import type { AgentBackendEvent, AgentMessage } from './agent-backend';
import type { TerminalTool, ToolGateway, WorkspaceTool } from '../../shared/tools';
import { LangChainBackend } from './langchain-backend';

/**
 * Verifies the LangChain harness never exposes workspace tools the Session
 * permissions forbid. The application-layer policy membrane (PolicyWorkspaceTool)
 * is the authoritative enforcement; this test pins the model-facing schema so a
 * permission regression cannot silently advertise write tools in read-only mode.
 */

function stubWorkspace(): WorkspaceTool {
  const fail = async (): Promise<never> => { throw new Error('workspace stub'); };
  return {
    listDirectory: fail,
    readFile: fail,
    writeFile: fail,
    applyPatch: fail,
    search: fail,
    glob: fail,
    stat: fail,
    mkdir: fail,
    rename: fail,
    delete: fail,
  };
}

function buildGateway(mode: AgentFileAccessMode): ToolGateway {
  const terminal: TerminalTool = {
    execute: async (command) => ({
      commandId: 'c',
      command,
      status: 'completed' as const,
      exitCode: 0,
      output: '',
      startedAt: 0,
      finishedAt: 0,
      durationMs: 1,
    }),
    sendInput: async () => {},
    interrupt: async () => {},
    readVisible: async () => '',
    readHistory: async () => '',
    getState: async () => ({
      terminalId: 't',
      sessionId: 's',
      transport: 'local',
      shellKind: 'posix',
      status: 'connected',
      terminalInputMode: 'human',
    }),
  };
  const enabled = mode !== 'off';
  const writable = mode === 'read-write' || mode === 'full-access';
  return {
    context: {
      sessionId: 's',
      terminal: { type: 'local', terminalId: 't' },
      ...(enabled ? { workspace: { backend: 'local', root: '/' } } : {}),
      permissions: {
        terminal: { read: true, execute: true, sendInput: false, interrupt: true },
        workspace: {
          enabled,
          mode,
          read: enabled,
          write: writable,
          create: writable,
          delete: writable,
          readablePaths: enabled ? ['/'] : [],
          writablePaths: writable ? ['/'] : [],
          fullAccess: mode === 'full-access',
        },
      },
    },
    terminal,
    workspace: enabled ? stubWorkspace() : undefined,
  };
}

async function startToolCaptureServer(): Promise<{
  baseUrl: string;
  server: Server;
  getTools: () => string[];
}> {
  let capturedTools: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
      capturedTools = (parsed.tools ?? []).map((entry) => entry.function?.name ?? '');
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    server,
    getTools: () => [...capturedTools],
  };
}

async function runTurn(mode: AgentFileAccessMode): Promise<string[]> {
  const capture = await startToolCaptureServer();
  try {
    const model = new ChatOpenAICompletions({
      model: 'permission-test',
      apiKey: 'fake',
      temperature: 0,
      maxRetries: 0,
      configuration: { baseURL: capture.baseUrl },
    });
    const backend = new LangChainBackend({ modelFactory: () => Promise.resolve(model) });
    const thread = await backend.createThread({ id: `perm-${mode}` });
    await backend.sendMessage({
      thread,
      prompt: 'hello',
      systemPrompt: 'system',
      terminalContext: '',
      fileAccessMode: mode,
      gateway: buildGateway(mode),
      signal: new AbortController().signal,
    });
    return capture.getTools();
  } finally {
    await new Promise<void>((resolve) => capture.server.close(() => resolve()));
  }
}

describe('LangChainBackend workspace tool gating', () => {
  it('advertises only terminal tools when file access is off', async () => {
    const tools = await runTurn('off');
    expect(tools).toContain('terminal_execute');
    expect(tools.filter((tool) => tool.startsWith('workspace_'))).toEqual([]);
  });

  it('advertises read tools but never write tools in read-only mode', async () => {
    const tools = await runTurn('read-only');
    expect(tools).toContain('workspace_list');
    expect(tools).toContain('workspace_read_file');
    expect(tools).toContain('workspace_search');
    expect(tools).toContain('workspace_glob');
    expect(tools).not.toContain('workspace_apply_patch');
    expect(tools).not.toContain('workspace_write_file');
    expect(tools).not.toContain('workspace_mkdir');
    expect(tools).not.toContain('workspace_rename');
    expect(tools).not.toContain('workspace_delete');
  });

  it('advertises read and write tools in read-write mode', async () => {
    const tools = await runTurn('read-write');
    expect(tools).toContain('workspace_read_file');
    expect(tools).toContain('workspace_apply_patch');
    expect(tools).toContain('workspace_write_file');
    expect(tools).toContain('workspace_mkdir');
    expect(tools).toContain('workspace_rename');
    expect(tools).toContain('workspace_delete');
  });

  it('compresses a full resumed context before dispatch and persists a bounded checkpoint', async () => {
    const capture = await startToolCaptureServer();
    try {
      const model = new ChatOpenAICompletions({
        model: 'context-test',
        apiKey: 'fake',
        temperature: 0,
        maxRetries: 0,
        configuration: { baseURL: capture.baseUrl },
      });
      const summarize = vi.fn(async () => '- Goal: continue the retained coding task.');
      const backend = new LangChainBackend({
        modelFactory: () => Promise.resolve(model),
        contextWindowTokens: 8_192,
        summarize,
      });
      const priorMessages: AgentMessage[] = [];
      for (let turn = 1; turn <= 5; turn += 1) {
        priorMessages.push({ role: 'user', content: `old-turn-${turn}:` + '汉'.repeat(1_700) });
        priorMessages.push({ role: 'assistant', content: `old-answer-${turn}` });
      }
      const thread = await backend.resume({ id: 'context-resume', priorMessages });
      const events: AgentBackendEvent[] = [];

      const result = await backend.sendMessage({
        thread,
        prompt: 'Current request.',
        systemPrompt: 'System policy.',
        terminalContext: '',
        fileAccessMode: 'off',
        gateway: buildGateway('off'),
        signal: new AbortController().signal,
        onEvent: (event) => events.push(event),
      });

      expect(summarize).toHaveBeenCalledOnce();
      expect(events.some((event) => (
        event.type === 'context_status' && event.contextUsage?.status === 'compressing'
      ))).toBe(true);
      expect(events.some((event) => Boolean(event.compression))).toBe(true);
      expect(result.contextUsage?.percentage).toBeLessThan(100);
      expect(result.contextPersistence?.mode).toBe('checkpoint');
      expect(JSON.stringify(result.contextPersistence?.messages)).not.toContain('old-turn-1:');
      expect(JSON.stringify(result.contextPersistence?.messages)).toContain('automatic context summary');
      expect(JSON.stringify(result.contextPersistence?.messages)).toContain('Current request.');
    } finally {
      await new Promise<void>((resolve) => capture.server.close(() => resolve()));
    }
  });
});
