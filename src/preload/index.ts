import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../shared/ipc';
import { HOST_CHANNELS } from '../shared/host';
import { TERMINAL_CHANNELS } from '../shared/terminal';
import type { TerminalDataEvent, TerminalExitEvent } from '../shared/terminal';
import { SESSION_CHANNELS } from '../shared/session';
import type { SessionRecord } from '../shared/session';
import { SFTP_CHANNELS } from '../shared/sftp';
import type { TransferJobSnapshot } from '../shared/sftp';
import { PROVIDER_CHANNELS } from '../shared/provider';
import { AGENT_CHANNELS } from '../shared/agent';
import { containsObviousAgentSecret } from '../shared/agent-memory';
import type { AgentAssistantDelta, AgentSessionView } from '../shared/agent';
import { CODEX_APP_SERVER_CHANNELS } from '../shared/codex-app-server';
import type { CodexAppServerSnapshot } from '../shared/codex-app-server';
import { SETTINGS_CHANNELS, SETTINGS_WINDOW_CHANNELS } from '../shared/settings';
import { BACKUP_CHANNELS, HOST_BACKUP_CHANNELS } from '../shared/backup';
import { createTerminalEventDispatcher } from './terminal-event-dispatcher';

const subscribeToTerminalData = createTerminalEventDispatcher<TerminalDataEvent>((dispatch) => {
  ipcRenderer.on(TERMINAL_CHANNELS.data, (_event, payload: TerminalDataEvent) => {
    dispatch(payload);
  });
});

const subscribeToTerminalExit = createTerminalEventDispatcher<TerminalExitEvent>((dispatch) => {
  ipcRenderer.on(TERMINAL_CHANNELS.exit, (_event, payload: TerminalExitEvent) => {
    dispatch(payload);
  });
});

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
  readClipboardText: () => ipcRenderer.invoke(TERMINAL_CHANNELS.readClipboardText),
  writeClipboardText: (text) => ipcRenderer.invoke(
    TERMINAL_CHANNELS.writeClipboardText,
    text,
  ),
  onData: subscribeToTerminalData,
  onExit: subscribeToTerminalExit,
};

const hostBridge: DesktopBridge['hosts'] = {
  list: () => ipcRenderer.invoke(HOST_CHANNELS.list),
  save: (input) => ipcRenderer.invoke(HOST_CHANNELS.save, input),
  remove: (hostId) => ipcRenderer.invoke(HOST_CHANNELS.remove, hostId),
  forgetCredential: (hostId) => ipcRenderer.invoke(HOST_CHANNELS.forgetCredential, hostId),
  choosePrivateKeyPath: () => ipcRenderer.invoke(HOST_CHANNELS.choosePrivateKeyPath),
  listFolders: () => ipcRenderer.invoke(HOST_CHANNELS.listFolders),
  createFolder: (request) => ipcRenderer.invoke(HOST_CHANNELS.createFolder, request),
  renameFolder: (request) => ipcRenderer.invoke(HOST_CHANNELS.renameFolder, request),
  removeFolder: (folderId) => ipcRenderer.invoke(HOST_CHANNELS.removeFolder, folderId),
  moveFolder: (request) => ipcRenderer.invoke(HOST_CHANNELS.moveFolder, request),
  moveHost: (request) => ipcRenderer.invoke(HOST_CHANNELS.moveHost, request),
};

