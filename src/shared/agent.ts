export type AgentRuntimeState =
  | 'USER_CONTROL'
  | 'THINKING'
  | 'WAITING_APPROVAL'
  | 'AI_CONTROL'
  | 'RUNNING'
  | 'WAITING_OUTPUT'
  | 'WAITING_AUTH'
  | 'TAKEOVER_PENDING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED';

export type TerminalInputMode = 'human' | 'locked' | 'secure-human';
export type AgentFileAccessMode = 'off' | 'read-only' | 'read-write';

export const CODEX_APP_SERVER_AGENT_BACKEND = 'codex-app-server-isolated' as const;
export const CODEX_APP_SERVER_AGENT_POLICY_VERSION = 1 as const;

export type AgentBackendRef =
  | {
    kind: 'generic-provider';
    providerId: string;
  }
  | {
    kind: typeof CODEX_APP_SERVER_AGENT_BACKEND;
    policyVersion: typeof CODEX_APP_SERVER_AGENT_POLICY_VERSION;
  };

export type CommandActor = 'ai' | 'user_modified_ai_command';
export type CommandExecutionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CommandExecution {
  id: string;
  sessionId: string;
  terminalId: string;
  actor: CommandActor;
  command: string;
  cwd?: string;
  requestedAt: string;
  startedAt: string;
  endedAt?: string;
  status: CommandExecutionStatus;
  exitCode?: number;
  output: string;
  outputRedacted?: boolean;
  interruptRequestedAt?: string;
  durationMs?: number;
}

export interface CommandApproval {
  id: string;
  sessionId: string;
  terminalId: string;
  command: string;
  reason?: string;
  status: 'waiting' | 'approved' | 'edited' | 'rejected';
  requestedAt: string;
  resolvedAt?: string;
}

export interface AgentChatItem {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export type AgentToolActivityKind = 'terminal' | 'workspace' | 'other';
export type AgentToolActivityStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface AgentToolActivity {
  id: string;
  toolName: string;
  kind: AgentToolActivityKind;
  label: string;
  status: AgentToolActivityStatus;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
}

export interface AgentSessionView {
  revision: number;
  terminalId: string;
  sessionId: string;
  threadId: string;
  backend: AgentBackendRef;
  /** @deprecated Kept for persisted Alpha clients; use backend instead. */
  providerId: string;
  state: AgentRuntimeState;
  terminalInputMode: TerminalInputMode;
  fullTakeover: boolean;
  /** Explicit, in-memory permission for Generic Provider file tools. Never persisted. */
  fileAccessMode: AgentFileAccessMode;
  /** Canonical explicit Session Workspace Root captured when file access was enabled. */
  fileAccessRoot?: string;
  messages: AgentChatItem[];
  /** Bounded, metadata-only summaries of recent tool use. */
  activities: AgentToolActivity[];
  streamingMessageId?: string;
  /** App Server interrupt is still draining; terminal input is human-owned but a new turn is unsafe. */
  backendTurnDraining?: boolean;
  pendingApproval?: CommandApproval;
  authRequest?: InteractiveAuthRequest;
  pendingTakeover?: PendingTakeover;
  activeExecution?: CommandExecution;
  error?: string;
}

export interface InteractiveAuthRequest {
  id: string;
  executionId: string;
  detectedAt: string;
}

export interface PendingTakeover {
  id: string;
  executionId: string;
  requestedAt: string;
}

export interface SendAgentPromptRequest {
  terminalId: string;
  prompt: string;
  backend?: AgentBackendRef;
  /** @deprecated Use backend. */
  providerId?: string;
}

export interface InterruptAgentTurnRequest {
  terminalId: string;
  messageId: string;
}

export interface ReviseAgentPromptRequest {
  terminalId: string;
  messageId: string;
  action: 'retract' | 'replace';
  prompt?: string;
}

export interface ResolveApprovalRequest {
  terminalId: string;
  approvalId: string;
  decision: 'execute' | 'edit' | 'reject';
  editedCommand?: string;
}

export interface SetFullTakeoverRequest {
  terminalId: string;
  enabled: boolean;
  backend?: AgentBackendRef;
  /** @deprecated Use backend. */
  providerId?: string;
  approvalId?: string;
  editedCommand?: string;
}

export interface SetAgentFileAccessRequest {
  terminalId: string;
  mode: AgentFileAccessMode;
  backend: AgentBackendRef;
}

export interface TakeoverRequest {
  terminalId: string;
}

export interface ResolveTakeoverRequest {
  terminalId: string;
  takeoverId: string;
  executionId: string;
  action: 'keep' | 'interrupt';
}

export interface ConfirmShellReadyRequest {
  terminalId: string;
  executionId: string;
}

export const AGENT_CHANNELS = {
  sendPrompt: 'agent:send-prompt',
  interruptTurn: 'agent:interrupt-turn',
  revisePrompt: 'agent:revise-prompt',
  getState: 'agent:get-state',
  resolveApproval: 'agent:resolve-approval',
  setFullTakeover: 'agent:set-full-takeover',
  setFileAccess: 'agent:set-file-access',
  takeover: 'agent:takeover',
  resolveTakeover: 'agent:resolve-takeover',
  confirmShellReady: 'agent:confirm-shell-ready',
  stateChanged: 'agent:state-changed',
} as const;
