import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRODUCT_NAME } from '../shared/product';
import { HOST_CHANNELS, SSH_ERROR_CODES } from '../shared/host';
import type { HostInput, SshConnectRequest } from '../shared/host';
import { TERMINAL_CHANNELS } from '../shared/terminal';
import type { CreateTerminalRequest } from '../shared/terminal';
import { SESSION_CHANNELS } from '../shared/session';
import type { RenameSessionRequest, UpgradeSessionRequest } from '../shared/session';
import { SFTP_CHANNELS } from '../shared/sftp';
import type { DownloadSelectionRequest, UploadSelectionRequest } from '../shared/sftp';
import { PROVIDER_CHANNELS } from '../shared/provider';
import type { ProviderInput } from '../shared/provider';
import { AGENT_CHANNELS } from '../shared/agent';
import type { ResolveApprovalRequest, SendAgentPromptRequest } from '../shared/agent';
import { HostStore } from './hosts/host-store';
import { SessionManager } from './sessions/session-manager';
import { SessionStore } from './sessions/session-store';
import { SftpService } from './sftp/sftp-service';
import { TransferQueue } from './sftp/transfer-queue';
import { ProviderStore } from './providers/provider-store';
import { MemorySecretStore, WindowsCredentialStore } from './providers/secret-store';
import { AgentService } from './agent/agent-service';
import { startAgentSmokeProvider } from './smoke/agent-provider-server';
import type { AgentSmokeProvider } from './smoke/agent-provider-server';
import { registerSmokeRunner, smokeModeFromEnvironment } from './smoke/smoke-runner';
import { TerminalService } from './terminal/terminal-service';

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const smokeMode = smokeModeFromEnvironment();
const isSmokeTest = smokeMode !== null;
const terminalService = new TerminalService();
const sftpService = new SftpService(terminalService);
const transferQueue = new TransferQueue(terminalService);
let hostStore: HostStore | undefined;
let sessionManager: SessionManager | undefined;
let providerStore: ProviderStore | undefined;
let agentService: AgentService | undefined;
let agentSmokeProvider: AgentSmokeProvider | undefined;

if (isSmokeTest) {
  app.setPath('userData', join(process.cwd(), '.smoke-data', smokeMode!));
}

function requireHostStore(): HostStore {
  if (!hostStore) throw new Error('Host store is not ready.');
  return hostStore;
}

function requireSessionManager(): SessionManager {
  if (!sessionManager) throw new Error('Session manager is not ready.');
  return sessionManager;
}

function requireProviderStore(): ProviderStore {
  if (!providerStore) throw new Error('Provider store is not ready.');
  return providerStore;
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
    const allowed = isDevelopment
      ? url.startsWith(process.env.VITE_DEV_SERVER_URL ?? '')
      : url.startsWith('file:');
    if (!allowed) event.preventDefault();
  });

  if (isDevelopment) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL!);
  } else {
    void window.loadURL(
      pathToFileURL(join(__dirname, '..', 'dist', 'index.html')).toString(),
    );
  }

  const contents = window.webContents;
  const contentsId = contents.id;
  contents.once('destroyed', () => {
    agentService?.closeOwnedBy(contentsId);
    terminalService.closeOwnedBy(contentsId);
  });

  return window;
}

ipcMain.handle('runtime:get-info', () => ({
  platform: process.platform,
  arch: process.arch,
  version: app.getVersion(),
}));

ipcMain.handle(TERMINAL_CHANNELS.listShells, () => terminalService.listShells());
ipcMain.handle(
  TERMINAL_CHANNELS.create,
  (event, request: CreateTerminalRequest) => terminalService.create(event.sender, request),
);
ipcMain.handle(TERMINAL_CHANNELS.attach, (event, terminalId: string) => (
  terminalService.attach(event.sender, terminalId)
));
ipcMain.handle(
  TERMINAL_CHANNELS.write,
  (event, terminalId: string, data: string) => {
    terminalService.write(event.sender, terminalId, data);
  },
);
ipcMain.handle(
  TERMINAL_CHANNELS.resize,
  (event, terminalId: string, cols: number, rows: number) => {
    terminalService.resize(event.sender, terminalId, cols, rows);
  },
);
ipcMain.handle(TERMINAL_CHANNELS.close, (event, terminalId: string) => {
  transferQueue.cancelByTerminal(terminalId, event.sender.id);
  terminalService.close(event.sender, terminalId);
});