const sessionBridge: DesktopBridge['sessions'] = {
  list: (hostId) => ipcRenderer.invoke(SESSION_CHANNELS.list, hostId),
  upgrade: (request) => ipcRenderer.invoke(SESSION_CHANNELS.upgrade, request),
  setWorkspace: (request) => ipcRenderer.invoke(SESSION_CHANNELS.setWorkspace, request),
  remoteWorkspaceAtomicity: (terminalId) => ipcRenderer.invoke(
    SESSION_CHANNELS.remoteWorkspaceAtomicity,
    terminalId,
  ),
  clearWorkspace: (request) => ipcRenderer.invoke(SESSION_CHANNELS.clearWorkspace, request),
  chooseLocalWorkspace: (request) => ipcRenderer.invoke(
    SESSION_CHANNELS.chooseLocalWorkspace,
    request,
  ),
  rename: (request) => ipcRenderer.invoke(SESSION_CHANNELS.rename, request),
  onRenamed: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, session: SessionRecord) => {
      listener(session);
    };
    ipcRenderer.on(SESSION_CHANNELS.renamed, handler);
    return () => ipcRenderer.removeListener(SESSION_CHANNELS.renamed, handler);
  },
  readTerminalHistory: (sessionId) => ipcRenderer.invoke(
    SESSION_CHANNELS.readTerminalHistory,
    sessionId,
  ),
  readHistoryDetail: (request) => ipcRenderer.invoke(
    SESSION_CHANNELS.readHistoryDetail,
    request,
  ),
  remove: (request) => ipcRenderer.invoke(SESSION_CHANNELS.remove, request),
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
  discoverModels: (input) => ipcRenderer.invoke(PROVIDER_CHANNELS.discoverModels, input),
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
  setTerminalContextAccess: (request) => ipcRenderer.invoke(
    CODEX_APP_SERVER_CHANNELS.setTerminalContextAccess,
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
  interruptTurn: (request) => ipcRenderer.invoke(AGENT_CHANNELS.interruptTurn, request),
  revisePrompt: (request) => ipcRenderer.invoke(AGENT_CHANNELS.revisePrompt, request),
  saveMemory: (request) => {
    if (containsObviousAgentSecret(request.content)) {
      return Promise.reject(new Error('检测到明显凭据；上下文记忆请求未通过 IPC 发送。'));
    }
    return ipcRenderer.invoke(AGENT_CHANNELS.saveMemory, request);
  },
  removeMemory: (request) => ipcRenderer.invoke(AGENT_CHANNELS.removeMemory, request),
  getState: (terminalId) => ipcRenderer.invoke(AGENT_CHANNELS.getState, terminalId),
  activateBackend: (request) => ipcRenderer.invoke(AGENT_CHANNELS.activateBackend, request),
  setFileAccess: (request) => ipcRenderer.invoke(AGENT_CHANNELS.setFileAccess, request),
  resolveApproval: (request) => ipcRenderer.invoke(AGENT_CHANNELS.resolveApproval, request),
  setFullTakeover: (request) => ipcRenderer.invoke(AGENT_CHANNELS.setFullTakeover, request),
  setFullTakeoverPreference: (request) => ipcRenderer.invoke(
    AGENT_CHANNELS.setFullTakeoverPreference,
    request,
  ),
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
  onAssistantDelta: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: AgentAssistantDelta) => {
      listener(event);
    };
    ipcRenderer.on(AGENT_CHANNELS.assistantDelta, handler);
    return () => ipcRenderer.removeListener(AGENT_CHANNELS.assistantDelta, handler);
  },
};

const settingsBridge: DesktopBridge['settings'] = {
  get: () => ipcRenderer.invoke(SETTINGS_CHANNELS.get),
  update: (patch) => ipcRenderer.invoke(SETTINGS_CHANNELS.update, patch),
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: import('../shared/settings').AppSettings) => {
      listener(settings);
    };
    ipcRenderer.on(SETTINGS_CHANNELS.changed, handler);
    return () => ipcRenderer.removeListener(SETTINGS_CHANNELS.changed, handler);
  },
};

const backupBridge: DesktopBridge['backup'] = {
  export: (request) => ipcRenderer.invoke(BACKUP_CHANNELS.export, request),
  import: (request) => ipcRenderer.invoke(BACKUP_CHANNELS.import, request),
};

const hostBackupBridge: DesktopBridge['hostBackup'] = {
  export: (request) => ipcRenderer.invoke(HOST_BACKUP_CHANNELS.export, request),
  import: (request) => ipcRenderer.invoke(HOST_BACKUP_CHANNELS.import, request),
};

const settingsWindowBridge: DesktopBridge['settingsWindow'] = {
  open: () => ipcRenderer.invoke(SETTINGS_WINDOW_CHANNELS.open),
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
  settings: Object.freeze(settingsBridge),
  backup: Object.freeze(backupBridge),
  hostBackup: Object.freeze(hostBackupBridge),
  settingsWindow: Object.freeze(settingsWindowBridge),
});

contextBridge.exposeInMainWorld('aiTerminal', bridge);
