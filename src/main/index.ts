import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRODUCT_NAME } from '../shared/product';
import { HOST_CHANNELS } from '../shared/host';
import type {
  CreateHostFolderRequest,
  HostInput,
  MoveHostFolderRequest,
  MoveHostRequest,
  RenameHostFolderRequest,
  SshConnectRequest,
} from '../shared/host';
import { TERMINAL_CHANNELS } from '../shared/terminal';
import type { CreateTerminalRequest } from '../shared/terminal';
import { SESSION_CHANNELS } from '../shared/session';
import type {
  ClearWorkspaceRequest,
  DeleteSessionRequest,
  ReadSessionHistoryDetailRequest,
  RenameSessionRequest,
  SetWorkspaceRequest,
  UpgradeSessionRequest,
} from '../shared/session';
import { SFTP_CHANNELS } from '../shared/sftp';
import type { DownloadSelectionRequest, UploadSelectionRequest } from '../shared/sftp';
import { PROVIDER_CHANNELS } from '../shared/provider';
import type { ProviderInput, ProviderModelDiscoveryInput } from '../shared/provider';
import { SETTINGS_CHANNELS, SETTINGS_WINDOW_CHANNELS } from '../shared/settings';
import type { AppSettingsPatch } from '../shared/settings';
import { BACKUP_CHANNELS, HOST_BACKUP_CHANNELS } from '../shared/backup';
import type {
  BackupExportRequest,
  BackupExportResult,
  BackupImportResult,
} from '../shared/backup';
import { AGENT_CHANNELS } from '../shared/agent';
import type {
  ConfirmShellReadyRequest,
  InterruptAgentTurnRequest,
  ResolveApprovalRequest,
  ResolveTakeoverRequest,
  ReviseAgentPromptRequest,
  SendAgentPromptRequest,
  SetAgentFileAccessRequest,
  SetFullTakeoverRequest,
  TakeoverRequest,
} from '../shared/agent';
import { CODEX_APP_SERVER_CHANNELS } from '../shared/codex-app-server';
import type {
  SaveCodexAppServerSelectionRequest,
  SetCodexTerminalContextAccessRequest,
  SetCodexTerminalAgentEnabledRequest,
} from '../shared/codex-app-server';
import { HostStore } from './hosts/host-store';
import { HostCredentialStore } from './hosts/host-credential-store';
import { HostService } from './hosts/host-service';
import { SessionManager } from './sessions/session-manager';
import { SessionStore } from './sessions/session-store';
import { SftpService } from './sftp/sftp-service';
import { TransferQueue } from './sftp/transfer-queue';
import { ProviderStore } from './providers/provider-store';
import { MemorySecretStore } from './providers/secret-store';
import { FileSecretStore } from './providers/file-secret-store';
import { AppSettingsStore } from './settings/app-settings-store';
import { BackupService } from './backup/backup-service';
import { HostBackupService } from './backup/host-backup-service';
import { AgentService } from './agent/agent-service';
import { AgentFileService } from './agent/agent-file-service';
import { startAgentSmokeProvider } from './smoke/agent-provider-server';
import type { AgentSmokeProvider } from './smoke/agent-provider-server';
import { registerSmokeRunner, smokeModeFromEnvironment } from './smoke/smoke-runner';
import { TerminalService } from './terminal/terminal-service';
import { RemoteFilesystemProvider } from './filesystem/remote-filesystem';
import { CodexAppServerService } from './app-server/app-server-service';
import {
  isTrustedRendererUrl,
  resolveDevelopmentRendererUrl,
} from './security/renderer-trust';
import { acquireSingleInstance } from './single-instance';

const developmentRendererUrl = resolveDevelopmentRendererUrl(
  process.env.VITE_DEV_SERVER_URL,
  app.isPackaged,
);
const isDevelopment = Boolean(developmentRendererUrl);
const rendererEntryUrl = developmentRendererUrl?.href ?? pathToFileURL(
  join(__dirname, '..', 'dist', 'index.html'),
).toString();
const settingsEntryUrl = developmentRendererUrl
  ? new URL('settings.html', developmentRendererUrl).href
  : pathToFileURL(join(__dirname, '..', 'dist', 'settings.html')).toString();
