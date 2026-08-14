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

export interface AgentSessionView {
  revision: number;
  terminalId: string;
  sessionId: string;
  threadId: string;
  providerId: string;
  state: AgentRuntimeState;
  terminalInputMode: TerminalInputMode;
  fullTakeover: boolean;
  messages: AgentChatItem[];
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
  providerId?: string;
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
  providerId?: string;
  approvalId?: string;
  editedCommand?: string;
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
  getState: 'agent:get-state',
  resolveApproval: 'agent:resolve-approval',
  setFullTakeover: 'agent:set-full-takeover',
  takeover: 'agent:takeover',
  resolveTakeover: 'agent:resolve-takeover',
  confirmShellReady: 'agent:confirm-shell-ready',
  stateChanged: 'agent:state-changed',
} as const;
