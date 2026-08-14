export type AgentRuntimeState =
  | 'USER_CONTROL'
  | 'THINKING'
  | 'WAITING_APPROVAL'
  | 'AI_CONTROL'
  | 'RUNNING'
  | 'WAITING_OUTPUT'
  | 'WAITING_AUTH'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED';

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
  terminalId: string;
  sessionId: string;
  threadId: string;
  providerId: string;
  state: AgentRuntimeState;
  fullTakeover: boolean;
  messages: AgentChatItem[];
  pendingApproval?: CommandApproval;
  activeExecution?: CommandExecution;
  error?: string;
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

export const AGENT_CHANNELS = {
  sendPrompt: 'agent:send-prompt',
  getState: 'agent:get-state',
  resolveApproval: 'agent:resolve-approval',
  stateChanged: 'agent:state-changed',
} as const;
