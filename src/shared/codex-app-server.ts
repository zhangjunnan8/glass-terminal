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

export type CodexAgentIsolationAvailability =
  | 'unavailable'
  | 'eligible'
  | 'enabled'
  | 'blocked';

export interface CodexAgentIsolationViolation {
  detectedAt: string;
  kind: 'command-execution' | 'file-change' | 'permission-request' | 'protocol';
  detail: string;
}

export interface CodexAgentIsolationState {
  policyVersion: 1;
  experimental: boolean;
  userEnabled: boolean;
  availability: CodexAgentIsolationAvailability;
  acceptedClientTools: Array<'terminal_read' | 'terminal_state' | 'terminal_execute'>;
  environmentAccessDisabled: boolean;
  enforcement: 'empty-environment-plus-deny-and-interrupt' | 'codex-native-workspace-write';
  reason: string;
  lastViolation?: CodexAgentIsolationViolation;
}

export interface CodexTerminalContextAccessState {
  available: boolean;
  enabled: boolean;
  acceptedClientTools: Array<'terminal_read'>;
  reason: string;
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
  /** Whether the native Codex Agent backend is ready for a turn. */
  agentAvailable: boolean;
  agentReason: string;
  /** Optional, read-only access to the currently selected visible terminal. */
  terminalContextAccess: CodexTerminalContextAccessState;
  /** @deprecated Compatibility alias for agentAvailable. */
  terminalAgentEnabled: boolean;
  /** @deprecated Compatibility alias for agentReason. */
  terminalAgentReason: string;
  /** @deprecated Compatibility view; use terminalContextAccess instead. */
  agentIsolation: CodexAgentIsolationState;
  error?: string;
}

export interface SaveCodexAppServerSelectionRequest {
  modelId: string;
  reasoningEffort?: string;
}

export interface SetCodexTerminalContextAccessRequest {
  enabled: boolean;
}

/** @deprecated Use SetCodexTerminalContextAccessRequest. */
export interface SetCodexTerminalAgentEnabledRequest
  extends SetCodexTerminalContextAccessRequest {
  acknowledgementVersion?: 1;
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
  setTerminalContextAccess: 'codex-app-server:set-terminal-context-access',
  /** @deprecated Kept for already-open renderer bundles. */
  setTerminalAgentEnabled: 'codex-app-server:set-terminal-agent-enabled',
  stateChanged: 'codex-app-server:state-changed',
} as const;
