import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import type { WebContents } from 'electron';
import type { SFTPWrapper } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackendRef, AgentSessionView } from '../../shared/agent';
import type { HostProfile } from '../../shared/host';
import { SSH_ERROR_CODES } from '../../shared/host';
import type { ProviderProfile } from '../../shared/provider';
import { TERMINAL_CHANNELS } from '../../shared/terminal';
import type { TerminalDataEvent } from '../../shared/terminal';
import { SftpRemoteFilesystem } from '../filesystem/remote-filesystem';
import type { HostStore } from '../hosts/host-store';
import type { ProviderStore } from '../providers/provider-store';
import { SessionManager } from '../sessions/session-manager';
import { SessionStore } from '../sessions/session-store';
import { TerminalService } from '../terminal/terminal-service';
import type {
  AgentCompletion,
  AgentCompletionRequest,
  AgentProviderRuntime,
} from './agent-loop';
import { AgentService } from './agent-service';

const enabled = Boolean(
  process.env.AI_TERMINAL_SSH_TEST_HOST
  && process.env.AI_TERMINAL_SSH_TEST_USER
  && process.env.AI_TERMINAL_SSH_TEST_PASSWORD,
);

const INITIAL_SETTINGS = 'color=gren\ncount=1\n';
const FIRST_PATCH_SETTINGS = 'color=green\ncount=1\n';
const FINAL_SETTINGS = 'color=green\ncount=2\n';
const TEST_SCRIPT = `#!/bin/sh
. ./settings.env
if [ "$color" = "green" ] && [ "$count" = "2" ]; then
  printf 'AI_WORKSPACE_TEST_PASS\\n'
  exit 0
fi
printf 'AI_WORKSPACE_TEST_FAIL\\n'
exit 1
`;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): AgentCompletion {
  return {
    message: {
      role: 'assistant',
      content: null,
      toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    },
  };
}

class SshWorkspaceWorkflowProvider implements AgentProviderRuntime {
  readonly requests: AgentCompletionRequest[] = [];
  readonly results: Array<Record<string, unknown>> = [];
  private round = 0;

  constructor(private readonly testCommand: string) {}

  async complete(request: AgentCompletionRequest): Promise<AgentCompletion> {
    this.requests.push(request);
    const latest = request.messages.at(-1);
    if (latest?.role === 'tool') {
      this.results.push(JSON.parse(latest.content) as Record<string, unknown>);
    }

    const completion = (() => {
      switch (this.round) {
        case 0:
          return toolCall('ssh-list', 'workspace_list', { path: '.' });
        case 1:
          return toolCall('ssh-search', 'workspace_search', {
            query: 'gren',
            path: '.',
            maxResults: 20,
          });
        case 2:
          return toolCall('ssh-read-before', 'workspace_read_file', {
            path: 'settings.env',
          });
        case 3:
          return toolCall('ssh-patch-color', 'workspace_apply_patch', {
            path: 'settings.env',
            expectedSha256: sha256(INITIAL_SETTINGS),
            patches: [{ search: 'color=gren', replace: 'color=green' }],
          });
        case 4:
          return toolCall('ssh-test-fail', 'terminal_execute', {
            command: this.testCommand,
            reason: 'Run the project test after the first focused patch.',
          });
        case 5:
          return toolCall('ssh-read-after-failure', 'workspace_read_file', {
            path: 'settings.env',
          });
        case 6:
          return toolCall('ssh-patch-count', 'workspace_apply_patch', {
            path: 'settings.env',
            expectedSha256: sha256(FIRST_PATCH_SETTINGS),
            patches: [{ search: 'count=1', replace: 'count=2' }],
          });
        case 7:
          return toolCall('ssh-test-pass', 'terminal_execute', {
            command: this.testCommand,
            reason: 'Re-run the exact same project test after the second patch.',
          });
        case 8:
          return { message: { role: 'assistant' as const, content: 'Remote workspace fixed.' } };
        default:
          throw new Error('The SSH workflow Provider received an unexpected extra round.');
      }
    })();
    this.round += 1;
    return completion;
  }
}

