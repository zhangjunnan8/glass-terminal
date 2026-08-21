import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { WebContents } from 'electron';
import * as pty from 'node-pty';
import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig, PseudoTtyOptions, SFTPWrapper } from 'ssh2';
import type { HostProfile, SshConnectRequest } from '../../shared/host';
import { SSH_ERROR_CODES } from '../../shared/host';
import type { TerminalJournalEvent } from '../../shared/session';
import type { CommandActor, CommandExecution, TerminalInputMode } from '../../shared/agent';
import type {
  CreateTerminalRequest,
  ShellProfile,
  TerminalDescriptor,
} from '../../shared/terminal';
import { TERMINAL_CHANNELS } from '../../shared/terminal';
import { discoverShells } from './shell-discovery';
import {
  buildCommandEnvelope,
  CommandDisplayFilter,
  EnvelopeEchoFilter,
  SentinelCapture,
} from './structured-command';
import { TerminalInteractionDetector } from './interaction-detector';

interface TerminalBackend {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface TerminalRecord {
  backend?: TerminalBackend;
  owner: WebContents;
  ownerId: number;
  descriptor: TerminalDescriptor;
  attached: boolean;
  pendingOutput: string[];
  pendingOutputLength: number;
  status: 'connected' | 'exited';
  envelopeEchoFilter: EnvelopeEchoFilter;
  startedAt: string;
  sequence: number;
  journal: TerminalJournalEvent[];
  journalBytes: number;
  droppedJournalBytes: number;
  sessionId?: string;
  sshClient?: Client;
  activeExecution?: ActiveExecution;
  controlLease?: {
    id: string;
    inputMode: Exclude<TerminalInputMode, 'human'>;
  };
  sensitiveLease?: {
    id: string;
    executionId: string;
    submitted: boolean;
    claimed: boolean;
  };
  sensitiveJournalRedacted: boolean;
}

interface ActiveExecution {
  execution: CommandExecution;
  capture: SentinelCapture;
  displayFilter: CommandDisplayFilter;
  interactionDetector: TerminalInteractionDetector;
  outputBytes: number;
  hooks: StructuredExecutionHooks;
  resolve: (execution: CommandExecution) => void;
  timeout?: NodeJS.Timeout;
  sensitiveTainted: boolean;
  sensitiveOutputRedacted: boolean;
  interruptRequested: boolean;
}

export interface StructuredExecutionHooks {
  onOutput?: (data: string) => void;
  onStarted?: (execution: CommandExecution) => void;
  onIdleTimeout?: (execution: CommandExecution) => void;
  onAuthPrompt?: (execution: CommandExecution) => void;
  onConfirmation?: (
    answer: 'y' | 'n',
    execution: CommandExecution,
  ) => boolean;
}

const MAX_PENDING_OUTPUT = 256 * 1024;
const MAX_TEMPORARY_JOURNAL = 8 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;
const COMMAND_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1_000;

export interface TerminalSnapshot {
  descriptor: TerminalDescriptor;
  startedAt: string;
  history: TerminalJournalEvent[];
  preludeTruncated: boolean;
  droppedPreludeBytes: number;
}

type JournalListener = (
  terminalId: string,
  sessionId: string,
  event: TerminalJournalEvent,
) => void;
type ExitListener = (terminalId: string, ownerId: number) => void;
type SensitiveSubmissionListener = (
  terminalId: string,
  ownerId: number,
  executionId: string,
  leaseId: string,
) => void;

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function fingerprintsMatch(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length
    && timingSafeEqual(expectedBytes, actualBytes);
}

export class TerminalService {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly journalListeners = new Set<JournalListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private readonly sensitiveSubmissionListeners = new Set<SensitiveSubmissionListener>();
  listShells(): ShellProfile[] {
    return discoverShells();
  }

