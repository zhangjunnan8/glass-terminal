import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRODUCT_NAME } from '../shared/product';

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const isSmokeTest = process.env.AI_TERMINAL_SMOKE_TEST === '1';

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
      const rendererReady = await window.webContents.executeJavaScript(
        "Boolean(document.querySelector('.app-shell'))",
      );
      console.log(`SMOKE_RENDERER_READY=${String(rendererReady)}`);
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

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
