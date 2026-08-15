export type CodexAppServerPhase =
  | 'stopped'
  | 'detecting'
  | 'starting'
  | 'ready'
  | 'error';

export type CodexAppServerOperation =
  | 'idle'
  | 'starting'
  | 'restarting'
  | 'refreshing'
  | 'logging-in'
  | 'logging-out'
  | 'saving';

export interface CodexExecutableInfo {
  path: string;
  source: 'configured' | 'bundled' | 'path';
  version: string;
}

export interface CodexAccountInfo {
  type: string;
  email?: string;
  planType?: string;
}

export interface CodexReasoningEffort {
  reasoningEffort: string;
  description?: string;
}

export interface CodexModelInfo {
  id: string;
  model: string;
  displayName: string;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: CodexReasoningEffort[];
  inputModalities: string[];
  supportsPersonality: boolean;
  isDefault: boolean;
}

export interface CodexAppServerSelection {
  modelId: string;
  reasoningEffort?: string;
}

export type CodexPendingLogin =
  | {
    type: 'browser';
    startedAt: string;
  }
  | {
    type: 'device-code';
    userCode: string;
    startedAt: string;
  };

export interface CodexAppServerSnapshot {
  revision: number;
  phase: CodexAppServerPhase;
  operation: CodexAppServerOperation;
  executable?: CodexExecutableInfo;
  account?: CodexAccountInfo;
  requiresOpenaiAuth?: boolean;
  models: CodexModelInfo[];
  selection?: CodexAppServerSelection;
  pendingLogin?: CodexPendingLogin;
  bound: boolean;
  terminalAgentEnabled: false;
  terminalAgentReason: string;
  error?: string;
}

export interface SaveCodexAppServerSelectionRequest {
  modelId: string;
  reasoningEffort?: string;
}

export const CODEX_APP_SERVER_CHANNELS = {
  getState: 'codex-app-server:get-state',
  start: 'codex-app-server:start',
  chooseExecutable: 'codex-app-server:choose-executable',
  restart: 'codex-app-server:restart',
  refresh: 'codex-app-server:refresh',
  loginBrowser: 'codex-app-server:login-browser',
  loginDeviceCode: 'codex-app-server:login-device-code',
  reopenLogin: 'codex-app-server:reopen-login',
  cancelLogin: 'codex-app-server:cancel-login',
  logout: 'codex-app-server:logout',
  saveSelection: 'codex-app-server:save-selection',
  stateChanged: 'codex-app-server:state-changed',
} as const;