const smokeMode = smokeModeFromEnvironment();
const isSmokeTest = smokeMode !== null;
const terminalService = new TerminalService();
const remoteFilesystemProvider = new RemoteFilesystemProvider(terminalService);
const sftpService = new SftpService(remoteFilesystemProvider);
const transferQueue = new TransferQueue(terminalService);
let hostStore: HostStore | undefined;
let hostService: HostService | undefined;
let sessionManager: SessionManager | undefined;
let providerStore: ProviderStore | undefined;
let agentService: AgentService | undefined;
let codexAppServerService: CodexAppServerService | undefined;
let agentSmokeProvider: AgentSmokeProvider | undefined;
let appSettingsStore: AppSettingsStore | undefined;
let backupService: BackupService | undefined;
let hostBackupService: HostBackupService | undefined;
let settingsWindow: BrowserWindow | null = null;
const trustedRendererContents = new Set<number>();
const ownsSingleInstance = acquireSingleInstance(
  app,
  () => BrowserWindow.getAllWindows(),
);

if (isSmokeTest) {
  app.setPath('userData', join(process.cwd(), '.smoke-data', smokeMode!));
} else {
  // Keep the user-data directory stable across product renames so existing
  // hosts, providers, secrets and sessions are not orphaned.
  app.setPath('userData', join(app.getPath('appData'), 'ai-terminal'));
}

function requireHostStore(): HostStore {
  if (!hostStore) throw new Error('Host store is not ready.');
  return hostStore;
}

function requireHostService(): HostService {
  if (!hostService) throw new Error('Host service is not ready.');
  return hostService;
}

function requireSessionManager(): SessionManager {
  if (!sessionManager) throw new Error('Session manager is not ready.');
  return sessionManager;
}

function requireProviderStore(): ProviderStore {
  if (!providerStore) throw new Error('Provider store is not ready.');
  return providerStore;
}

function requireCodexAppServerService(): CodexAppServerService {
  if (!codexAppServerService) throw new Error('Codex App Server service is not ready.');
  return codexAppServerService;
}

function requireAgentService(): AgentService {
  if (!agentService) throw new Error('Agent service is not ready.');
  return agentService;
}

function requireAppSettingsStore(): AppSettingsStore {
  if (!appSettingsStore) throw new Error('App settings store is not ready.');
  return appSettingsStore;
}

function requireBackupService(): BackupService {
  if (!backupService) throw new Error('Backup service is not ready.');
  return backupService;
}

function requireHostBackupService(): HostBackupService {
  if (!hostBackupService) throw new Error('Host backup service is not ready.');
  return hostBackupService;
}

function isTrustedEntryUrl(url: string): boolean {
  return isTrustedRendererUrl(url, rendererEntryUrl, isDevelopment)
    || isTrustedRendererUrl(url, settingsEntryUrl, isDevelopment);
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (
    !trustedRendererContents.has(event.sender.id)
    || event.sender.isDestroyed()
    || event.senderFrame !== event.sender.mainFrame
    || !isTrustedEntryUrl(event.senderFrame.url)
  ) throw new Error('拒绝来自非受信页面的应用请求。');
}

function handleTrusted(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return listener(event, ...args);
  });
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b1018',
    title: PRODUCT_NAME,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => {
    if (!isSmokeTest) window.show();
  });

  if (isSmokeTest) {
    registerSmokeRunner(window, smokeMode!);
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedEntryUrl(url)) event.preventDefault();
  });

  const contents = window.webContents;
  const contentsId = contents.id;
  trustedRendererContents.add(contentsId);
  contents.once('destroyed', () => {
    trustedRendererContents.delete(contentsId);
    agentService?.closeOwnedBy(contentsId);
    terminalService.closeOwnedBy(contentsId);
  });

  void window.loadURL(rendererEntryUrl);

  return window;
}

function showSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: '#0b1018',
    title: `${PRODUCT_NAME} — 设置`,
    parent: BrowserWindow.getAllWindows()[0],
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  settingsWindow.once('ready-to-show', () => {
    if (!isSmokeTest) settingsWindow?.show();
  });
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  settingsWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedEntryUrl(url)) event.preventDefault();
  });

  const contents = settingsWindow.webContents;
  const contentsId = contents.id;
  trustedRendererContents.add(contentsId);
  contents.once('destroyed', () => {
    trustedRendererContents.delete(contentsId);
    agentService?.closeOwnedBy(contentsId);
    terminalService.closeOwnedBy(contentsId);
  });
  settingsWindow.once('closed', () => {
    settingsWindow = null;
  });

  void settingsWindow.loadURL(settingsEntryUrl);
}

