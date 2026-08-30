// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { ChatOpenAICompletions } from '@langchain/openai';
import type { AgentSessionView } from '../../shared/agent';
import { TERMINAL_CHANNELS } from '../../shared/terminal';
import { LocalFilesystemBackend } from '../filesystem/local-filesystem';
import { HostStore } from '../hosts/host-store';
import { ProviderStore } from '../providers/provider-store';
import { MemorySecretStore } from '../providers/secret-store';
import { SessionManager } from '../sessions/session-manager';
import { SessionStore } from '../sessions/session-store';
import { TerminalService } from '../terminal/terminal-service';
import { AgentFileService } from './agent-file-service';
import { AgentService } from './agent-service';
import { LangChainBackend } from './langchain-backend';

/**
 * Spike: full-chain verification that a LangChain.js loop (with a DeepSeek-
 * compatible OpenAI transport) drives the project's shared ToolGateway.
 *
 * Proves:
 *  1. `terminal_execute` lands in the shared visible PTY (approved, visible).
 *  2. `workspace_read_file` / `workspace_apply_patch` go through the filesystem,
 *     never through cat/sed and never into the terminal.
 *  3. The harness never obtains its own shell/SSH/SFTP (no hidden connections).
 */

const MODEL_ID = 'deepseek-chat';
const API_KEY = 'spike-fake-key';
const MODE_OFF = 'MODE=off';
const MODE_ON = 'MODE=on';

interface SentEvent {
  channel: string;
  payload: unknown;
}

interface OpenAiMessage {
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
}

interface ChatPayload {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
}

interface ProviderWorkflowState {
  chatRequests: ChatPayload[];
  errors: string[];
  round: number;
  sha256?: string;
}