  create(owner: WebContents, request: CreateTerminalRequest): TerminalDescriptor {
    const profile = this.listShells().find((item) => item.id === request.profileId);
    if (!profile) throw new Error(`Unknown shell profile: ${request.profileId}`);

    const terminalId = randomUUID();
    const processHandle = pty.spawn(profile.command, profile.args, {
      name: 'xterm-256color',
      cols: Math.max(2, request.cols ?? 80),
      rows: Math.max(1, request.rows ?? 24),
      cwd: homedir(),
      env: stringEnvironment(),
      useConpty: process.platform === 'win32',
      useConptyDll: process.platform === 'win32',
    });
    const descriptor: TerminalDescriptor = {
      id: terminalId,
      title: profile.label,
      profileId: profile.id,
      shellKind: profile.kind,
      transport: 'local',
    };
    const backend: TerminalBackend = {
      write: (data) => processHandle.write(data),
      resize: (cols, rows) => processHandle.resize(cols, rows),
      close: () => processHandle.kill(),
    };
    this.register(owner, descriptor, backend);

    processHandle.onData((data) => this.emitData(terminalId, data));
    processHandle.onExit(({ exitCode, signal }) => {
      this.emitExit(terminalId, exitCode, signal);
    });
    return descriptor;
  }

  createSsh(
    owner: WebContents,
    host: HostProfile,
    request: SshConnectRequest,
  ): Promise<{ descriptor: TerminalDescriptor; fingerprint: string }> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const terminalId = randomUUID();
      let observedFingerprint = '';
      let settled = false;
      let exitCode = 0;
      let authTimeout: ReturnType<typeof setTimeout> | undefined;
      const banners: string[] = [];

