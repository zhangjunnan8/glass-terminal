import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { WebContents } from 'electron';
import * as pty from 'node-pty';
import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig, PseudoTtyOptions } from 'ssh2';
import type { HostProfile, SshConnectRequest } from '../../shared/host';
import { SSH_ERROR_CODES } from '../../shared/host';
import type { TerminalJournalEvent } from '../../shared/session';
import type {
  CreateTerminalRequest,
  ShellProfile,
  TerminalDescriptor,
} from '../../shared/terminal';
import { TERMINAL_CHANNELS } from '../../shared/terminal';
import { discoverShells } from './shell-discovery';

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
  startedAt: string;
  sequence: number;
  journal: TerminalJournalEvent[];
  journalBytes: number;
  droppedJournalBytes: number;
  sessionId?: string;
}

const MAX_PENDING_OUTPUT = 256 * 1024;
const MAX_TEMPORARY_JOURNAL = 8 * 1024 * 1024;

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
      const banners: string[] = [];

      const fail = (error: Error) => {
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
            shellKind: 'posix',
            transport: 'ssh',
            hostId: host.id,
          };
          this.register(owner, descriptor, backend);
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

  private register(
    owner: WebContents,
    descriptor: TerminalDescriptor,
    backend: TerminalBackend,
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
      startedAt: new Date().toISOString(),
      sequence: 0,
      journal: [],
      journalBytes: 0,
      droppedJournalBytes: 0,
    });
  }

  private emitData(terminalId: string, data: string): void {
    const record = this.terminals.get(terminalId);
    if (!record) return;
    if (!data) return;
    this.appendJournal(record, {
      version: 1,
      sequence: this.nextSequence(record),
      timestamp: new Date().toISOString(),
      kind: 'output',
      data,
    });
    if (!record.attached) {
      record.pendingOutput.push(data);
      record.pendingOutputLength += data.length;
      while (record.pendingOutputLength > MAX_PENDING_OUTPUT && record.pendingOutput.length > 1) {
        record.pendingOutputLength -= record.pendingOutput.shift()!.length;
      }
      return;
    }
    if (!record.owner.isDestroyed()) {
      record.owner.send(TERMINAL_CHANNELS.data, { terminalId, data });
    }
  }

  private emitExit(terminalId: string, exitCode: number, signal?: number): void {
    const record = this.terminals.get(terminalId);
    if (!record || record.status === 'exited') return;
    record.status = 'exited';
    record.backend = undefined;
    this.appendJournal(record, {
      version: 1,
      sequence: this.nextSequence(record),
      timestamp: new Date().toISOString(),
      kind: 'exit',
      exitCode,
      signal,
    });
    if (!record.owner.isDestroyed()) {
      record.owner.send(TERMINAL_CHANNELS.exit, { terminalId, exitCode, signal });
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