handleTrusted('runtime:get-info', () => ({
  platform: process.platform,
  arch: process.arch,
  version: app.getVersion(),
}));

handleTrusted(SETTINGS_CHANNELS.get, () => requireAppSettingsStore().get());
handleTrusted(SETTINGS_CHANNELS.update, (_event, patch: AppSettingsPatch) => {
  const updated = requireAppSettingsStore().update(patch);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      try {
        window.webContents.send(SETTINGS_CHANNELS.changed, updated);
      } catch {
        // A concurrently closing window must not starve other windows of updates.
      }
    }
  }
  return updated;
});
handleTrusted(SETTINGS_WINDOW_CHANNELS.open, () => {
  showSettingsWindow();
});
handleTrusted(BACKUP_CHANNELS.export, async (event, request: BackupExportRequest) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!ownerWindow) throw new Error('无法打开导出窗口。');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const selection = await dialog.showSaveDialog(ownerWindow, {
    title: '导出 Glass Terminal 配置',
    defaultPath: join(app.getPath('documents'), `glass-terminal-backup-${stamp}.aitbak`),
    filters: [{ name: 'Glass Terminal 备份', extensions: ['aitbak'] }],
  });
  if (selection.canceled || !selection.filePath) return null;
  return requireBackupService().exportToFile(selection.filePath, request.includeLogs === true);
});
handleTrusted(BACKUP_CHANNELS.import, async (event) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!ownerWindow) throw new Error('无法打开导入窗口。');
  const selection = await dialog.showOpenDialog(ownerWindow, {
    title: '导入 Glass Terminal 配置',
    properties: ['openFile'],
    filters: [{ name: 'Glass Terminal 备份', extensions: ['aitbak'] }],
  });
  if (selection.canceled || !selection.filePaths[0]) return null;
  return requireBackupService().importFromFile(selection.filePaths[0]);
});
handleTrusted(HOST_BACKUP_CHANNELS.export, async (event) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!ownerWindow) throw new Error('无法打开主机导出窗口。');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const selection = await dialog.showSaveDialog(ownerWindow, {
    title: '导出 SSH 主机配置',
    defaultPath: join(app.getPath('documents'), `glass-terminal-hosts-${stamp}.aithosts`),
    filters: [{ name: 'Glass Terminal 主机备份', extensions: ['aithosts', 'json'] }],
  });
  if (selection.canceled || !selection.filePath) return null;
  return requireHostBackupService().exportToFile(selection.filePath);
});
handleTrusted(HOST_BACKUP_CHANNELS.import, async (event) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!ownerWindow) throw new Error('无法打开主机导入窗口。');
  const selection = await dialog.showOpenDialog(ownerWindow, {
    title: '导入 SSH 主机配置',
    properties: ['openFile'],
    filters: [{ name: 'Glass Terminal 主机备份', extensions: ['aithosts', 'json'] }],
  });
  if (selection.canceled || !selection.filePaths[0]) return null;
  return requireHostBackupService().importFromFile(selection.filePaths[0]);
});

handleTrusted(TERMINAL_CHANNELS.listShells, () => terminalService.listShells());
handleTrusted(
  TERMINAL_CHANNELS.create,
  (event, request: CreateTerminalRequest) => terminalService.create(event.sender, request),
);
handleTrusted(TERMINAL_CHANNELS.attach, (event, terminalId: string) => (
  terminalService.attach(event.sender, terminalId)
));
handleTrusted(
  TERMINAL_CHANNELS.write,
  (event, terminalId: string, data: string) => {
    terminalService.write(event.sender, terminalId, data);
  },
);
handleTrusted(
  TERMINAL_CHANNELS.resize,
  (event, terminalId: string, cols: number, rows: number) => {
    terminalService.resize(event.sender, terminalId, cols, rows);
  },
);
handleTrusted(TERMINAL_CHANNELS.close, (event, terminalId: string) => {
  transferQueue.cancelByTerminal(terminalId, event.sender.id);
  agentService?.closeTerminal(event.sender, terminalId);
  terminalService.close(event.sender, terminalId);
});
handleTrusted(TERMINAL_CHANNELS.readClipboardText, () => {
  const text = clipboard.readText();
  if (Buffer.byteLength(text, 'utf8') > 8 * 1024 * 1024) {
    throw new Error('粘贴内容超过 8 MiB 限制。');
  }
  return text;
});
handleTrusted(TERMINAL_CHANNELS.writeClipboardText, (_event, text: unknown) => {
  if (typeof text !== 'string') throw new Error('剪贴板内容必须是文本。');
  if (Buffer.byteLength(text, 'utf8') > 8 * 1024 * 1024) {
    throw new Error('复制内容超过 8 MiB 限制。');
  }
  clipboard.writeText(text);
});