function browserOwner(): { owner: WebContents; sent: SentEvent[] } {
  const sent: SentEvent[] = [];
  const owner = {
    id: 7,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
  } as unknown as WebContents;
  return { owner, sent };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** Emits an OpenAI ChatCompletion as SSE chunks for LangChain's streaming parser. */
function streamCompletion(response: ServerResponse, completion: unknown): void {
  const body = completion as {
    choices: Array<{
      message?: {
        content?: unknown;
        tool_calls?: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
      };
    }>;
  };
  const choice = body.choices[0];
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
  if (choice?.message?.tool_calls?.length) {
    const toolCalls = choice.message.tool_calls.map((call, index) => ({
      index,
      id: call.id,
      type: 'function',
      function: { name: call.function.name, arguments: call.function.arguments },
    }));
    response.write(`data: ${JSON.stringify({
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: null, tool_calls: toolCalls },
        finish_reason: null,
      }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    })}\n\n`);
  } else {
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const mid = Math.max(1, Math.floor(content.length / 2));
    response.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: content.slice(0, mid) }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: content.slice(mid) }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`);
  }
  response.end('data: [DONE]\n\n');
}

/** Full OpenAI ChatCompletion envelope that LangChain's openai SDK expects. */
function openAiCompletion(choice: unknown): unknown {
  return {
    id: 'chatcmpl-spike',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [choice],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

function toolChoice(id: string, name: string, args: unknown): unknown {
  return {
    index: 0,
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      }],
    },
    finish_reason: 'tool_calls',
  };
}

function finalChoice(content: string): unknown {
  return {
    index: 0,
    message: { role: 'assistant', content },
    finish_reason: 'stop',
  };
}

function lastToolResult(payload: ChatPayload, expectedCallId: string): Record<string, unknown> {
  assertCondition(Array.isArray(payload.messages), 'Provider messages must be an array.');
  const last = payload.messages.at(-1) as OpenAiMessage | undefined;
  assertCondition(last?.role === 'tool', `Round expected tool result ${expectedCallId}.`);
  assertCondition(last.tool_call_id === expectedCallId, 'Unexpected tool result call id.');
  assertCondition(typeof last.content === 'string', 'Tool result content must be text.');
  const parsed: unknown = JSON.parse(last.content);
  assertCondition(parsed !== null && typeof parsed === 'object', 'Tool result must be an object.');
  return parsed as Record<string, unknown>;
}

function nextWorkflowCompletion(
  state: ProviderWorkflowState,
  payload: ChatPayload,
  testCommand: string,
): unknown {
  assertCondition(payload.model === MODEL_ID, 'LangChain used the wrong model.');
  assertCondition(Array.isArray(payload.tools), 'LangChain tools must be present.');
  const toolNames = (payload.tools as Array<{ function?: { name?: unknown } }>)
    .map((entry) => entry.function?.name);
  assertCondition(
    toolNames.includes('terminal_execute') && toolNames.includes('workspace_read_file'),
    'LangChain must expose terminal_execute and workspace_read_file tools.',
  );

  switch (state.round) {
    case 0:
      return openAiCompletion(toolChoice('call-version', 'terminal_execute', {
        command: 'node --version',
        reason: 'Prove the shared visible terminal path.',
      }));
    case 1: {
      const result = lastToolResult(payload, 'call-version');
      assertCondition(result.ok === true, 'terminal_execute (node --version) failed.');
      assertCondition(result.command === 'node --version', 'Wrong first command.');
      assertCondition(typeof result.output === 'string', 'Terminal output is missing.');
      return openAiCompletion(toolChoice('call-read', 'workspace_read_file', {
        path: 'src/app.txt',
      }));
    }
    case 2: {
      const result = lastToolResult(payload, 'call-read');
      assertCondition(result.ok === true, 'workspace_read_file failed.');
      assertCondition(typeof result.content === 'string', 'Read content is missing.');
      assertCondition(result.content.includes(MODE_OFF), 'Read content lost the MODE=off canary.');
      assertCondition(typeof result.sha256 === 'string', 'Read SHA-256 is missing.');
      state.sha256 = result.sha256;
      return openAiCompletion(toolChoice('call-patch', 'workspace_apply_patch', {
        path: 'src/app.txt',
        expectedSha256: state.sha256,
        patches: [{ search: MODE_OFF, replace: MODE_ON }],
      }));
    }
    case 3: {
      const result = lastToolResult(payload, 'call-patch');
      assertCondition(result.ok === true, 'workspace_apply_patch failed.');
      assertCondition(result.created === false, 'Patch unexpectedly created a file.');
      return openAiCompletion(toolChoice('call-test', 'terminal_execute', {
        command: testCommand,
        reason: 'Run the focused test after the patch.',
      }));
    }
    case 4: {
      const result = lastToolResult(payload, 'call-test');
      assertCondition(result.ok === true, 'terminal_execute (test) failed.');
      assertCondition(result.command === testCommand, 'Wrong second command.');
      assertCondition(result.status === 'completed', 'Test command did not complete.');
      assertCondition(result.exitCode === 0, 'Test command exit code was not 0.');
      assertCondition(String(result.output).includes('SPIKE_TEST_PASS'), 'Test output was not visible to the harness.');
      return openAiCompletion(finalChoice('Spike verified: LangChain drove the shared terminal and workspace tools.'));
    }
    default:
      throw new Error(`Unexpected Provider round ${state.round}.`);
  }
}

async function startProviderStub(testCommand: string): Promise<{
  baseUrl: string;
  server: Server;
  state: ProviderWorkflowState;
}> {
  const state: ProviderWorkflowState = { chatRequests: [], errors: [], round: 0 };
  const server = createServer(async (request, response) => {
    try {
      assertCondition(
        request.headers.authorization === `Bearer ${API_KEY}`,
        'Provider authorization is wrong.',
      );
      if (request.method === 'GET' && request.url === '/v1/models') {
        json(response, 200, { data: [{ id: MODEL_ID }] });
        return;
      }
      assertCondition(
        request.method === 'POST' && request.url === '/v1/chat/completions',
        `Unexpected Provider route ${request.method ?? ''} ${request.url ?? ''}.`,
      );
      const payload = JSON.parse(await requestBody(request)) as ChatPayload;
      state.chatRequests.push(payload);
      const completion = nextWorkflowCompletion(state, payload, testCommand);
      state.round += 1;
      streamCompletion(response, completion);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.errors.push(message);
      json(response, 500, { error: { message } });
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, server, state };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function waitForView(
  service: AgentService,
  owner: WebContents,
  terminalId: string,
  predicate: (view: AgentSessionView) => boolean,
  providerState: ProviderWorkflowState,
  timeoutMs = 30_000,
): Promise<AgentSessionView> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = service.getState(owner, terminalId);
    if (view && predicate(view)) return view;
    if (view?.state === 'FAILED') {
      const detail = providerState.errors.length
        ? ` Provider stub: ${providerState.errors.join(' | ')}`
        : '';
      throw new Error(`Spike failed: ${view.error ?? 'unknown error'}.${detail}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('Timed out waiting for the spike workflow.');
}

