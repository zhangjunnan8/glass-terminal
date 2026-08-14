import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../shared/ipc';
import { HOST_CHANNELS } from '../shared/host';
import { TERMINAL_CHANNELS } from '../shared/terminal';
import type { TerminalDataEvent, TerminalExitEvent } from '../shared/terminal';
import { SESSION_CHANNELS } from '../shared/session';
import { SFTP_CHANNELS } from '../shared/sftp';
import type { TransferJobSnapshot } from '../shared/sftp';
import { PROVIDER_CHANNELS } from '../shared/provider';
import { AGENT_CHANNELS } from '../shared/agent';
import type { AgentSessionView } from '../shared/agent';

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

const sftpBridge: DesktopBridge['sftp'] = {
  listDirectory: (terminalId, path) => ipcRenderer.invoke(
    SFTP_CHANNELS.listDirectory,
    terminalId,
    path,
  ),
  chooseUpload: (request) => ipcRenderer.invoke(SFTP_CHANNELS.chooseUpload, request),
  chooseDownload: (request) => ipcRenderer.invoke(SFTP_CHANNELS.chooseDownload, request),
  listTransfers: (terminalId) => ipcRenderer.invoke(SFTP_CHANNELS.listTransfers, terminalId),
  cancelTransfer: (jobId) => ipcRenderer.invoke(SFTP_CHANNELS.cancelTransfer, jobId),
  retryTransfer: (jobId) => ipcRenderer.invoke(SFTP_CHANNELS.retryTransfer, jobId),
  onTransferUpdated: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, job: TransferJobSnapshot) => {
      listener(job);
    };
    ipcRenderer.on(SFTP_CHANNELS.transferUpdated, handler);
    return () => ipcRenderer.removeListener(SFTP_CHANNELS.transferUpdated, handler);
  },
};

const providerBridge: DesktopBridge['providers'] = {
  list: () => ipcRenderer.invoke(PROVIDER_CHANNELS.list),
  save: (input) => ipcRenderer.invoke(PROVIDER_CHANNELS.save, input),
  remove: (providerId) => ipcRenderer.invoke(PROVIDER_CHANNELS.remove, providerId),
  setDefault: (providerId) => ipcRenderer.invoke(PROVIDER_CHANNELS.setDefault, providerId),
  testConnection: (providerId) => ipcRenderer.invoke(
    PROVIDER_CHANNELS.testConnection,
    providerId,
  ),
};

const agentBridge: DesktopBridge['agent'] = {
  sendPrompt: (request) => ipcRenderer.invoke(AGENT_CHANNELS.sendPrompt, request),
  getState: (terminalId) => ipcRenderer.invoke(AGENT_CHANNELS.getState, terminalId),
  resolveApproval: (request) => ipcRenderer.invoke(AGENT_CHANNELS.resolveApproval, request),
  onStateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AgentSessionView) => {
      listener(state);
    };
    ipcRenderer.on(AGENT_CHANNELS.stateChanged, handler);
    return () => ipcRenderer.removeListener(AGENT_CHANNELS.stateChanged, handler);
  },
};

const bridge: DesktopBridge = Object.freeze({
  runtime: Object.freeze({
    getInfo: () => ipcRenderer.invoke('runtime:get-info'),
  }),
  terminal: Object.freeze(terminalBridge),
  hosts: Object.freeze(hostBridge),
  sessions: Object.freeze(sessionBridge),
  sftp: Object.freeze(sftpBridge),
  providers: Object.freeze(providerBridge),
  agent: Object.freeze(agentBridge),
});

contextBridge.exposeInMainWorld('aiTerminal', bridge);