handleTrusted(HOST_CHANNELS.list, () => requireHostService().list());
handleTrusted(HOST_CHANNELS.save, (_event, input: HostInput) => (
  requireHostService().save(input)
));
handleTrusted(HOST_CHANNELS.remove, (_event, hostId: string) => (
  requireHostService().remove(hostId)
));
handleTrusted(HOST_CHANNELS.forgetCredential, (_event, hostId: string) => (
  requireHostService().forgetCredential(hostId)
));
handleTrusted(HOST_CHANNELS.choosePrivateKeyPath, async (event) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!ownerWindow) throw new Error('无法打开私钥文件选择窗口。');
  const selection = await dialog.showOpenDialog(ownerWindow, {
    title: '选择 SSH 私钥文件',
    properties: ['openFile'],
    filters: [
      { name: 'SSH 私钥', extensions: ['pem', 'key', 'ppk', '*'] },
    ],
  });
  if (selection.canceled || !selection.filePaths[0]) return null;
  return selection.filePaths[0];
});
handleTrusted(HOST_CHANNELS.listFolders, () => requireHostService().listFolders());
handleTrusted(
  HOST_CHANNELS.createFolder,
  (_event, request: CreateHostFolderRequest) => requireHostService().createFolder(request),
);
handleTrusted(
  HOST_CHANNELS.renameFolder,
  (_event, request: RenameHostFolderRequest) => requireHostService().renameFolder(request),
);
handleTrusted(
  HOST_CHANNELS.removeFolder,
  (_event, folderId: string) => requireHostService().removeFolder(folderId),
);
handleTrusted(
  HOST_CHANNELS.moveFolder,
  (_event, request: MoveHostFolderRequest) => requireHostService().moveFolder(request),
);
handleTrusted(
  HOST_CHANNELS.moveHost,
  (_event, request: MoveHostRequest) => requireHostService().moveHost(request),
);
handleTrusted(HOST_CHANNELS.connect, (event, request: SshConnectRequest) => (
  requireHostService().connect(event.sender, request)
));