function shellQuote(path: string, shellKind: string): string {
  if (shellKind === 'powershell') return `'${path.replaceAll("'", "''")}'`;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function terminalPlainText(value: string): string {
  return value.replace(
    /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu,
    '',
  );
}

describe('LangChain backend spike (DeepSeek-compatible transport)', () => {
  it('routes commands to the shared PTY and files to the Workspace backend, with no hidden shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-langchain-spike-'));
    const workspaceRoot = join(root, 'workspace');
    const appPath = join(workspaceRoot, 'src', 'app.txt');
    const checkPath = join(workspaceRoot, 'test', 'check.cjs');
    mkdirSync(dirname(appPath), { recursive: true });
    mkdirSync(dirname(checkPath), { recursive: true });
    writeFileSync(appPath, `${MODE_OFF}\n`);
    writeFileSync(checkPath, [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const content = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.txt'), 'utf8');",
      "console.log(content.includes('MODE=on') ? 'SPIKE_TEST_PASS' : 'SPIKE_TEST_FAIL');",
      "process.exitCode = content.includes('MODE=on') ? 0 : 1;",
      '',
    ].join('\n'));

    const terminals = new TerminalService();
    const { owner, sent } = browserOwner();
    const profiles = terminals.listShells();
    const profile = profiles.find((candidate) => candidate.kind === 'powershell')
      ?? profiles.find((candidate) => candidate.kind === 'posix');
    assertCondition(profile, 'The spike requires PowerShell or a POSIX shell.');
    const testCommand = `node ${shellQuote(checkPath, profile.kind)}`;
    const providerStub = await startProviderStub(testCommand);
    let sessions: SessionManager | undefined;
    let agents: AgentService | undefined;
    let terminalId: string | undefined;
    const createSshSpy = vi.spyOn(terminals, 'createSsh');
    const openSftpSpy = vi.spyOn(terminals, 'openSftp');

    try {
      const providers = new ProviderStore(
        join(root, 'providers.json'),
        new MemorySecretStore(),
        fetch,
      );
      const provider = await providers.save({
        name: 'Spike DeepSeek Provider',
        baseUrl: providerStub.baseUrl,
        modelId: MODEL_ID,
        apiKey: API_KEY,
      });
      expect((await providers.testConnection(provider.id)).ok).toBe(true);

      const descriptor = terminals.create(owner, {
        profileId: profile.id,
        cols: 240,
        rows: 40,
      });
      terminalId = descriptor.id;
      terminals.attach(owner, terminalId);
      if (profile.kind === 'powershell') {
        // A real pwsh process can take several seconds to load the user's
        // profile when the full suite starts many workers concurrently.
        const integrationDeadline = Date.now() + 15_000;
        while (Date.now() < integrationDeadline) {
          const integration = terminals.state(owner, terminalId).shellIntegration as
            | { status?: string; rich?: boolean }
            | undefined;
          if (integration?.status === 'ready' && integration.rich) break;
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        }
        expect(terminals.state(owner, terminalId).shellIntegration).toMatchObject({
          status: 'ready',
          rich: true,
        });
      } else {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }

      const store = new SessionStore(join(root, 'sessions'));
      const localFilesystem = new LocalFilesystemBackend();
      sessions = new SessionManager(
        store,
        terminals,
        new HostStore(join(root, 'hosts.json')),
        undefined,
        localFilesystem,
      );
      const session = sessions.upgrade(owner, terminalId);
      const withWorkspace = await sessions.setWorkspace(owner, {
        terminalId,
        root: workspaceRoot,
      });
      const canonicalWorkspaceRoot = withWorkspace.workspace?.root;
      assertCondition(canonicalWorkspaceRoot, 'Local Workspace Root was not bound.');

      const files = new AgentFileService(terminals, sessions, undefined, localFilesystem);
      const model = new ChatOpenAICompletions({
        model: MODEL_ID,
        apiKey: API_KEY,
        temperature: 0,
        maxRetries: 0,
        timeout: 15_000,
        configuration: { baseURL: providerStub.baseUrl },
      });
      agents = new AgentService(
        terminals,
        sessions,
        providers,
        files,
        () => new LangChainBackend({ modelFactory: () => Promise.resolve(model) }),
      );
      const backend = { kind: 'generic-provider' as const, providerId: provider.id };
      const permission = await agents.setFileAccess(owner, {
        terminalId,
        mode: 'read-write',
        backend,
        expectedWorkspaceRoot: canonicalWorkspaceRoot,
        policy: {
          read: true,
          write: true,
          create: false,
          delete: false,
          readablePaths: [canonicalWorkspaceRoot],
          writablePaths: [canonicalWorkspaceRoot],
          fullAccess: false,
        },
      });
      expect(permission.fullTakeover).toBe(false);

      agents.sendPrompt(owner, {
        terminalId,
        backend,
        prompt: 'Inspect and fix the fixture through Workspace tools, and prove it in the shared terminal.',
      });

      const firstApproval = await waitForView(
        agents,
        owner,
        terminalId,
        (view) => view.state === 'WAITING_APPROVAL' && Boolean(view.pendingApproval),
        providerStub.state,
      );
      expect(firstApproval.pendingApproval?.command).toBe('node --version');
      agents.resolveApproval(owner, {
        terminalId,
        approvalId: firstApproval.pendingApproval!.id,
        decision: 'execute',
      });

      const secondApproval = await waitForView(
        agents,
        owner,
        terminalId,
        (view) => (
          view.state === 'WAITING_APPROVAL'
          && Boolean(view.pendingApproval)
          && view.pendingApproval?.id !== firstApproval.pendingApproval?.id
        ),
        providerStub.state,
      );
      expect(secondApproval.pendingApproval?.command).toBe(testCommand);
      agents.resolveApproval(owner, {
        terminalId,
        approvalId: secondApproval.pendingApproval!.id,
        decision: 'execute',
      });

      const completed = await waitForView(
        agents,
        owner,
        terminalId,
        (view) => view.state === 'COMPLETED',
        providerStub.state,
      );
      expect(completed.error).toBeUndefined();
      expect(completed.messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: expect.stringContaining('Spike verified'),
      });

      // File was modified on disk through the Workspace backend.
      expect(readFileSync(appPath, 'utf8')).toBe(`${MODE_ON}\n`);

      // Terminal received the commands (visible), but never the file content.
      const terminalHistory = sessions.readTerminalHistory(session.id);
      const visibleSnapshot = sent
        .filter((event) => event.channel === TERMINAL_CHANNELS.data)
        .map((event) => (event.payload as { terminalId?: string; data?: string }))
        .filter((event) => event.terminalId === terminalId)
        .map((event) => event.data ?? '')
        .join('');
      // PSReadLine syntax-highlights command input with CSI sequences. The
      // shared xterm renders those bytes as one visible command line.
      expect(terminalPlainText(terminalHistory)).toContain('node --version');
      expect(terminalHistory).toContain('SPIKE_TEST_PASS');
      expect(terminalPlainText(visibleSnapshot)).toContain('node --version');
      expect(visibleSnapshot).toContain('SPIKE_TEST_PASS');
      for (const hidden of ['cat ', 'sed ', 'grep ', 'echo ', 'Get-Content', 'Set-Content', MODE_OFF, MODE_ON]) {
        expect(terminalHistory).not.toContain(hidden);
        expect(visibleSnapshot).not.toContain(hidden);
      }

      // The harness never created its own SSH/SFTP connection.
      expect(createSshSpy).not.toHaveBeenCalled();
      expect(openSftpSpy).not.toHaveBeenCalled();

      expect(providerStub.state.errors).toEqual([]);
      expect(providerStub.state.round).toBe(5);
    } finally {
      agents?.close();
      if (terminalId) {
        try { terminals.close(owner, terminalId); } catch { /* best-effort cleanup */ }
      }
      sessions?.close();
      await closeServer(providerStub.server);
      createSshSpy.mockRestore();
      openSftpSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
