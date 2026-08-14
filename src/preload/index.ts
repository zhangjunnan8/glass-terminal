import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../shared/ipc';

const bridge: DesktopBridge = Object.freeze({
  runtime: Object.freeze({
    getInfo: () => ipcRenderer.invoke('runtime:get-info'),
  }),
});

contextBridge.exposeInMainWorld('aiTerminal', bridge);
