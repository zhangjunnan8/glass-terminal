import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { WebContents } from 'electron';
import * as pty from 'node-pty';
import type {
  CreateTerminalRequest,
  ShellProfile,
  TerminalDescriptor,
} from '../../shared/terminal';
import { TERMINAL_CHANNELS } from '../../shared/terminal';
import { discoverShells } from './shell-discovery';

interface TerminalRecord {
  process: pty.IPty;
  owner: WebContents;
  ownerId: number;
  descriptor: TerminalDescriptor;
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
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
    };
    this.terminals.set(terminalId, {
      process: processHandle,
      owner,
      ownerId: owner.id,
      descriptor,
    });

    processHandle.onData((data) => {
      if (!owner.isDestroyed()) {
        owner.send(TERMINAL_CHANNELS.data, { terminalId, data });
      }
    });
    processHandle.onExit(({ exitCode, signal }) => {
      this.terminals.delete(terminalId);
      if (!owner.isDestroyed()) {
        owner.send(TERMINAL_CHANNELS.exit, { terminalId, exitCode, signal });
      }
    });

    return descriptor;
  }

  write(owner: WebContents, terminalId: string, data: string): void {
    const record = this.requireOwned(owner, terminalId);
    record.process.write(data);
  }

  resize(owner: WebContents, terminalId: string, cols: number, rows: number): void {
    const record = this.requireOwned(owner, terminalId);
    record.process.resize(Math.max(2, cols), Math.max(1, rows));
  }

  close(owner: WebContents, terminalId: string): void {
    const record = this.requireOwned(owner, terminalId);
    this.terminals.delete(terminalId);
    record.process.kill();
  }

  closeOwnedBy(ownerId: number): void {
    for (const [terminalId, record] of this.terminals) {
      if (record.ownerId === ownerId) {
        this.terminals.delete(terminalId);
        record.process.kill();
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
}