ipcMain.handle(HOST_CHANNELS.list, () => requireHostStore().list());
ipcMain.handle(HOST_CHANNELS.save, (_event, input: HostInput) => (
  requireHostStore().save(input)
));
ipcMain.handle(HOST_CHANNELS.remove, (_event, hostId: string) => {
  requireHostStore().remove(hostId);
});
ipcMain.handle(HOST_CHANNELS.connect, async (event, request: SshConnectRequest) => {
  const store = requireHostStore();
  const host = store.get(request.hostId);
  try {
    const result = await terminalService.createSsh(event.sender, host, request);
    if (!host.hostKeyFingerprint) {
      store.trustFingerprint(host.id, result.fingerprint);
    }
    if (request.sessionId) {
      requireSessionManager().reconnect(event.sender, result.descriptor, request.sessionId);
    }
    return { status: 'connected', terminal: result.descriptor };
  } catch (error) {
    const message = (error as Error).message;
    const marker = `${SSH_ERROR_CODES.hostKeyRequired}:`;
    if (message.startsWith(marker)) {
      return {
        status: 'host-key-required',
        fingerprint: message.slice(marker.length),
      };
    }
    throw error;
  }
});

ipcMain.handle(SESSION_CHANNELS.list, (_event, hostId?: string) => (
  requireSessionManager().list(hostId)
));
ipcMain.handle(
  SESSION_CHANNELS.upgrade,
  (event, request: UpgradeSessionRequest) => (
    requireSessionManager().upgrade(event.sender, request.terminalId)
  ),
);

ipcMain.handle(
  SFTP_CHANNELS.listDirectory,
  (event, terminalId: string, path?: string) => (
    sftpService.listDirectory(event.sender, terminalId, path)
  ),
);
ipcMain.handle(
  SFTP_CHANNELS.chooseUpload,
  async (event, request: UploadSelectionRequest) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow) throw new Error('Upload window is unavailable.');
    const selection = await dialog.showOpenDialog(ownerWindow, {
      title: 'Upload files',
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
ipcMain.handle(
  SFTP_CHANNELS.chooseDownload,
  async (event, request: DownloadSelectionRequest) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow) throw new Error('Download window is unavailable.');
    const safeName = request.suggestedName
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '') || 'download';
    const selection = await dialog.showSaveDialog(ownerWindow, {
      title: 'Download file',
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
ipcMain.handle(SFTP_CHANNELS.listTransfers, (event, terminalId?: string) => (
  transferQueue.list(event.sender, terminalId)
));
ipcMain.handle(SFTP_CHANNELS.cancelTransfer, (event, jobId: string) => (
  transferQueue.cancel(event.sender, jobId)
));
ipcMain.handle(SFTP_CHANNELS.retryTransfer, (event, jobId: string) => (
  transferQueue.retry(event.sender, jobId)
));
ipcMain.handle(PROVIDER_CHANNELS.list, () => requireProviderStore().list());
ipcMain.handle(PROVIDER_CHANNELS.save, (_event, input: ProviderInput) => (
  requireProviderStore().save(input)
));
ipcMain.handle(PROVIDER_CHANNELS.remove, (_event, providerId: string) => (
  requireProviderStore().remove(providerId)
));
ipcMain.handle(PROVIDER_CHANNELS.setDefault, (_event, providerId: string) => (
  requireProviderStore().setDefault(providerId)
));
ipcMain.handle(PROVIDER_CHANNELS.testConnection, (_event, providerId: string) => (
  requireProviderStore().testConnection(providerId)
));
ipcMain.handle(AGENT_CHANNELS.sendPrompt, (event, request: SendAgentPromptRequest) => {
  if (!agentService) throw new Error('Agent service is not ready.');
  return agentService.sendPrompt(event.sender, request);
});
ipcMain.handle(AGENT_CHANNELS.getState, (event, terminalId: string) => {
  if (!agentService) throw new Error('Agent service is not ready.');
  return agentService.getState(event.sender, terminalId);
});
ipcMain.handle(
  AGENT_CHANNELS.resolveApproval,
  (event, request: ResolveApprovalRequest) => {
    if (!agentService) throw new Error('Agent service is not ready.');
    return agentService.resolveApproval(event.sender, request);
  },
);
ipcMain.handle(
  SESSION_CHANNELS.rename,
  (_event, request: RenameSessionRequest) => requireSessionManager().rename(request),
);
ipcMain.handle(
  SESSION_CHANNELS.readTerminalHistory,
  (_event, sessionId: string) => requireSessionManager().readTerminalHistory(sessionId),
);

app.whenReady().then(async () => {
  hostStore = new HostStore(join(app.getPath('userData'), 'config', 'hosts.json'));
  if (smokeMode === 'agent' || smokeMode === 'agent-ssh') {
    agentSmokeProvider = await startAgentSmokeProvider(smokeMode === 'agent-ssh');
  }
  providerStore = new ProviderStore(
    join(app.getPath('userData'), 'config', 'providers.json'),
    smokeMode === 'agent' || smokeMode === 'agent-ssh'
      ? new MemorySecretStore()
      : new WindowsCredentialStore(),
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
  );
  agentService = new AgentService(terminalService, sessionManager, providerStore);
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', () => {
  transferQueue.close();
  agentService?.close();
  sessionManager?.close();
  void agentSmokeProvider?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
