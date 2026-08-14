import type {
  HostInput,
  HostProfile,
  SshConnectRequest,
  SshConnectResult,
} from './host';
import type {
  CreateTerminalRequest,
  ShellProfile,
  TerminalDataEvent,
  TerminalDescriptor,
  TerminalExitEvent,
} from './terminal';

export interface RuntimeInfo {
  platform: NodeJS.Platform;
  arch: string;
  version: string;
}

export interface DesktopBridge {
  runtime: {
    getInfo(): Promise<RuntimeInfo>;
  };
  terminal: {
    listShells(): Promise<ShellProfile[]>;
    create(request: CreateTerminalRequest): Promise<TerminalDescriptor>;
    connectSsh(request: SshConnectRequest): Promise<SshConnectResult>;
    attach(terminalId: string): Promise<string>;
    write(terminalId: string, data: string): Promise<void>;
    resize(terminalId: string, cols: number, rows: number): Promise<void>;
    close(terminalId: string): Promise<void>;
    onData(listener: (event: TerminalDataEvent) => void): () => void;
    onExit(listener: (event: TerminalExitEvent) => void): () => void;
  };
  hosts: {
    list(): Promise<HostProfile[]>;
    save(input: HostInput): Promise<HostProfile>;
    remove(hostId: string): Promise<void>;
  };
}