handleTrusted(SESSION_CHANNELS.list, (_event, hostId?: string) => (
  requireSessionManager().list(hostId)
));
handleTrusted(
  SESSION_CHANNELS.upgrade,
  (event, request: UpgradeSessionRequest) => (
    requireSessionManager().upgrade(event.sender, request.terminalId)
  ),
);
handleTrusted(
  SESSION_CHANNELS.setWorkspace,
  (event, request: SetWorkspaceRequest) => {
    const service = requireAgentService();
    const beforeCommit = () => (
      service.assertWorkspaceChangeAllowed(event.sender, request.terminalId)
    );
    beforeCommit();
    const descriptor = terminalService.descriptor(event.sender, request.terminalId);
    if (descriptor.transport !== 'ssh') {
      throw new Error('Local workspace roots must be selected with the system folder picker.');
    }
    return requireSessionManager().setWorkspace(event.sender, request, beforeCommit);
  },
);
handleTrusted(
  SESSION_CHANNELS.clearWorkspace,
  (event, request: ClearWorkspaceRequest) => {
    requireAgentService().assertWorkspaceChangeAllowed(event.sender, request.terminalId);
    return requireSessionManager().clearWorkspace(event.sender, request);
  },
);
handleTrusted(
  SESSION_CHANNELS.chooseLocalWorkspace,
  async (event, request: UpgradeSessionRequest) => {
    const service = requireAgentService();
    service.assertWorkspaceChangeAllowed(event.sender, request.terminalId);
    const descriptor = terminalService.descriptor(event.sender, request.terminalId);
    if (descriptor.transport !== 'local') {
      throw new Error('The system folder picker is only available for local terminals.');
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow) throw new Error('Unable to open the workspace folder picker.');
    const selection = await dialog.showOpenDialog(ownerWindow, {
      title: '选择 Workspace 根目录',
      properties: ['openDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    // The Agent may have started, entered a draining state, or enabled file
    // tools while the native folder picker was open.
    service.assertWorkspaceChangeAllowed(event.sender, request.terminalId);
    return requireSessionManager().setWorkspace(event.sender, {
      terminalId: request.terminalId,
      root: selection.filePaths[0],
    }, () => service.assertWorkspaceChangeAllowed(event.sender, request.terminalId));
  },
);

handleTrusted(
  SFTP_CHANNELS.listDirectory,
  (event, terminalId: string, path?: string) => (
    sftpService.listDirectory(event.sender, terminalId, path)
  ),
);
handleTrusted(
  SFTP_CHANNELS.chooseUpload,
  async (event, request: UploadSelectionRequest) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow) throw new Error('无法打开上传窗口。');
    const selection = await dialog.showOpenDialog(ownerWindow, {
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections'],
    });
    if (selection.canceled) return [];
    return selection.filePaths.map((localPath) => transferQueue.enqueueUpload(
      event.sender,
      request.terminalId,
      localPath,
      request.remoteDirectory,
    ));
  },
);
handleTrusted(
  SFTP_CHANNELS.chooseDownload,
  async (event, request: DownloadSelectionRequest) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow) throw new Error('无法打开下载窗口。');
    const safeName = request.suggestedName
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '') || 'download';
    const selection = await dialog.showSaveDialog(ownerWindow, {
      title: '保存下载文件',
      defaultPath: join(app.getPath('downloads'), safeName),
    });
    if (selection.canceled || !selection.filePath) return null;
    return transferQueue.enqueueDownload(
      event.sender,
      request.terminalId,
      request.remotePath,
      selection.filePath,
    );
  },
);
handleTrusted(SFTP_CHANNELS.listTransfers, (event, terminalId?: string) => (
  transferQueue.list(event.sender, terminalId)
));
handleTrusted(SFTP_CHANNELS.cancelTransfer, (event, jobId: string) => (
  transferQueue.cancel(event.sender, jobId)
));
handleTrusted(SFTP_CHANNELS.retryTransfer, (event, jobId: string) => (
  transferQueue.retry(event.sender, jobId)
));
handleTrusted(PROVIDER_CHANNELS.list, () => requireProviderStore().list());
handleTrusted(PROVIDER_CHANNELS.save, (_event, input: ProviderInput) => (
  requireProviderStore().save(input)
));
handleTrusted(PROVIDER_CHANNELS.remove, (_event, providerId: string) => (
  requireProviderStore().remove(providerId)
));
handleTrusted(PROVIDER_CHANNELS.setDefault, (_event, providerId: string) => (
  requireProviderStore().setDefault(providerId)
));
handleTrusted(PROVIDER_CHANNELS.testConnection, (_event, providerId: string) => (
  requireProviderStore().testConnection(providerId)
));
handleTrusted(PROVIDER_CHANNELS.discoverModels, (
  _event,
  input: ProviderModelDiscoveryInput,
) => requireProviderStore().discoverModels(input));
handleTrusted(CODEX_APP_SERVER_CHANNELS.getState, () => (
  requireCodexAppServerService().getState()
));
handleTrusted(CODEX_APP_SERVER_CHANNELS.start, () => (
  requireCodexAppServerService().start()
));
handleTrusted(CODEX_APP_SERVER_CHANNELS.chooseExecutable, async (event) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!ownerWindow) throw new Error('无法打开 Codex CLI 选择窗口。');
  const selection = await dialog.showOpenDialog(ownerWindow, {
    title: '选择 Codex CLI 可执行文件',
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Codex CLI', extensions: ['exe'] }]
      : [{ name: 'Codex CLI', extensions: ['*'] }],
  });
  if (selection.canceled || !selection.filePaths[0]) {
    return requireCodexAppServerService().getState();
  }
  return requireCodexAppServerService().configureExecutableAndStart(
    selection.filePaths[0],
  );
});
handleTrusted(CODEX_APP_SERVER_CHANNELS.restart, async () => {
  const state = await requireCodexAppServerService().restart();
  agentService?.handleCodexAppServerRestarted();
  return state;
});
handleTrusted(CODEX_APP_SERVER_CHANNELS.refresh, () => (
  requireCodexAppServerService().refresh()
));
handleTrusted(CODEX_APP_SERVER_CHANNELS.loginBrowser, () => (
  requireCodexAppServerService().loginBrowser()
));
handleTrusted(CODEX_APP_SERVER_CHANNELS.loginDeviceCode, () => (
  requireCodexAppServerService().loginDeviceCode()
));
handleTrusted(CODEX_APP_SERVER_CHANNELS.reopenLogin, () => (
  requireCodexAppServerService().openPendingLogin()
));
handleTrusted(CODEX_APP_SERVER_CHANNELS.cancelLogin, () => (
  requireCodexAppServerService().cancelLogin()
));
handleTrusted(CODEX_APP_SERVER_CHANNELS.logout, () => (
  requireCodexAppServerService().logout()
));
handleTrusted(
  CODEX_APP_SERVER_CHANNELS.saveSelection,
  (_event, request: SaveCodexAppServerSelectionRequest) => (
    requireCodexAppServerService().saveSelection(request)
  ),
);
handleTrusted(
  CODEX_APP_SERVER_CHANNELS.setTerminalContextAccess,
  (_event, request: SetCodexTerminalContextAccessRequest) => (
    requireCodexAppServerService().setTerminalContextAccess(request)
  ),
);
handleTrusted(
  CODEX_APP_SERVER_CHANNELS.setTerminalAgentEnabled,
  (_event, request: SetCodexTerminalAgentEnabledRequest) => (
    requireCodexAppServerService().setTerminalAgentEnabled(request)
  ),
);
handleTrusted(AGENT_CHANNELS.sendPrompt, (event, request: SendAgentPromptRequest) => {
  if (!agentService) throw new Error('Agent service is not ready.');
  return agentService.sendPrompt(event.sender, request);
});
handleTrusted(AGENT_CHANNELS.interruptTurn, (event, request: InterruptAgentTurnRequest) => {
  if (!agentService) throw new Error('Agent service is not ready.');
  return agentService.interruptTurn(event.sender, request);
});
handleTrusted(AGENT_CHANNELS.revisePrompt, (event, request: ReviseAgentPromptRequest) => {
  if (!agentService) throw new Error('Agent service is not ready.');
  return agentService.revisePrompt(event.sender, request);
});
handleTrusted(AGENT_CHANNELS.getState, (event, terminalId: string) => {
  if (!agentService) throw new Error('Agent service is not ready.');
  return agentService.getState(event.sender, terminalId);
});
handleTrusted(AGENT_CHANNELS.setFileAccess, (event, request: SetAgentFileAccessRequest) => {
  if (!agentService) throw new Error('Agent service is not ready.');
  return agentService.setFileAccess(event.sender, request);
});
handleTrusted(
  AGENT_CHANNELS.resolveApproval,
  (event, request: ResolveApprovalRequest) => {
    if (!agentService) throw new Error('Agent service is not ready.');
    return agentService.resolveApproval(event.sender, request);
  },
);
handleTrusted(
  AGENT_CHANNELS.setFullTakeover,
  (event, request: SetFullTakeoverRequest) => {
    if (!agentService) throw new Error('Agent service is not ready.');
    return agentService.setFullTakeover(event.sender, request);
  },
);
handleTrusted(AGENT_CHANNELS.takeover, (event, request: TakeoverRequest) => {
  if (!agentService) throw new Error('Agent service is not ready.');
  return agentService.takeover(event.sender, request);
});
handleTrusted(
  AGENT_CHANNELS.resolveTakeover,
  (event, request: ResolveTakeoverRequest) => {
    if (!agentService) throw new Error('Agent service is not ready.');
    return agentService.resolveTakeover(event.sender, request);
  },
);
handleTrusted(
  AGENT_CHANNELS.confirmShellReady,
  (event, request: ConfirmShellReadyRequest) => {
    if (!agentService) throw new Error('Agent service is not ready.');
    return agentService.confirmShellReady(event.sender, request);
  },
);
handleTrusted(
  SESSION_CHANNELS.rename,
  (_event, request: RenameSessionRequest) => requireSessionManager().rename(request),
);
handleTrusted(
  SESSION_CHANNELS.readTerminalHistory,
  (_event, sessionId: string) => requireSessionManager().readTerminalHistory(sessionId),
);
handleTrusted(
  SESSION_CHANNELS.readHistoryDetail,
  (_event, request: ReadSessionHistoryDetailRequest) => (
    requireSessionManager().readHistoryDetail(request)
  ),
);
handleTrusted(
  SESSION_CHANNELS.remove,
  (event, request: DeleteSessionRequest) => requireSessionManager().remove(event.sender, request),
);

