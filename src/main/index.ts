import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRODUCT_NAME } from '../shared/product';
import { HOST_CHANNELS, SSH_ERROR_CODES } from '../shared/host';
import type { HostInput, SshConnectRequest } from '../shared/host';
import { TERMINAL_CHANNELS } from '../shared/terminal';
import type { CreateTerminalRequest } from '../shared/terminal';
import { SESSION_CHANNELS } from '../shared/session';
import type { RenameSessionRequest, UpgradeSessionRequest } from '../shared/session';
import { HostStore } from './hosts/host-store';
import { SessionManager } from './sessions/session-manager';
import { SessionStore } from './sessions/session-store';
import { registerSmokeRunner, smokeModeFromEnvironment } from './smoke/smoke-runner';
import { TerminalService } from './terminal/terminal-service';

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const smokeMode = smokeModeFromEnvironment();
const isSmokeTest = smokeMode !== null;
const terminalService = new TerminalService();
let hostStore: HostStore | undefined;
let sessionManager: SessionManager | undefined;

if (isSmokeTest) {
  app.setPath('userData', join(process.cwd(), '.smoke-data'));
}

function requireHostStore(): HostStore {
  if (!hostStore) throw new Error('Host store is not ready.');
  return hostStore;
}

function requireSessionManager(): SessionManager {
  if (!sessionManager) throw new Error('Session manager is not ready.');
  return sessionManager;
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
  contents.once('destroyed', () => terminalService.closeOwnedBy(contentsId));

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
  SESSION_CHANNELS.rename,
  (_event, request: RenameSessionRequest) => requireSessionManager().rename(request),
);
ipcMain.handle(
  SESSION_CHANNELS.readTerminalHistory,
  (_event, sessionId: string) => requireSessionManager().readTerminalHistory(sessionId),
);

app.whenReady().then(() => {
  hostStore = new HostStore(join(app.getPath('userData'), 'config', 'hosts.json'));
  sessionManager = new SessionManager(
    new SessionStore(join(app.getPath('userData'), 'sessions')),
    terminalService,
    hostStore,
  );
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', () => sessionManager?.close());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