function readyProvider(): ProviderProfile {
  return {
    id: 'ssh-e2e-provider',
    name: 'SSH E2E Provider',
    kind: 'generic-openai-compatible',
    baseUrl: 'https://ssh-e2e.invalid/v1',
    modelId: 'deterministic-workflow',
    recipientRevision: 'ssh-e2e-recipient',
    apiKeyConfigured: true,
    isDefault: true,
    status: 'ready',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function providerStore(profile: ProviderProfile): ProviderStore {
  return {
    get: (id: string) => {
      if (id !== profile.id) throw new Error(`Provider not found: ${id}`);
      return profile;
    },
    list: () => [profile],
  } as unknown as ProviderStore;
}

function terminalIds(service: TerminalService): string[] {
  return [...(service as unknown as {
    terminals: Map<string, unknown>;
  }).terminals.keys()];
}

async function waitForAgentState(
  service: AgentService,
  owner: WebContents,
  terminalId: string,
  predicate: (view: AgentSessionView) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<AgentSessionView> {
  const deadline = Date.now() + timeoutMs;
  let latest: AgentSessionView | null = null;
  while (Date.now() < deadline) {
    latest = service.getState(owner, terminalId);
    if (latest && predicate(latest)) return latest;
    if (latest?.state === 'FAILED') {
      throw new Error(`Agent failed while waiting for ${label}: ${latest.error ?? 'unknown error'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for ${label}; latest Agent state was ${latest?.state ?? 'missing'}.`,
  );
}

async function closeRemoteFixture(
  terminals: TerminalService,
  owner: WebContents,
  terminalId: string,
  remoteRoot: string,
): Promise<void> {
  const sftp = await terminals.openSftp(owner, terminalId);
  const filesystem = new SftpRemoteFilesystem(sftp);
  try {
    await filesystem.unlink(posix.join(remoteRoot, 'settings.env')).catch(() => undefined);
    await filesystem.unlink(posix.join(remoteRoot, 'test.sh')).catch(() => undefined);
    await filesystem.rmdir(remoteRoot).catch(() => undefined);
  } finally {
    sftp.end();
  }
}

describe.runIf(enabled)('real SSH/SFTP Agent workspace workflow', () => {
  it('uses one visible SSH PTY and bounded SFTP leases for the complete repair loop', async () => {
    const localSessionRoot = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-ssh-e2e-'));
    const terminals = new TerminalService();
    const createSsh = vi.spyOn(terminals, 'createSsh');
    const openSftp = vi.spyOn(terminals, 'openSftp');
    const terminalOutput: string[] = [];
    const owner = {
      id: 7_003,
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        if (channel === TERMINAL_CHANNELS.data) {
          terminalOutput.push((payload as TerminalDataEvent).data);
        }
      },
    } as unknown as WebContents;
    const host: HostProfile = {
      id: 'agent-ssh-integration-host',
      protocol: 'ssh',
      name: 'Agent SSH integration target',
      hostname: process.env.AI_TERMINAL_SSH_TEST_HOST!,
      port: Number(process.env.AI_TERMINAL_SSH_TEST_PORT ?? 22),
      username: process.env.AI_TERMINAL_SSH_TEST_USER!,
      authMethod: 'password',
      sortOrder: 0,
      favorite: false,
      fullTakeover: false,
      credentialConfigured: false,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const password = process.env.AI_TERMINAL_SSH_TEST_PASSWORD;
    const store = new SessionStore(localSessionRoot);
    const sessions = new SessionManager(
      store,
      terminals,
      { get: (hostId: string) => {
        if (hostId !== host.id) throw new Error(`Host not found: ${hostId}`);
        return host;
      } } as unknown as HostStore,
    );
    const profile = readyProvider();
    const backend: AgentBackendRef = { kind: 'generic-provider', providerId: profile.id };
    let agent: AgentService | undefined;
    let terminalId: string | undefined;
    let remoteRoot: string | undefined;
    let remoteCreated = false;

    try {
      let challenge = '';
      try {
        await terminals.createSsh(owner, host, { hostId: host.id, password });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain(SSH_ERROR_CODES.hostKeyRequired);
        challenge = message.slice(message.indexOf('SHA256:')).trim();
      }
      expect(challenge).toMatch(/^SHA256:/);

      const connected = await terminals.createSsh(owner, host, {
        hostId: host.id,
        password,
        trustHostKey: challenge,
        cols: 100,
        rows: 30,
      });
      terminalId = connected.descriptor.id;
      terminalOutput.push(terminals.attach(owner, terminalId));
      expect(createSsh).toHaveBeenCalledTimes(2);
      expect(terminalIds(terminals)).toEqual([terminalId]);

      const session = sessions.upgrade(owner, terminalId);
      const seedSftp: SFTPWrapper = await terminals.openSftp(owner, terminalId);
      try {
        const filesystem = new SftpRemoteFilesystem(seedSftp);
        const remoteHome = await filesystem.realpath('.');
        remoteRoot = posix.join(remoteHome, `.ai-terminal-agent-e2e-${randomUUID()}`);
        await filesystem.mkdir(remoteRoot, 0o700);
        remoteCreated = true;
        await filesystem.writeFile(
          posix.join(remoteRoot, 'settings.env'),
          Buffer.from(INITIAL_SETTINGS),
          0o600,
          true,
        );
        await filesystem.writeFile(
          posix.join(remoteRoot, 'test.sh'),
          Buffer.from(TEST_SCRIPT),
          0o700,
          true,
        );
      } finally {
        seedSftp.end();
      }

      const workspaceSession = await sessions.setWorkspace(owner, {
        terminalId,
        root: remoteRoot,
      });
      const testCommand = `cd ${quotePosix(remoteRoot)} && sh ./test.sh`;
      const workflowProvider = new SshWorkspaceWorkflowProvider(testCommand);
      agent = new AgentService(
        terminals,
        sessions,
        providerStore(profile),
        () => workflowProvider,
      );
      await agent.setFileAccess(owner, {
        terminalId,
        mode: 'read-write',
        backend,
        expectedWorkspaceRoot: workspaceSession.workspace?.root,
      });

      const boundSession = sessions.sessionForTerminal(owner, terminalId)!;
      expect(terminals.descriptor(owner, terminalId)).toMatchObject({
        id: terminalId,
        transport: 'ssh',
        hostId: host.id,
        sessionId: session.id,
      });
      expect(boundSession).toMatchObject({
        id: session.id,
        runtimeTerminalId: terminalId,
        transport: 'ssh',
        hostId: host.id,
        workspace: {
          backend: 'sftp',
          root: remoteRoot,
          hostId: host.id,
        },
      });

      const sftpCallsBeforeAgent = openSftp.mock.calls.length;
      agent.sendPrompt(owner, {
        terminalId,
        prompt: 'Repair the remote settings and prove the same project test changes from failing to passing.',
        backend,
      });

      const firstApproval = await waitForAgentState(
        agent,
        owner,
        terminalId,
        (view) => view.state === 'WAITING_APPROVAL',
        'the first command approval',
      );
      expect(firstApproval.fullTakeover).toBe(false);
      agent.resolveApproval(owner, {
        terminalId,
        approvalId: firstApproval.pendingApproval!.id,
        decision: 'execute',
      });

      const secondApproval = await waitForAgentState(
        agent,
        owner,
        terminalId,
        (view) => view.state === 'WAITING_APPROVAL'
          && view.pendingApproval?.id !== firstApproval.pendingApproval?.id,
        'the second command approval',
      );
      expect(secondApproval.pendingApproval?.command).toBe(testCommand);
      agent.resolveApproval(owner, {
        terminalId,
        approvalId: secondApproval.pendingApproval!.id,
        decision: 'execute',
      });

      const completed = await waitForAgentState(
        agent,
        owner,
        terminalId,
        (view) => view.state === 'COMPLETED',
        'Agent completion',
      );
      expect(completed).toMatchObject({
        terminalId,
        sessionId: session.id,
        fullTakeover: false,
        terminalInputMode: 'human',
        fileAccessMode: 'read-write',
      });
      expect(completed.messages.at(-1)?.content).toBe('Remote workspace fixed.');
      expect(completed.activities.map(({ toolName, kind, status }) => ({
        toolName,
        kind,
        status,
      }))).toEqual([
        { toolName: 'workspace_list', kind: 'workspace', status: 'succeeded' },
        { toolName: 'workspace_search', kind: 'workspace', status: 'succeeded' },
        { toolName: 'workspace_read_file', kind: 'workspace', status: 'succeeded' },
        { toolName: 'workspace_apply_patch', kind: 'workspace', status: 'succeeded' },
        { toolName: 'terminal_execute', kind: 'terminal', status: 'failed' },
        { toolName: 'workspace_read_file', kind: 'workspace', status: 'succeeded' },
        { toolName: 'workspace_apply_patch', kind: 'workspace', status: 'succeeded' },
        { toolName: 'terminal_execute', kind: 'terminal', status: 'succeeded' },
      ]);

      expect(workflowProvider.requests).toHaveLength(9);
      expect(workflowProvider.requests[0]!.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'terminal_execute',
          'workspace_list',
          'workspace_search',
          'workspace_read_file',
          'workspace_apply_patch',
        ]),
      );
      expect(workflowProvider.results).toHaveLength(8);
      expect(workflowProvider.results[0]).toMatchObject({ ok: true, truncated: false });
      expect(workflowProvider.results[1]).toMatchObject({
        ok: true,
        filesScanned: 2,
        truncated: false,
      });
      expect(workflowProvider.results[2]).toMatchObject({
        ok: true,
        content: INITIAL_SETTINGS,
        sha256: sha256(INITIAL_SETTINGS),
      });
      expect(workflowProvider.results[3]).toMatchObject({
        ok: true,
        sha256: sha256(FIRST_PATCH_SETTINGS),
        created: false,
      });
      expect(workflowProvider.results[4]).toMatchObject({
        ok: false,
        command: testCommand,
        status: 'failed',
        exitCode: 1,
      });
      expect(String(workflowProvider.results[4]!.output)).toContain('AI_WORKSPACE_TEST_FAIL');
      expect(workflowProvider.results[5]).toMatchObject({
        ok: true,
        content: FIRST_PATCH_SETTINGS,
        sha256: sha256(FIRST_PATCH_SETTINGS),
      });
      expect(workflowProvider.results[6]).toMatchObject({
        ok: true,
        sha256: sha256(FINAL_SETTINGS),
        created: false,
      });
      expect(workflowProvider.results[7]).toMatchObject({
        ok: true,
        command: testCommand,
        status: 'completed',
        exitCode: 0,
      });
      expect(String(workflowProvider.results[7]!.output)).toContain('AI_WORKSPACE_TEST_PASS');

      // One lease per high-level Workspace call: list/search/read/patch/read/patch.
      const agentSftpCalls = openSftp.mock.calls.slice(sftpCallsBeforeAgent);
      expect(agentSftpCalls).toHaveLength(6);
      expect(agentSftpCalls.every(([callOwner, callTerminalId]) => (
        callOwner === owner && callTerminalId === terminalId
      ))).toBe(true);
      expect(createSsh).toHaveBeenCalledTimes(2);
      expect(terminalIds(terminals)).toEqual([terminalId]);

      const audits = store.readAudit(session.id);
      expect(audits.filter((event) => event.type === 'command_requested')).toHaveLength(2);
      expect(audits.filter((event) => event.type === 'command_approved')).toHaveLength(2);
      const commandOutcomes = audits.filter((event) => event.type === 'command_completed');
      expect(commandOutcomes.map((event) => event.details.status)).toEqual([
        'failed',
        'completed',
      ]);
      expect(commandOutcomes.map((event) => event.details.exitCode)).toEqual([1, 0]);
      expect(new Set(audits
        .filter((event) => event.type === 'command_requested')
        .map((event) => event.details.command))).toEqual(new Set([testCommand]));

      const workspaceRecords = sessions.readWorkspaceOperations(session.id);
      expect(workspaceRecords).toHaveLength(12);
      const intents = workspaceRecords.filter((record) => record.recordType === 'intent');
      const outcomes = workspaceRecords.filter((record) => record.recordType === 'outcome');
      expect(intents.map((record) => record.operation)).toEqual([
        'list',
        'search',
        'read',
        'patch',
        'read',
        'patch',
      ]);
      expect(intents.every((record) => (
        record.backend === 'sftp'
        && record.actor === 'ai'
        && record.source === 'agent_file_service'
      ))).toBe(true);
      expect(outcomes.every((record) => (
        record.outcome === 'succeeded'
        && record.sideEffectCommitted === (record.sequence === 8 || record.sequence === 12)
      ))).toBe(true);
      expect(sessions.recoverWorkspaceOperations(session.id).every((item) => (
        item.outcome !== null
      ))).toBe(true);

      const journalPath = sessions.workspaceStorageProtection(session.id).operationJournalPath;
      const rawJournal = readFileSync(journalPath, 'utf8');
      expect(rawJournal).not.toContain('gren');
      expect(rawJournal).not.toContain('green');
      expect(rawJournal).not.toContain('count=1');
      expect(rawJournal).not.toContain('count=2');
      expect(rawJournal).not.toContain(remoteRoot);
      expect(rawJournal).not.toContain(host.hostname);
      const diffDirectory = join(dirname(journalPath), 'diffs');
      const diffFiles = readdirSync(diffDirectory).filter((name) => name.endsWith('.patch'));
      expect(diffFiles).toHaveLength(2);
      const diffBodies = diffFiles.map((name) => readFileSync(join(diffDirectory, name), 'utf8'));
      expect(diffBodies.join('\n')).toContain('color=gren');
      expect(diffBodies.join('\n')).toContain('color=green');
      expect(diffBodies.join('\n')).toContain('count=1');
      expect(diffBodies.join('\n')).toContain('count=2');

      const visibleHistory = sessions.readTerminalHistory(session.id);
      expect(visibleHistory.split(testCommand)).toHaveLength(3);
      expect(visibleHistory).toContain('AI_WORKSPACE_TEST_FAIL');
      expect(visibleHistory).toContain('AI_WORKSPACE_TEST_PASS');
      expect(visibleHistory).not.toContain('settings.env');
      expect(visibleHistory).not.toContain('color=gren');
      expect(visibleHistory).not.toContain('count=1');
      expect(visibleHistory).not.toMatch(/\b(?:cat|sed|grep|echo)\b/u);
      expect(visibleHistory).not.toContain('Get-Content');
      expect(visibleHistory).not.toContain('Set-Content');
      expect(terminalOutput.join('')).toContain('AI_WORKSPACE_TEST_PASS');

      const verifySftp = await terminals.openSftp(owner, terminalId);
      try {
        const filesystem = new SftpRemoteFilesystem(verifySftp);
        expect((await filesystem.readFile(
          posix.join(remoteRoot, 'settings.env'),
        )).toString('utf8')).toBe(FINAL_SETTINGS);
      } finally {
        verifySftp.end();
      }
    } finally {
      if (terminalId && remoteRoot && remoteCreated) {
        try {
          await closeRemoteFixture(terminals, owner, terminalId, remoteRoot);
          remoteCreated = false;
        } catch {
          // The generated path is unique; a connection loss is the only expected cleanup blocker.
        }
      }
      agent?.close();
      if (terminalId) {
        try { terminals.close(owner, terminalId); } catch { /* already disconnected */ }
      }
      sessions.close();
      rmSync(localSessionRoot, { recursive: true, force: true });
    }
  }, 90_000);
});
