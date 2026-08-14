import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { WebContents } from 'electron';
import * as pty from 'node-pty';
import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig, PseudoTtyOptions } from 'ssh2';
import type { HostProfile, SshConnectRequest } from '../../shared/host';
import { SSH_ERROR_CODES } from '../../shared/host';
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
  backend: TerminalBackend;
  owner: WebContents;
  ownerId: number;
  descriptor: TerminalDescriptor;
  attached: boolean;
  pendingOutput: string[];
  pendingOutputLength: number;
}

const MAX_PENDING_OUTPUT = 256 * 1024;

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
        this.emitData(terminalId, message.replaceAll('\n', '\r\n'));
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
          const descriptor: TerminalDescriptor = {
            id: terminalId,
            title: host.name,
            profileId: `ssh:${host.id}`,
            shellKind: 'posix',
            transport: 'ssh',
            hostId: host.id,
          };
          this.register(owner, descriptor, backend);
          stream.on('data', (data: Buffer) => this.emitData(terminalId, data.toString('utf8')));
          stream.stderr.on('data', (data: Buffer) => {
            this.emitData(terminalId, data.toString('utf8'));
          });
          stream.on('exit', (code: number | null) => {
            exitCode = typeof code === 'number' ? code : 0;
          });
          stream.once('close', () => {
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
    this.requireOwned(owner, terminalId).backend.write(data);
  }

  resize(owner: WebContents, terminalId: string, cols: number, rows: number): void {
    this.requireOwned(owner, terminalId).backend.resize(
      Math.max(2, cols),
      Math.max(1, rows),
    );
  }

  close(owner: WebContents, terminalId: string): void {
    const record = this.requireOwned(owner, terminalId);
    this.terminals.delete(terminalId);
    record.backend.close();
  }

  closeOwnedBy(ownerId: number): void {
    for (const [terminalId, record] of this.terminals) {
      if (record.ownerId === ownerId) {
        this.terminals.delete(terminalId);
        record.backend.close();
      }
    }
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
    });
  }

  private emitData(terminalId: string, data: string): void {
    const record = this.terminals.get(terminalId);
    if (!record) return;
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
    if (!record) return;
    this.terminals.delete(terminalId);
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