if (ownsSingleInstance) void app.whenReady().then(async () => {
  hostStore = new HostStore(join(app.getPath('userData'), 'config', 'hosts.json'));
  const secretStore = isSmokeTest
    ? new MemorySecretStore()
    : new FileSecretStore(join(app.getPath('userData'), 'config', 'secrets.json'));
  appSettingsStore = new AppSettingsStore(
    join(app.getPath('userData'), 'config', 'app-settings.json'),
  );
  backupService = new BackupService(
    {
      settings: join(app.getPath('userData'), 'config', 'app-settings.json'),
      providers: join(app.getPath('userData'), 'config', 'providers.json'),
      codexAppServer: join(app.getPath('userData'), 'config', 'codex-app-server.json'),
      sessions: join(app.getPath('userData'), 'sessions'),
    },
    secretStore,
    app.getVersion(),
  );
  hostBackupService = new HostBackupService(
    join(app.getPath('userData'), 'config', 'hosts.json'),
    secretStore,
    app.getVersion(),
  );
  if (smokeMode === 'agent' || smokeMode === 'agent-ssh') {
    agentSmokeProvider = await startAgentSmokeProvider(smokeMode === 'agent-ssh');
  }
  providerStore = new ProviderStore(
    join(app.getPath('userData'), 'config', 'providers.json'),
    secretStore,
  );
  if (agentSmokeProvider) {
    const profile = await providerStore.save({
      name: 'Agent Smoke Provider',
      baseUrl: agentSmokeProvider.baseUrl,
      modelId: 'agent-smoke-model',
      apiKey: 'agent-smoke-secret',
      makeDefault: true,
    });
    const result = await providerStore.testConnection(profile.id);
    if (!result.ok) throw new Error(`Unable to prepare Agent smoke Provider: ${result.message}`);
  }
  sessionManager = new SessionManager(
    new SessionStore(join(app.getPath('userData'), 'sessions')),
    terminalService,
    hostStore,
    remoteFilesystemProvider,
  );
  hostService = new HostService(
    hostStore,
    new HostCredentialStore(secretStore),
    terminalService,
    sessionManager,
  );
  codexAppServerService = new CodexAppServerService(
    join(app.getPath('userData'), 'config', 'codex-app-server.json'),
    app.getAppPath(),
    process.resourcesPath,
    app.getVersion(),
    async (url) => {
      await shell.openExternal(url);
    },
  );
  codexAppServerService.onStateChanged((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) {
        try {
          window.webContents.send(CODEX_APP_SERVER_CHANNELS.stateChanged, state);
        } catch {
          // A concurrently closing window must not starve other windows of state.
        }
      }
    }
  });
  agentService = new AgentService(
    terminalService,
    sessionManager,
    providerStore,
    codexAppServerService,
    new AgentFileService(terminalService, sessionManager, remoteFilesystemProvider),
    // The Generic Provider backend runs through the LangChain harness, loaded
    // lazily so its ESM-only dependencies do not delay application startup.
    // The shared visible terminal remains the only shell: LangChain's own
    // shell/file tools are never registered (see langchain-backend.ts).
    async (providerId) => {
      const { LangChainBackend, LangChainProviderModelFactory } = await import(
        './agent/langchain-backend'
      );
      return new LangChainBackend({
        modelFactory: () => new LangChainProviderModelFactory(
          providerId,
          requireProviderStore(),
        ).build(),
      });
    },
  );
  createMainWindow();
  void codexAppServerService.startIfBound();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

if (ownsSingleInstance) app.on('before-quit', () => {
  transferQueue.close();
  agentService?.close();
  codexAppServerService?.close();
  sessionManager?.close();
  void agentSmokeProvider?.close();
});

if (ownsSingleInstance) app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
