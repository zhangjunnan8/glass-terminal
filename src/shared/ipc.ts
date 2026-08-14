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
import type {
  RenameSessionRequest,
  SessionRecord,
  UpgradeSessionRequest,
} from './session';
import type {
  DownloadSelectionRequest,
  SftpDirectoryListing,
  TransferJobSnapshot,
  UploadSelectionRequest,
} from './sftp';
import type {
  ProviderConnectionResult,
  ProviderInput,
  ProviderProfile,
} from './provider';
import type {
  AgentSessionView,
  ResolveApprovalRequest,
  SendAgentPromptRequest,
} from './agent';

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
  sessions: {
    list(hostId?: string): Promise<SessionRecord[]>;
    upgrade(request: UpgradeSessionRequest): Promise<SessionRecord>;
    rename(request: RenameSessionRequest): Promise<SessionRecord>;
    readTerminalHistory(sessionId: string): Promise<string>;
  };
  sftp: {
    listDirectory(terminalId: string, path?: string): Promise<SftpDirectoryListing>;
    chooseUpload(request: UploadSelectionRequest): Promise<TransferJobSnapshot[]>;
    chooseDownload(request: DownloadSelectionRequest): Promise<TransferJobSnapshot | null>;
    listTransfers(terminalId?: string): Promise<TransferJobSnapshot[]>;
    cancelTransfer(jobId: string): Promise<TransferJobSnapshot>;
    retryTransfer(jobId: string): Promise<TransferJobSnapshot>;
    onTransferUpdated(listener: (job: TransferJobSnapshot) => void): () => void;
  };
  providers: {
    list(): Promise<ProviderProfile[]>;
    save(input: ProviderInput): Promise<ProviderProfile>;
    remove(providerId: string): Promise<void>;
    setDefault(providerId: string): Promise<ProviderProfile>;
    testConnection(providerId: string): Promise<ProviderConnectionResult>;
  };
  agent: {
    sendPrompt(request: SendAgentPromptRequest): Promise<AgentSessionView>;
    getState(terminalId: string): Promise<AgentSessionView | null>;
    resolveApproval(request: ResolveApprovalRequest): Promise<AgentSessionView>;
    onStateChanged(listener: (state: AgentSessionView) => void): () => void;
  };
}
