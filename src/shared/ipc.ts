import type {
  CreateHostFolderRequest,
  HostFolder,
  HostInput,
  HostProfile,
  MoveHostFolderRequest,
  MoveHostRequest,
  RenameHostFolderRequest,
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
  ClearWorkspaceRequest,
  DeleteSessionRequest,
  ReadSessionHistoryDetailRequest,
  RenameSessionRequest,
  SetWorkspaceRequest,
  SessionHistoryDetail,
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
  ProviderModelDiscoveryInput,
  ProviderModelDiscoveryResult,
  ProviderProfile,
} from './provider';
import type {
  AgentAssistantDelta,
  AgentSessionView,
  ConfirmShellReadyRequest,
  InterruptAgentTurnRequest,
  ResolveApprovalRequest,
  ResolveTakeoverRequest,
  ReviseAgentPromptRequest,
  SendAgentPromptRequest,
  SetAgentFileAccessRequest,
  SetFullTakeoverRequest,
  TakeoverRequest,
} from './agent';
import type {
  CodexAppServerSnapshot,
  SaveCodexAppServerSelectionRequest,
  SetCodexTerminalContextAccessRequest,
  SetCodexTerminalAgentEnabledRequest,
} from './codex-app-server';
import type { AppSettings, AppSettingsPatch } from './settings';
import type {
  BackupExportRequest,
  BackupExportResult,
  BackupImportResult,
} from './backup';

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
    readClipboardText(): Promise<string>;
    writeClipboardText(text: string): Promise<void>;
    onData(
      terminalId: string,
      listener: (event: TerminalDataEvent) => void,
    ): () => void;
    onExit(
      terminalId: string,
      listener: (event: TerminalExitEvent) => void,
    ): () => void;
  };
  hosts: {
    list(): Promise<HostProfile[]>;
    save(input: HostInput): Promise<HostProfile>;
    remove(hostId: string): Promise<void>;
    forgetCredential(hostId: string): Promise<void>;
    choosePrivateKeyPath(): Promise<string | null>;
    listFolders(): Promise<HostFolder[]>;
    createFolder(request: CreateHostFolderRequest): Promise<HostFolder>;
    renameFolder(request: RenameHostFolderRequest): Promise<HostFolder>;
    removeFolder(folderId: string): Promise<void>;
    moveFolder(request: MoveHostFolderRequest): Promise<HostFolder[]>;
    moveHost(request: MoveHostRequest): Promise<HostProfile>;
  };
  sessions: {
    list(hostId?: string): Promise<SessionRecord[]>;
    upgrade(request: UpgradeSessionRequest): Promise<SessionRecord>;
    setWorkspace(request: SetWorkspaceRequest): Promise<SessionRecord>;
    clearWorkspace(request: ClearWorkspaceRequest): Promise<SessionRecord>;
    chooseLocalWorkspace(request: UpgradeSessionRequest): Promise<SessionRecord | null>;
    rename(request: RenameSessionRequest): Promise<SessionRecord>;
    onRenamed(listener: (session: SessionRecord) => void): () => void;
    readTerminalHistory(sessionId: string): Promise<string>;
    readHistoryDetail(request: ReadSessionHistoryDetailRequest): Promise<SessionHistoryDetail>;
    remove(request: DeleteSessionRequest): Promise<void>;
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
    discoverModels(input: ProviderModelDiscoveryInput): Promise<ProviderModelDiscoveryResult>;
  };
  codexAppServer: {
    getState(): Promise<CodexAppServerSnapshot>;
    start(): Promise<CodexAppServerSnapshot>;
    chooseExecutable(): Promise<CodexAppServerSnapshot>;
    restart(): Promise<CodexAppServerSnapshot>;
    refresh(): Promise<CodexAppServerSnapshot>;
    loginBrowser(): Promise<CodexAppServerSnapshot>;
    loginDeviceCode(): Promise<CodexAppServerSnapshot>;
    reopenLogin(): Promise<CodexAppServerSnapshot>;
    cancelLogin(): Promise<CodexAppServerSnapshot>;
    logout(): Promise<CodexAppServerSnapshot>;
    saveSelection(
      request: SaveCodexAppServerSelectionRequest,
    ): Promise<CodexAppServerSnapshot>;
    setTerminalContextAccess(
      request: SetCodexTerminalContextAccessRequest,
    ): Promise<CodexAppServerSnapshot>;
    /** @deprecated Use setTerminalContextAccess. */
    setTerminalAgentEnabled(
      request: SetCodexTerminalAgentEnabledRequest,
    ): Promise<CodexAppServerSnapshot>;
    onStateChanged(listener: (state: CodexAppServerSnapshot) => void): () => void;
  };
  agent: {
    sendPrompt(request: SendAgentPromptRequest): Promise<AgentSessionView>;
    interruptTurn(request: InterruptAgentTurnRequest): Promise<AgentSessionView>;
    revisePrompt(request: ReviseAgentPromptRequest): Promise<AgentSessionView>;
    getState(terminalId: string): Promise<AgentSessionView | null>;
    setFileAccess(request: SetAgentFileAccessRequest): Promise<AgentSessionView>;
    resolveApproval(request: ResolveApprovalRequest): Promise<AgentSessionView>;
    setFullTakeover(request: SetFullTakeoverRequest): Promise<AgentSessionView>;
    takeover(request: TakeoverRequest): Promise<AgentSessionView>;
    resolveTakeover(request: ResolveTakeoverRequest): Promise<AgentSessionView>;
    confirmShellReady(request: ConfirmShellReadyRequest): Promise<AgentSessionView>;
    onStateChanged(listener: (state: AgentSessionView) => void): () => void;
    onAssistantDelta(listener: (event: AgentAssistantDelta) => void): () => void;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: AppSettingsPatch): Promise<AppSettings>;
    onChanged(listener: (settings: AppSettings) => void): () => void;
  };
  backup: {
    export(request: BackupExportRequest): Promise<BackupExportResult | null>;
    import(): Promise<BackupImportResult | null>;
  };
  hostBackup: {
    export(): Promise<BackupExportResult | null>;
    import(): Promise<BackupImportResult | null>;
  };
  settingsWindow: {
    open(): Promise<void>;
  };
}
