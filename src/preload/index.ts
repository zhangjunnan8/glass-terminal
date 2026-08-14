import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../shared/ipc';
import { HOST_CHANNELS } from '../shared/host';
import { TERMINAL_CHANNELS } from '../shared/terminal';
import type { TerminalDataEvent, TerminalExitEvent } from '../shared/terminal';
import { SESSION_CHANNELS } from '../shared/session';

const terminalBridge: DesktopBridge['terminal'] = {
  listShells: () => ipcRenderer.invoke(TERMINAL_CHANNELS.listShells),
  create: (request) => ipcRenderer.invoke(TERMINAL_CHANNELS.create, request),
  connectSsh: (request) => ipcRenderer.invoke(HOST_CHANNELS.connect, request),
  attach: (terminalId) => ipcRenderer.invoke(TERMINAL_CHANNELS.attach, terminalId),
  write: (terminalId, data) => ipcRenderer.invoke(
    TERMINAL_CHANNELS.write,
    terminalId,
    data,
  ),
  resize: (terminalId, cols, rows) => ipcRenderer.invoke(
    TERMINAL_CHANNELS.resize,
    terminalId,
    cols,
    rows,
  ),
  close: (terminalId) => ipcRenderer.invoke(TERMINAL_CHANNELS.close, terminalId),
  onData: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent) => {
      listener(payload);
    };
    ipcRenderer.on(TERMINAL_CHANNELS.data, handler);
    return () => ipcRenderer.removeListener(TERMINAL_CHANNELS.data, handler);
  },
  onExit: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalExitEvent) => {
      listener(payload);
    };
    ipcRenderer.on(TERMINAL_CHANNELS.exit, handler);
    return () => ipcRenderer.removeListener(TERMINAL_CHANNELS.exit, handler);
  },
};

const hostBridge: DesktopBridge['hosts'] = {
  list: () => ipcRenderer.invoke(HOST_CHANNELS.list),
  save: (input) => ipcRenderer.invoke(HOST_CHANNELS.save, input),
  remove: (hostId) => ipcRenderer.invoke(HOST_CHANNELS.remove, hostId),
};

const sessionBridge: DesktopBridge['sessions'] = {
  list: (hostId) => ipcRenderer.invoke(SESSION_CHANNELS.list, hostId),
  upgrade: (request) => ipcRenderer.invoke(SESSION_CHANNELS.upgrade, request),
  rename: (request) => ipcRenderer.invoke(SESSION_CHANNELS.rename, request),
  readTerminalHistory: (sessionId) => ipcRenderer.invoke(
    SESSION_CHANNELS.readTerminalHistory,
    sessionId,
  ),
};

const bridge: DesktopBridge = Object.freeze({
  runtime: Object.freeze({
    getInfo: () => ipcRenderer.invoke('runtime:get-info'),
  }),
  terminal: Object.freeze(terminalBridge),
  hosts: Object.freeze(hostBridge),
  sessions: Object.freeze(sessionBridge),
});

contextBridge.exposeInMainWorld('aiTerminal', bridge);
