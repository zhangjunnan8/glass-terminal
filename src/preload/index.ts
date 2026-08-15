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
import { CODEX_APP_SERVER_CHANNELS } from '../shared/codex-app-server';
import type { CodexAppServerSnapshot } from '../shared/codex-app-server';

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
  forgetCredential: (hostId) => ipcRenderer.invoke(HOST_CHANNELS.forgetCredential, hostId),
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

const codexAppServerBridge: DesktopBridge['codexAppServer'] = {
  getState: () => ipcRenderer.invoke(CODEX_APP_SERVER_CHANNELS.getState),
  start: () => ipcRenderer.invoke(CODEX_APP_SERVER_CHANNELS.start),
  chooseExecutable: () => ipcRenderer.invoke(CODEX_APP_SERVER_CHANNELS.chooseExecutable),
  restart: () => ipcRenderer.invoke(CODEX_APP_SERVER_CHANNELS.restart),
  refresh: () => ipcRenderer.invoke(CODEX_APP_SERVER_CHANNELS.refresh),
  loginBrowser: () => ipcRenderer.invoke(CODEX_APP_SERVER_CHANNELS.loginBrowser),
  loginDeviceCode: () => ipcRenderer.invoke(CODEX_APP_SERVER_CHANNELS.loginDeviceCode),
  reopenLogin: () => ipcRenderer.invoke(CODEX_APP_SERVER_CHANNELS.reopenLogin),
  cancelLogin: () => ipcRenderer.invoke(CODEX_APP_SERVER_CHANNELS.cancelLogin),
  logout: () => ipcRenderer.invoke(CODEX_APP_SERVER_CHANNELS.logout),
  saveSelection: (request) => ipcRenderer.invoke(
    CODEX_APP_SERVER_CHANNELS.saveSelection,
    request,
  ),
  setTerminalAgentEnabled: (request) => ipcRenderer.invoke(
    CODEX_APP_SERVER_CHANNELS.setTerminalAgentEnabled,
    request,
  ),
  onStateChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: CodexAppServerSnapshot,
    ) => listener(state);
    ipcRenderer.on(CODEX_APP_SERVER_CHANNELS.stateChanged, handler);
    return () => ipcRenderer.removeListener(CODEX_APP_SERVER_CHANNELS.stateChanged, handler);
  },
};

const agentBridge: DesktopBridge['agent'] = {
  sendPrompt: (request) => ipcRenderer.invoke(AGENT_CHANNELS.sendPrompt, request),
  getState: (terminalId) => ipcRenderer.invoke(AGENT_CHANNELS.getState, terminalId),
  resolveApproval: (request) => ipcRenderer.invoke(AGENT_CHANNELS.resolveApproval, request),
  setFullTakeover: (request) => ipcRenderer.invoke(AGENT_CHANNELS.setFullTakeover, request),
  takeover: (request) => ipcRenderer.invoke(AGENT_CHANNELS.takeover, request),
  resolveTakeover: (request) => ipcRenderer.invoke(AGENT_CHANNELS.resolveTakeover, request),
  confirmShellReady: (request) => ipcRenderer.invoke(
    AGENT_CHANNELS.confirmShellReady,
    request,
  ),
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
  codexAppServer: Object.freeze(codexAppServerBridge),
  agent: Object.freeze(agentBridge),
});

contextBridge.exposeInMainWorld('aiTerminal', bridge);
