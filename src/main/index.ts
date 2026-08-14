import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRODUCT_NAME } from '../shared/product';
import { TERMINAL_CHANNELS } from '../shared/terminal';
import type { CreateTerminalRequest } from '../shared/terminal';
import { TerminalService } from './terminal/terminal-service';

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const isSmokeTest = process.env.AI_TERMINAL_SMOKE_TEST === '1';
const terminalService = new TerminalService();

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
    window.webContents.once('did-finish-load', async () => {
      const smokeCommand = process.platform === 'win32'
        ? "Write-Output '__AI_TERMINAL_PTY_SMOKE__'\r"
        : "printf '__AI_TERMINAL_PTY_SMOKE__\\n'\n";
      const rendererReady = await window.webContents.executeJavaScript(
        `(async () => {
          const waitFor = (predicate, timeout = 10000) => new Promise((resolve) => {
            const deadline = Date.now() + timeout;
            const check = () => {
              if (predicate()) resolve(true);
              else if (Date.now() >= deadline) resolve(false);
              else setTimeout(check, 100);
            };
            check();
          });
          const started = await waitFor(
            () => document.querySelector('[data-terminal-output="true"]'),
          );
          if (!started) return false;
          const pane = document.querySelector('[data-terminal-output="true"]');
          const terminalId = pane?.getAttribute('data-terminal-id');
          if (!terminalId) return false;
          await window.aiTerminal.terminal.write(terminalId, ${JSON.stringify(smokeCommand)});
          const commandSeen = await waitFor(
            () => pane.textContent?.includes('__AI_TERMINAL_PTY_SMOKE__'),
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
          await window.aiTerminal.terminal.close(terminalId);
          await new Promise((resolve) => setTimeout(resolve, 250));
          return commandSeen;
        })()`,
      );
      console.log(`SMOKE_LOCAL_TERMINAL_READY=${String(rendererReady)}`);
      app.exit(rendererReady ? 0 : 1);
    });
    window.webContents.once('did-fail-load', (_event, code, description) => {
      console.error(`SMOKE_RENDERER_FAILED=${code}:${description}`);
      app.exit(1);
    });
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

app.whenReady().then(() => {
  const window = createMainWindow();
  const contents = window.webContents;
  const contentsId = contents.id;
  contents.once('destroyed', () => {
    terminalService.closeOwnedBy(contentsId);
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