      const fail = (error: Error) => {
        if (authTimeout) clearTimeout(authTimeout);
        if (settled) {
          this.emitData(terminalId, `\r\n\x1b[31m[SSH error: ${error.message}]\x1b[0m\r\n`);
          this.emitExit(terminalId, 255);
          return;
        }
        settled = true;
        if (!host.hostKeyFingerprint && observedFingerprint) {
          reject(new Error(`${SSH_ERROR_CODES.hostKeyRequired}:${observedFingerprint}`));
        } else if (
          host.hostKeyFingerprint
          && observedFingerprint
          && !fingerprintsMatch(host.hostKeyFingerprint, observedFingerprint)
        ) {
          reject(new Error(
            `${SSH_ERROR_CODES.hostKeyMismatch}:${host.hostKeyFingerprint}:${observedFingerprint}`,
          ));
        } else {
          reject(new Error(`SSH connection failed: ${error.message}`));
        }
        client.end();
      };

      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        const answer = request.password ?? '';
        finish(prompts.map(() => answer));
      });
      client.on('banner', (message) => {
        banners.push(message.replaceAll('\n', '\r\n'));
      });
      client.on('error', fail);
      client.once('ready', () => {
        if (authTimeout) clearTimeout(authTimeout);
        const terminalOptions: PseudoTtyOptions = {
          term: 'xterm-256color',
          cols: Math.max(2, request.cols ?? 80),
          rows: Math.max(1, request.rows ?? 24),
          width: 0,
          height: 0,
        };
        client.shell(terminalOptions, (error, stream) => {
          if (error) {
            fail(error);
            return;
          }

          const backend = this.sshBackend(client, stream);
          const stdoutDecoder = new StringDecoder('utf8');
          const stderrDecoder = new StringDecoder('utf8');
          const descriptor: TerminalDescriptor = {
            id: terminalId,
            title: host.name,
            profileId: `ssh:${host.id}`,
            shellKind: host.shellKind ?? 'posix',
            transport: 'ssh',
            hostId: host.id,
          };
          this.register(owner, descriptor, backend, client);
          for (const banner of banners) this.emitData(terminalId, banner);
          stream.on('data', (data: Buffer) => this.emitData(terminalId, stdoutDecoder.write(data)));
          stream.stderr.on('data', (data: Buffer) => {
            this.emitData(terminalId, stderrDecoder.write(data));
          });
          stream.on('exit', (code: number | null) => {
            exitCode = typeof code === 'number' ? code : 0;
          });
          stream.once('close', () => {
            const stdoutRemainder = stdoutDecoder.end();
            const stderrRemainder = stderrDecoder.end();
            if (stdoutRemainder) this.emitData(terminalId, stdoutRemainder);
            if (stderrRemainder) this.emitData(terminalId, stderrRemainder);
            client.end();
            this.emitExit(terminalId, exitCode);
          });
          settled = true;
          resolve({ descriptor, fingerprint: observedFingerprint });
        });
      });

      authTimeout = setTimeout(() => {
        fail(new Error(
          'SSH 认证超时：服务器未在 25 秒内完成认证。'
          + '若该主机仅允许私钥连接，请将认证方式改为“私钥”并选择私钥文件。',
        ));
      }, 25_000);
      try {
        client.connect(this.sshConfig(host, request, (key) => {
          const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          observedFingerprint = `SHA256:${digest}`;
          if (host.hostKeyFingerprint) {
            return fingerprintsMatch(host.hostKeyFingerprint, observedFingerprint);
          }
          return request.trustHostKey === observedFingerprint;
        }));
      } catch (error) {
        fail(error as Error);
      }
    });
  }

  attach(owner: WebContents, terminalId: string): string {
    const record = this.requireOwned(owner, terminalId);
    const pending = record.pendingOutput.join('');
    record.pendingOutput = [];
    record.pendingOutputLength = 0;
    record.attached = true;
    return pending;
  }

  write(owner: WebContents, terminalId: string, data: string): void {
    const record = this.requireConnected(owner, terminalId);
    if (record.controlLease?.inputMode === 'locked') {
      throw new Error('Terminal input is locked while the Agent has control.');
    }
    if (record.controlLease?.inputMode === 'secure-human') {
      const newlineIndex = data.search(/[\r\n]/);
      if (newlineIndex >= 0) {
        const submitted = `${data.slice(0, newlineIndex)}\r`;
        const lease = record.sensitiveLease;
        record.controlLease.inputMode = 'locked';
        if (lease) {
          lease.submitted = true;
          if (record.activeExecution?.execution.id === lease.executionId) {
            record.activeExecution.interactionDetector.rearm();
          }
        }
        record.backend!.write(submitted);
        if (lease) {
          for (const listener of this.sensitiveSubmissionListeners) {
            listener(terminalId, record.ownerId, lease.executionId, lease.id);
          }
        }
        return;
      }
    }
    record.backend!.write(data);
  }

  resize(owner: WebContents, terminalId: string, cols: number, rows: number): void {
    const record = this.requireConnected(owner, terminalId);
    const safeCols = Math.max(2, cols);
    const safeRows = Math.max(1, rows);
    record.backend!.resize(
      safeCols,
      safeRows,
    );
    this.appendJournal(record, {
      version: 1,
      sequence: this.nextSequence(record),
      timestamp: new Date().toISOString(),
      kind: 'resize',
      cols: safeCols,
      rows: safeRows,
    });
  }

  close(owner: WebContents, terminalId: string): void {
    const record = this.requireOwned(owner, terminalId);
    if (record.status === 'connected') {
      record.backend?.close();
      this.emitExit(terminalId, 0);
    }
    this.terminals.delete(terminalId);
  }

  closeOwnedBy(ownerId: number): void {
    for (const [terminalId, record] of this.terminals) {
      if (record.ownerId === ownerId) {
        if (record.status === 'connected') {
          record.backend?.close();
          this.emitExit(terminalId, 0);
        }
        this.terminals.delete(terminalId);
      }
    }
  }

  snapshot(owner: WebContents, terminalId: string): TerminalSnapshot {
    const record = this.requireOwned(owner, terminalId);
    const gap: TerminalJournalEvent[] = record.droppedJournalBytes > 0 ? [{
      version: 1,
      sequence: 0,
      timestamp: record.startedAt,
      kind: 'gap',
      droppedBytes: record.droppedJournalBytes,
    }] : [];
    return {
      descriptor: { ...record.descriptor },
      startedAt: record.startedAt,
      history: [...gap, ...record.journal],
      preludeTruncated: record.droppedJournalBytes > 0,
      droppedPreludeBytes: record.droppedJournalBytes,
    };
  }

  descriptor(owner: WebContents, terminalId: string): TerminalDescriptor {
    return { ...this.requireOwned(owner, terminalId).descriptor };
  }

  bindSession(owner: WebContents, terminalId: string, sessionId: string): void {
    const record = this.requireOwned(owner, terminalId);
    if (record.sessionId && record.sessionId !== sessionId) {
      throw new Error('Terminal is already bound to another Session.');
    }
    record.sessionId = sessionId;
    record.descriptor.sessionId = sessionId;
    record.journal = [];
    record.journalBytes = 0;
    record.droppedJournalBytes = 0;
  }

  sessionId(owner: WebContents, terminalId: string): string | undefined {
    return this.requireOwned(owner, terminalId).sessionId;
  }

  onJournal(listener: JournalListener): () => void {
    this.journalListeners.add(listener);
    return () => this.journalListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onSensitiveSubmission(listener: SensitiveSubmissionListener): () => void {
    this.sensitiveSubmissionListeners.add(listener);
    return () => this.sensitiveSubmissionListeners.delete(listener);
  }

  executeStructured(
    owner: WebContents,
    terminalId: string,
    command: string,
    actor: CommandActor,
    hooks: StructuredExecutionHooks = {},
  ): Promise<CommandExecution> {
    const record = this.requireConnected(owner, terminalId);
    if (!record.sessionId) throw new Error('A formal Session is required before AI execution.');
    if (record.activeExecution) throw new Error('Another AI command is already running.');
    const normalizedCommand = command.trim();
    if (!normalizedCommand) throw new Error('Command cannot be empty.');
    if (Buffer.byteLength(normalizedCommand, 'utf8') > 32 * 1024) {
      throw new Error('Command exceeds the 32 KiB safety limit.');
    }
    const now = new Date().toISOString();
    const execution: CommandExecution = {
      id: randomUUID(),
      sessionId: record.sessionId,
      terminalId,
      actor,
      command: normalizedCommand,
      requestedAt: now,
      startedAt: now,
      status: 'running',
      output: '',
    };
    const nonce = randomUUID().replaceAll('-', '');
    const envelope = buildCommandEnvelope(record.descriptor.shellKind, normalizedCommand, nonce);
    record.envelopeEchoFilter.remember(envelope.input);
    return new Promise((resolve) => {
      record.activeExecution = {
        execution,
        capture: new SentinelCapture(envelope),
        displayFilter: new CommandDisplayFilter(
          envelope,
          normalizedCommand,
          record.descriptor.shellKind,
        ),
        interactionDetector: new TerminalInteractionDetector(),
        outputBytes: 0,
        hooks,
        resolve,
        sensitiveTainted: false,
        sensitiveOutputRedacted: false,
        interruptRequested: false,
      };
      this.armExecutionInactivityWatchdog(record);
      hooks.onStarted?.({ ...execution });
      try {
        record.backend!.write(envelope.input);
      } catch (error) {
        this.finishExecution(
          record,
          'failed',
          undefined,
          `\r\n[Unable to write command: ${(error as Error).message}]\r\n`,
        );
      }
    });
  }

  interruptExecution(
    owner: WebContents,
    terminalId: string,
    executionId: string,
  ): CommandExecution | undefined {
    const record = this.requireOwned(owner, terminalId);
    if (
      record.activeExecution?.execution.id !== executionId
      || record.activeExecution.interruptRequested
    ) return undefined;
    const active = record.activeExecution;
    active.interruptRequested = true;
    active.execution.interruptRequestedAt = new Date().toISOString();
    if (active.timeout) {
      clearTimeout(active.timeout);
      active.timeout = undefined;
    }
    try {
      record.backend?.write('\x03');
    } catch (error) {
      active.interruptRequested = false;
      active.execution.interruptRequestedAt = undefined;
      this.armExecutionInactivityWatchdog(record);
      throw new Error(
        `Unable to send Ctrl+C; the terminal was kept connected: ${(error as Error).message}`,
      );
    }
    return { ...record.activeExecution.execution };
  }

  confirmShellReady(
    owner: WebContents,
    terminalId: string,
    executionId: string,
  ): CommandExecution | undefined {
    const record = this.requireOwned(owner, terminalId);
    const active = record.activeExecution;
    if (
      active?.execution.id !== executionId
      || !active.interruptRequested
    ) return undefined;
    this.finishExecution(
      record,
      'cancelled',
      undefined,
      '\r\n[User confirmed that the shell prompt is ready after Ctrl+C.]\r\n',
    );
    return {
      ...active.execution,
      output: active.execution.output,
    };
  }

  keepExecution(owner: WebContents, terminalId: string, executionId: string): boolean {
    const active = this.requireOwned(owner, terminalId).activeExecution;
    if (active?.execution.id !== executionId) return false;
    if (active.timeout) {
      clearTimeout(active.timeout);
      active.timeout = undefined;
    }
    return true;
  }

  currentExecution(owner: WebContents, terminalId: string): CommandExecution | undefined {
    const execution = this.requireOwned(owner, terminalId).activeExecution?.execution;
    return execution ? { ...execution } : undefined;
  }

  state(owner: WebContents, terminalId: string): Record<string, unknown> {
    const record = this.requireOwned(owner, terminalId);
    return {
      terminalId,
      sessionId: record.sessionId,
      transport: record.descriptor.transport,
      shellKind: record.descriptor.shellKind,
      profileId: record.descriptor.profileId,
      hostId: record.descriptor.hostId,
      status: record.status,
      activeExecutionId: record.activeExecution?.execution.id,
      terminalInputMode: record.controlLease?.inputMode ?? 'human',
    };
  }

  acquireAgentControl(owner: WebContents, terminalId: string): string {
    const record = this.requireConnected(owner, terminalId);
    if (record.controlLease) throw new Error('Terminal control is already leased.');
    const leaseId = randomUUID();
    record.controlLease = { id: leaseId, inputMode: 'locked' };
    return leaseId;
  }

  setAgentControlMode(
    owner: WebContents,
    terminalId: string,
    leaseId: string,
    inputMode: Exclude<TerminalInputMode, 'human'>,
  ): void {
    const record = this.requireOwned(owner, terminalId);
    if (record.controlLease?.id !== leaseId) {
      throw new Error('Agent control lease is no longer active.');
    }
    record.controlLease.inputMode = inputMode;
  }

  releaseAgentControl(owner: WebContents, terminalId: string, leaseId: string): boolean {
    const record = this.terminals.get(terminalId);
    if (!record) return false;
    if (record.ownerId !== owner.id) throw new Error('Terminal ownership mismatch.');
    if (record.controlLease?.id !== leaseId) return false;
    record.controlLease = undefined;
    return true;
  }

  beginSensitiveMode(
    owner: WebContents,
    terminalId: string,
    executionId: string,
  ): string {
    const record = this.requireOwned(owner, terminalId);
    const active = record.activeExecution;
    if (active?.execution.id !== executionId) {
      throw new Error('Sensitive input requires the active command execution.');
    }
    return this.taintSensitiveExecution(record, active, true);
  }

  endSensitiveMode(owner: WebContents, terminalId: string, leaseId: string): boolean {
    const record = this.terminals.get(terminalId);
    if (!record) return false;
    if (record.ownerId !== owner.id) throw new Error('Terminal ownership mismatch.');
    if (record.sensitiveLease?.id !== leaseId) return false;
    record.sensitiveLease = undefined;
    record.sensitiveJournalRedacted = false;
    return true;
  }

  rearmAuthPrompt(
    owner: WebContents,
    terminalId: string,
    executionId: string,
  ): void {
    const active = this.requireOwned(owner, terminalId).activeExecution;
    if (active?.execution.id !== executionId) {
      throw new Error('Authentication interaction is no longer active.');
    }
    active.interactionDetector.rearm();
  }

  consumeSensitiveSubmission(
    owner: WebContents,
    terminalId: string,
    executionId: string,
    leaseId: string,
  ): boolean {
    const record = this.requireOwned(owner, terminalId);
    const lease = record.sensitiveLease;
    if (
      !lease
      || lease.id !== leaseId
      || lease.executionId !== executionId
      || !lease.submitted
    ) {
      return false;
    }
    lease.submitted = false;
    return true;
  }

  hasSensitiveSubmission(
    owner: WebContents,
    terminalId: string,
    executionId: string,
    leaseId: string,
  ): boolean {
    const lease = this.requireOwned(owner, terminalId).sensitiveLease;
    return Boolean(
      lease
      && lease.id === leaseId
      && lease.executionId === executionId
      && lease.submitted,
    );
  }

  openSftp(owner: WebContents, terminalId: string): Promise<SFTPWrapper> {
    const record = this.requireConnected(owner, terminalId);
    if (!record.sshClient) throw new Error('SFTP requires a connected SSH terminal.');
    return new Promise((resolve, reject) => {
      record.sshClient!.sftp((error, sftp) => {
        if (error) reject(new Error(`Unable to open SFTP: ${error.message}`));
        else resolve(sftp);
      });
    });
  }

  private register(
    owner: WebContents,
    descriptor: TerminalDescriptor,
    backend: TerminalBackend,
    sshClient?: Client,
  ): void {
    this.terminals.set(descriptor.id, {
      backend,
      owner,
      ownerId: owner.id,
      descriptor,
      attached: false,
      pendingOutput: [],
      pendingOutputLength: 0,
      status: 'connected',
      envelopeEchoFilter: new EnvelopeEchoFilter(),
      startedAt: new Date().toISOString(),
      sequence: 0,
      journal: [],
      journalBytes: 0,
      droppedJournalBytes: 0,
      sshClient,
      sensitiveJournalRedacted: false,
    });
  }

  private emitData(terminalId: string, data: string): void {
    const record = this.terminals.get(terminalId);
    if (!record || record.status === 'exited') return;
    if (!data) return;
    const executionAtChunkStart = record.activeExecution;
    this.processExecutionOutput(record, data);
    if (record.sensitiveLease || executionAtChunkStart?.sensitiveTainted) {
      if (!record.sensitiveJournalRedacted) {
        record.sensitiveJournalRedacted = true;
        this.appendJournal(record, {
          version: 1,
          sequence: this.nextSequence(record),
          timestamp: new Date().toISOString(),
          kind: 'output',
          data: '\r\n[Sensitive interaction hidden]\r\n',
        });
      }
    } else {
      this.appendJournal(record, {
        version: 1,
        sequence: this.nextSequence(record),
        timestamp: new Date().toISOString(),
        kind: 'output',
        data,
      });
    }
    // The journal keeps the raw stream; only the renderer-visible copy strips
    // the structured-command envelope and sentinels.
    const filtered = executionAtChunkStart?.displayFilter?.push(data) ?? data;
    const displayData = record.envelopeEchoFilter.push(filtered);
    if (!record.attached) {
      record.pendingOutput.push(displayData);
      record.pendingOutputLength += displayData.length;
      while (record.pendingOutputLength > MAX_PENDING_OUTPUT && record.pendingOutput.length > 1) {
        record.pendingOutputLength -= record.pendingOutput.shift()!.length;
      }
      return;
    }
    if (!record.owner.isDestroyed()) {
      record.owner.send(TERMINAL_CHANNELS.data, { terminalId, data: displayData });
    }
  }

  private emitExit(terminalId: string, exitCode: number, signal?: number): void {
    const record = this.terminals.get(terminalId);
    if (!record || record.status === 'exited') return;
    record.status = 'exited';
    record.envelopeEchoFilter.clear();
    record.backend = undefined;
    if (record.activeExecution) {
      this.finishExecution(
        record,
        record.activeExecution.interruptRequested ? 'cancelled' : 'failed',
        exitCode,
        '\r\n[Terminal exited before the command sentinel completed.]\r\n',
      );
    }
    for (const listener of this.exitListeners) {
      try {
        listener(terminalId, record.ownerId);
      } catch (error) {
        console.error('Terminal exit listener failed:', error);
      }
    }
    try {
      this.appendJournal(record, {
        version: 1,
        sequence: this.nextSequence(record),
        timestamp: new Date().toISOString(),
        kind: 'exit',
        exitCode,
        signal,
      });
    } catch (error) {
      console.error('Unable to persist terminal exit:', error);
    }
    if (!record.owner.isDestroyed()) {
      try {
        record.owner.send(TERMINAL_CHANNELS.exit, { terminalId, exitCode, signal });
      } catch (error) {
        console.error('Unable to notify renderer of terminal exit:', error);
      }
    }
  }

  private requireOwned(owner: WebContents, terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (!record || record.ownerId !== owner.id) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    return record;
  }

  private requireConnected(owner: WebContents, terminalId: string): TerminalRecord {
    const record = this.requireOwned(owner, terminalId);
    if (record.status !== 'connected' || !record.backend) {
      throw new Error('Terminal is no longer connected.');
    }
    return record;
  }

  private nextSequence(record: TerminalRecord): number {
    record.sequence += 1;
    return record.sequence;
  }

  private appendJournal(record: TerminalRecord, event: TerminalJournalEvent): void {
    if (record.sessionId) {
      for (const listener of this.journalListeners) {
        listener(record.descriptor.id, record.sessionId, event);
      }
      return;
    }
    const eventBytes = event.kind === 'output'
      ? Buffer.byteLength(event.data, 'utf8')
      : Buffer.byteLength(JSON.stringify(event), 'utf8');
    record.journal.push(event);
    record.journalBytes += eventBytes;
    while (record.journalBytes > MAX_TEMPORARY_JOURNAL && record.journal.length > 1) {
      const dropped = record.journal.shift()!;
      const droppedBytes = dropped.kind === 'output'
        ? Buffer.byteLength(dropped.data, 'utf8')
        : Buffer.byteLength(JSON.stringify(dropped), 'utf8');
      record.journalBytes -= droppedBytes;
      record.droppedJournalBytes += droppedBytes;
    }
  }

  private processExecutionOutput(record: TerminalRecord, data: string): void {
    const active = record.activeExecution;
    if (!active) return;
    this.armExecutionInactivityWatchdog(record);
    const update = active.capture.push(data);
    const interaction = active.interactionDetector.push(update.observed);
    if (interaction?.kind === 'authentication') {
      this.taintSensitiveExecution(record, active, false);
      active.hooks.onAuthPrompt?.({ ...active.execution });
    } else if (interaction?.kind === 'confirmation') {
      const shouldAnswer = active.hooks.onConfirmation?.(
        interaction.answer,
        { ...active.execution },
      ) ?? false;
      if (shouldAnswer && record.activeExecution?.execution.id === active.execution.id) {
        record.backend?.write(`${interaction.answer}\r`);
        active.interactionDetector.rearm();
      }
    }
    for (const chunk of update.output) {
      if (active.sensitiveTainted) {
        if (!active.sensitiveOutputRedacted) {
          active.sensitiveOutputRedacted = true;
          this.appendExecutionOutput(active, '\r\n[Sensitive interaction hidden]\r\n');
        }
      } else {
        this.appendExecutionOutput(active, chunk);
        active.hooks.onOutput?.(chunk);
      }
    }
    if (update.completed) {
      this.finishExecution(
        record,
        active.interruptRequested
          ? 'cancelled'
          : update.exitCode === 0 ? 'completed' : 'failed',
        update.exitCode,
      );
    }
  }

  private appendExecutionOutput(active: ActiveExecution, data: string): void {
    if (!data || active.outputBytes >= MAX_COMMAND_OUTPUT) return;
    const remaining = MAX_COMMAND_OUTPUT - active.outputBytes;
    const bytes = Buffer.from(data, 'utf8');
    if (bytes.length <= remaining) {
      active.execution.output += data;
      active.outputBytes += bytes.length;
      return;
    }
    active.execution.output += `${bytes.subarray(0, remaining).toString('utf8')}\r\n[Output truncated]\r\n`;
    active.outputBytes = MAX_COMMAND_OUTPUT;
  }

  private finishExecution(
    record: TerminalRecord,
    status: CommandExecution['status'],
    exitCode?: number,
    extraOutput?: string,
  ): void {
    const active = record.activeExecution;
    if (!active) return;
    if (active.timeout) clearTimeout(active.timeout);
    if (extraOutput) this.appendExecutionOutput(active, extraOutput);
    const endedAt = new Date();
    active.execution.status = status;
    active.execution.exitCode = exitCode;
    active.execution.endedAt = endedAt.toISOString();
    active.execution.durationMs = Math.max(
      0,
      endedAt.getTime() - Date.parse(active.execution.startedAt),
    );
    if (
      record.sensitiveLease?.executionId === active.execution.id
      && !record.sensitiveLease.claimed
    ) {
      record.sensitiveLease = undefined;
      record.sensitiveJournalRedacted = false;
    }
    record.activeExecution = undefined;
    active.resolve({ ...active.execution });
  }

  private armExecutionInactivityWatchdog(record: TerminalRecord): void {
    const active = record.activeExecution;
    if (!active || active.execution.inactivityTimedOutAt) return;
    if (active.timeout) clearTimeout(active.timeout);
    const executionId = active.execution.id;
    const timeout = setTimeout(() => {
      const current = record.activeExecution;
      if (current?.execution.id !== executionId) return;
      current.timeout = undefined;
      current.execution.inactivityTimedOutAt = new Date().toISOString();
      try {
        current.hooks.onIdleTimeout?.({ ...current.execution });
      } catch (error) {
        console.error('Unable to pause Agent after command inactivity:', error);
      }
    }, COMMAND_INACTIVITY_TIMEOUT_MS);
    timeout.unref();
    active.timeout = timeout;
  }

  private taintSensitiveExecution(
    record: TerminalRecord,
    active: ActiveExecution,
    claimed: boolean,
  ): string {
    if (record.sensitiveLease) {
      if (record.sensitiveLease.executionId !== active.execution.id) {
        throw new Error('Another sensitive interaction is already active.');
      }
    } else {
      record.sensitiveLease = {
        id: randomUUID(),
        executionId: active.execution.id,
        submitted: false,
        claimed,
      };
    }
    if (claimed) record.sensitiveLease.claimed = true;
    if (!active.sensitiveTainted) {
      record.sensitiveJournalRedacted = false;
      active.sensitiveTainted = true;
      active.execution.output = '';
      active.execution.outputRedacted = true;
      active.outputBytes = 0;
      this.appendExecutionOutput(active, '\r\n[Sensitive interaction hidden]\r\n');
      active.sensitiveOutputRedacted = true;
    }
    return record.sensitiveLease.id;
  }

  private sshBackend(client: Client, stream: ClientChannel): TerminalBackend {
    return {
      write: (data) => stream.write(data),
      resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
      close: () => {
        stream.close();
        client.end();
      },
    };
  }

  private sshConfig(
    host: HostProfile,
    request: SshConnectRequest,
    hostVerifier: (key: Buffer) => boolean,
  ): ConnectConfig {
    const config: ConnectConfig = {
      host: host.hostname,
      port: host.port,
      username: host.username,
      hostVerifier,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      readyTimeout: 15_000,
      tryKeyboard: host.authMethod === 'keyboard-interactive',
    };

    switch (host.authMethod) {
      case 'password':
        config.password = request.password;
        break;
      case 'keyboard-interactive':
        config.password = request.password;
        break;
      case 'private-key':
        config.privateKey = readFileSync(host.privateKeyPath!);
        config.passphrase = request.passphrase;
        break;
      case 'agent':
        config.agent = process.env.SSH_AUTH_SOCK
          ?? (process.platform === 'win32' ? 'pageant' : undefined);
        if (!config.agent) throw new Error('No SSH agent socket is available.');
        break;
    }
    return config;
  }
}
