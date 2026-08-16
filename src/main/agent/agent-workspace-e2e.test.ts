import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
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
import { GenericHarnessBackend } from './generic-harness-backend';
import { GenericOpenAiProvider } from './generic-provider';

const MODEL_ID = 'local-workspace-e2e';
const API_KEY = 'fake';
const SOURCE_PATH = 'src/calculator.cjs';
const STEP_INITIAL = '// STEP_MARKER: initial';
const STEP_INVESTIGATED = '// STEP_MARKER: investigated';
const BROKEN_EXPRESSION = 'return left - right;';
const FIXED_EXPRESSION = 'return left + right;';
const SOURCE_CANARY = 'SOURCE_CANARY_DO_NOT_APPEAR_IN_TERMINAL';

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
  stream?: unknown;
}

interface ProviderWorkflowState {
  chatRequests: ChatPayload[];
  errors: string[];
  round: number;
  firstSha256?: string;
  secondSha256?: string;
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
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 2 * 1024 * 1024) throw new Error('E2E Provider request exceeded 2 MiB.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function completionForTool(id: string, name: string, args: unknown): unknown {
  return {
    choices: [{
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
    }],
  };
}

function finalCompletion(content: string): unknown {
  return {
    choices: [{
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
  };
}

function lastToolResult(payload: ChatPayload, expectedCallId: string): Record<string, unknown> {
  assertCondition(Array.isArray(payload.messages), 'Provider messages must be an array.');
  const last = payload.messages.at(-1) as OpenAiMessage | undefined;
  assertCondition(last?.role === 'tool', `Round expected tool result ${expectedCallId}.`);
  assertCondition(last.tool_call_id === expectedCallId, `Unexpected tool result for ${String(last.tool_call_id)}.`);
  assertCondition(typeof last.content === 'string', 'Tool result content must be JSON text.');
  const parsed: unknown = JSON.parse(last.content);
  assertCondition(parsed !== null && typeof parsed === 'object', 'Tool result must be an object.');
  return parsed as Record<string, unknown>;
}

function nextWorkflowCompletion(
  state: ProviderWorkflowState,
  payload: ChatPayload,
  testCommand: string,
): unknown {
  assertCondition(payload.model === MODEL_ID, 'Generic Provider used the wrong model.');
  assertCondition(payload.stream === true, 'Generic Provider must request streaming semantics.');
  assertCondition(Array.isArray(payload.tools), 'Generic Provider tools must be present.');

  switch (state.round) {
    case 0:
      assertCondition(
        Array.isArray(payload.messages)
        && payload.messages.some((message) => (
          (message as OpenAiMessage).role === 'user'
          && String((message as OpenAiMessage).content).includes('Repair the local fixture')
        )),
        'First Provider round is missing the user task.',
      );
      return completionForTool('call-list', 'workspace_list', { path: '.' });
    case 1: {
      const result = lastToolResult(payload, 'call-list');
      assertCondition(result.ok === true, 'workspace_list failed.');
      assertCondition(
        Array.isArray(result.entries)
        && result.entries.some((entry) => (
          (entry as { name?: unknown }).name === 'src'
        )),
        'workspace_list did not return the seeded src directory.',
      );
      return completionForTool('call-search', 'workspace_search', {
        query: 'STEP_MARKER',
        path: 'src',
        maxResults: 10,
      });
    }
    case 2: {
      const result = lastToolResult(payload, 'call-search');
      assertCondition(result.ok === true, 'workspace_search failed.');
      assertCondition(
        Array.isArray(result.matches)
        && result.matches.some((match) => (
          String((match as { path?: unknown }).path).replaceAll('\\', '/').endsWith(SOURCE_PATH)
        )),
        'workspace_search did not find the fixture source.',
      );
      return completionForTool('call-read-initial', 'workspace_read_file', {
        path: SOURCE_PATH,
      });
    }
    case 3: {
      const result = lastToolResult(payload, 'call-read-initial');
      assertCondition(result.ok === true, 'Initial workspace_read_file failed.');
      assertCondition(typeof result.content === 'string', 'Initial file content is missing.');
      assertCondition(result.content.includes(SOURCE_CANARY), 'Initial read lost the source canary.');
      assertCondition(result.content.includes(BROKEN_EXPRESSION), 'Initial source is not broken.');
      assertCondition(typeof result.sha256 === 'string', 'Initial read SHA-256 is missing.');
      state.firstSha256 = result.sha256;
      return completionForTool('call-patch-marker', 'workspace_apply_patch', {
        path: SOURCE_PATH,
        expectedSha256: state.firstSha256,
        patches: [{ search: STEP_INITIAL, replace: STEP_INVESTIGATED }],
      });
    }
    case 4: {
      const result = lastToolResult(payload, 'call-patch-marker');
      assertCondition(result.ok === true, 'First workspace_apply_patch failed.');
      assertCondition(result.created === false, 'First patch unexpectedly created a file.');
      return completionForTool('call-test-fail', 'terminal_execute', {
        command: testCommand,
        reason: 'Run the focused deterministic test after the first patch.',
      });
    }
    case 5: {
      const result = lastToolResult(payload, 'call-test-fail');
      assertCondition(result.ok === false, 'The first terminal test unexpectedly passed.');
      assertCondition(result.command === testCommand, 'The first terminal used a different command.');
      assertCondition(result.status === 'failed', 'The first terminal test did not fail normally.');
      assertCondition(result.exitCode === 1, 'The first terminal test did not return exit code 1.');
      assertCondition(String(result.output).includes('E2E_TEST_FAIL'), 'Failure output was not visible to the harness.');
      return completionForTool('call-read-after-fail', 'workspace_read_file', {
        path: SOURCE_PATH,
      });
    }
    case 6: {
      const result = lastToolResult(payload, 'call-read-after-fail');
      assertCondition(result.ok === true, 'Second workspace_read_file failed.');
      assertCondition(typeof result.content === 'string', 'Second file content is missing.');
      assertCondition(result.content.includes(STEP_INVESTIGATED), 'First patch was not observed.');
      assertCondition(result.content.includes(BROKEN_EXPRESSION), 'Fixture passed before the actual fix.');
      assertCondition(typeof result.sha256 === 'string', 'Second read SHA-256 is missing.');
      assertCondition(result.sha256 !== state.firstSha256, 'First patch did not change the file hash.');
      state.secondSha256 = result.sha256;
      return completionForTool('call-patch-fix', 'workspace_apply_patch', {
        path: SOURCE_PATH,
        expectedSha256: state.secondSha256,
        patches: [{ search: BROKEN_EXPRESSION, replace: FIXED_EXPRESSION }],
      });
    }
    case 7: {
      const result = lastToolResult(payload, 'call-patch-fix');
      assertCondition(result.ok === true, 'Second workspace_apply_patch failed.');
      assertCondition(result.created === false, 'Second patch unexpectedly created a file.');
      return completionForTool('call-test-pass', 'terminal_execute', {
        command: testCommand,
        reason: 'Re-run the exact focused deterministic test after the fix.',
      });
    }
    case 8: {
      const result = lastToolResult(payload, 'call-test-pass');
      assertCondition(result.ok === true, 'The second terminal test did not pass.');
      assertCondition(result.command === testCommand, 'The second terminal used a different command.');
      assertCondition(result.status === 'completed', 'The second terminal test did not complete normally.');
      assertCondition(result.exitCode === 0, 'The second terminal test did not return exit code 0.');
      assertCondition(String(result.output).includes('E2E_TEST_PASS'), 'Passing output was not visible to the harness.');
      return finalCompletion('Workspace repair complete; the focused test now passes.');
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
      assertCondition(request.headers.authorization === `Bearer ${API_KEY}`, 'Provider authorization is wrong.');
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
      json(response, 200, completion);
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
  providerState?: ProviderWorkflowState,
  timeoutMs = 30_000,
): Promise<AgentSessionView> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = service.getState(owner, terminalId);
    if (view && predicate(view)) return view;
    if (view?.state === 'FAILED') {
      const providerDetail = providerState?.errors.length
        ? ` Provider stub: ${providerState.errors.join(' | ')}`
        : '';
      throw new Error(`Agent workflow failed: ${view.error ?? 'unknown error'}.${providerDetail}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('Timed out waiting for the local Agent workflow.');
}

function shellQuote(path: string, shellKind: string): string {
  if (shellKind === 'powershell') return `'${path.replaceAll("'", "''")}'`;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe('Generic Provider local Workspace E2E', () => {
  it('repairs a real local file through Workspace tools and runs only approved commands in the shared PTY', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-workspace-e2e-'));
    const workspaceRoot = join(root, 'workspace');
    const sourcePath = join(workspaceRoot, SOURCE_PATH);
    const testPath = join(workspaceRoot, 'test/calculator.test.cjs');
    mkdirSync(dirname(sourcePath), { recursive: true });
    mkdirSync(dirname(testPath), { recursive: true });
    writeFileSync(sourcePath, [
      "'use strict';",
      '',
      `const SOURCE_CANARY = '${SOURCE_CANARY}';`,
      '',
      'function add(left, right) {',
      `  ${STEP_INITIAL}`,
      '  void SOURCE_CANARY;',
      `  ${BROKEN_EXPRESSION}`,
      '}',
      '',
      'module.exports = { add };',
      '',
    ].join('\n'));
    writeFileSync(testPath, [
      "'use strict';",
      '',
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "const { add } = require('../src/calculator.cjs');",
      '',
      "test('adds two positive integers', () => {",
      '  const actual = add(2, 3);',
      "  console.log(actual === 5 ? 'E2E_TEST_PASS' : 'E2E_TEST_FAIL');",
      '  assert.equal(actual, 5);',
      '});',
      '',
    ].join('\n'));

    const terminals = new TerminalService();
    const { owner, sent } = browserOwner();
    const profiles = terminals.listShells();
    const profile = profiles.find((candidate) => candidate.kind === 'powershell')
      ?? profiles.find((candidate) => candidate.kind === 'posix');
    assertCondition(profile, 'The deterministic E2E requires PowerShell or a POSIX shell.');
    const testCommand = `node --test ${shellQuote(testPath, profile.kind)}`;
    const providerStub = await startProviderStub(testCommand);
    let sessions: SessionManager | undefined;
    let agents: AgentService | undefined;
    let terminalId: string | undefined;
    const createSpy = vi.spyOn(terminals, 'create');
    const createSshSpy = vi.spyOn(terminals, 'createSsh');
    const openSftpSpy = vi.spyOn(terminals, 'openSftp');
    const executeSpy = vi.spyOn(terminals, 'executeStructured');

    try {
      const providers = new ProviderStore(
        join(root, 'providers.json'),
        new MemorySecretStore(),
        fetch,
      );
      const provider = await providers.save({
        name: 'Local E2E Provider',
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
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));

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

      const files = new AgentFileService(
        terminals,
        sessions,
        undefined,
        localFilesystem,
      );
      agents = new AgentService(
        terminals,
        sessions,
        providers,
        (providerId) => new GenericOpenAiProvider(providerId, providers, fetch),
        undefined,
        files,
        (providerId) => new GenericHarnessBackend(
          new GenericOpenAiProvider(providerId, providers, fetch),
        ),
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
        prompt: 'Repair the local fixture with Workspace tools and prove the fix in the shared terminal.',
      });

      const firstApproval = await waitForView(
        agents,
        owner,
        terminalId,
        (view) => view.state === 'WAITING_APPROVAL' && Boolean(view.pendingApproval),
        providerStub.state,
      );
      expect(firstApproval.pendingApproval?.command).toBe(testCommand);
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
      expect(completed.fullTakeover).toBe(false);
      expect(completed.messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: 'Workspace repair complete; the focused test now passes.',
      });
      expect(completed.activities.map(({ toolName, status, label }) => ({
        toolName,
        status,
        label,
      }))).toEqual([
        { toolName: 'workspace_list', status: 'succeeded', label: 'List .' },
        { toolName: 'workspace_search', status: 'succeeded', label: 'Search workspace src' },
        { toolName: 'workspace_read_file', status: 'succeeded', label: `Read ${SOURCE_PATH}` },
        { toolName: 'workspace_apply_patch', status: 'succeeded', label: `Patch ${SOURCE_PATH}` },
        { toolName: 'terminal_execute', status: 'failed', label: 'Run terminal command' },
        { toolName: 'workspace_read_file', status: 'succeeded', label: `Read ${SOURCE_PATH}` },
        { toolName: 'workspace_apply_patch', status: 'succeeded', label: `Patch ${SOURCE_PATH}` },
        { toolName: 'terminal_execute', status: 'succeeded', label: 'Run terminal command' },
      ]);

      expect(readFileSync(sourcePath, 'utf8')).toBe([
        "'use strict';",
        '',
        `const SOURCE_CANARY = '${SOURCE_CANARY}';`,
        '',
        'function add(left, right) {',
        `  ${STEP_INVESTIGATED}`,
        '  void SOURCE_CANARY;',
        `  ${FIXED_EXPRESSION}`,
        '}',
        '',
        'module.exports = { add };',
        '',
      ].join('\n'));

      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect(executeSpy.mock.calls.map((call) => call[2])).toEqual([testCommand, testCommand]);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSshSpy).not.toHaveBeenCalled();
      expect(openSftpSpy).not.toHaveBeenCalled();
      expect(providerStub.state.round).toBe(9);
      expect(providerStub.state.chatRequests).toHaveLength(9);
      expect(providerStub.state.errors).toEqual([]);

      const terminalHistory = sessions.readTerminalHistory(session.id);
      const visibleSnapshot = sent
        .filter((event) => event.channel === TERMINAL_CHANNELS.data)
        .map((event) => (event.payload as { terminalId?: string; data?: string }))
        .filter((event) => event.terminalId === terminalId)
        .map((event) => event.data ?? '')
        .join('');
      expect(terminalHistory).toContain('E2E_TEST_FAIL');
      expect(terminalHistory).toContain('E2E_TEST_PASS');
      expect(visibleSnapshot).toContain('E2E_TEST_FAIL');
      expect(visibleSnapshot).toContain('E2E_TEST_PASS');
      expect(occurrences(terminalHistory, testCommand)).toBe(2);
      expect(occurrences(visibleSnapshot, testCommand)).toBe(2);
      for (const hidden of [
        'cat ',
        'sed ',
        'grep ',
        'echo ',
        'Get-Content',
        'Set-Content',
        SOURCE_CANARY,
        STEP_INVESTIGATED,
        FIXED_EXPRESSION,
      ]) {
        expect(terminalHistory).not.toContain(hidden);
        expect(visibleSnapshot).not.toContain(hidden);
      }

      const audit = store.readAudit(session.id);
      expect(audit.filter((event) => event.type === 'command_requested')).toHaveLength(2);
      expect(audit.filter((event) => event.type === 'command_approved')).toHaveLength(2);
      expect(audit.filter((event) => event.type === 'command_completed')).toHaveLength(2);
      expect(audit.filter((event) => event.type === 'full_takeover_changed')).toHaveLength(0);
      const commandEvents = sessions.readThreadEvents(session.id, completed.threadId)
        .filter((event) => event.type === 'command_execution');
      expect(commandEvents).toHaveLength(2);
      expect(commandEvents.map((event) => (
        (event.execution as { command?: unknown }).command
      ))).toEqual([testCommand, testCommand]);

      const records = sessions.readWorkspaceOperations(session.id);
      const intents = records.filter((record) => record.recordType === 'intent');
      const outcomes = records.filter((record) => record.recordType === 'outcome');
      expect(records).toHaveLength(12);
      expect(records.map((record) => record.recordType)).toEqual([
        'intent', 'outcome',
        'intent', 'outcome',
        'intent', 'outcome',
        'intent', 'outcome',
        'intent', 'outcome',
        'intent', 'outcome',
      ]);
      expect(intents.map((record) => record.operation)).toEqual([
        'list', 'search', 'read', 'patch', 'read', 'patch',
      ]);
      expect(intents.map((record) => record.backend)).toEqual(Array(6).fill('local'));
      expect(outcomes.map((record) => ({
        outcome: record.outcome,
        sideEffectCommitted: record.sideEffectCommitted,
      }))).toEqual([
        { outcome: 'succeeded', sideEffectCommitted: false },
        { outcome: 'succeeded', sideEffectCommitted: false },
        { outcome: 'succeeded', sideEffectCommitted: false },
        { outcome: 'succeeded', sideEffectCommitted: true },
        { outcome: 'succeeded', sideEffectCommitted: false },
        { outcome: 'succeeded', sideEffectCommitted: true },
      ]);
      const diffIntents = intents.filter((record) => record.operation === 'patch');
      expect(diffIntents).toHaveLength(2);
      expect(diffIntents.every((record) => Boolean(record.diff))).toBe(true);

      const protection = sessions.workspaceStorageProtection(session.id);
      const rawJsonl = readFileSync(protection.operationJournalPath, 'utf8');
      for (const privatePayload of [
        canonicalWorkspaceRoot,
        testCommand,
        'STEP_MARKER',
        SOURCE_CANARY,
        STEP_INVESTIGATED,
        BROKEN_EXPRESSION,
        FIXED_EXPRESSION,
        'E2E_TEST_FAIL',
        'E2E_TEST_PASS',
      ]) expect(rawJsonl).not.toContain(privatePayload);

      const diffsPath = join(dirname(protection.operationJournalPath), 'diffs');
      const diffNames = readdirSync(diffsPath).sort();
      expect(diffNames).toHaveLength(2);
      const diffBodies = diffNames.map((name) => readFileSync(join(diffsPath, name), 'utf8'));
      expect(diffBodies.some((body) => (
        body.includes(STEP_INITIAL) && body.includes(STEP_INVESTIGATED)
      ))).toBe(true);
      expect(diffBodies.some((body) => (
        body.includes(BROKEN_EXPRESSION) && body.includes(FIXED_EXPRESSION)
      ))).toBe(true);
      for (const intent of diffIntents) {
        const diff = intent.diff!;
        const artifactPath = join(diffsPath, `${diff.id}.patch`);
        const artifact = readFileSync(artifactPath);
        expect(createHash('sha256').update(artifact).digest('hex')).toBe(diff.sha256);
        expect(artifact.length).toBe(diff.bytes);
      }
      expect(relative(canonicalWorkspaceRoot, sourcePath)).toBe(join('src', 'calculator.cjs'));
    } finally {
      agents?.close();
      if (terminalId) {
        try { terminals.close(owner, terminalId); } catch { /* best-effort E2E cleanup */ }
      }
      sessions?.close();
      await closeServer(providerStub.server);
      createSpy.mockRestore();
      createSshSpy.mockRestore();
      openSftpSpy.mockRestore();
      executeSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

});
