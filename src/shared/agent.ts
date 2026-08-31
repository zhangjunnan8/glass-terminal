import type {
  AgentMemoryCard,
  RemoveAgentMemoryRequest,
  SaveAgentMemoryRequest,
} from './agent-memory';

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
/** One atomic policy for terminal commands and direct file tools. */
export type AgentReviewMode = 'all' | 'risky' | 'complete';
/** `read-only` is retained for persisted/internal policy compatibility but is no longer exposed by the UI. */
export type AgentFileAccessMode = 'off' | 'read-only' | 'read-write' | 'full-access';

/**
 * Explicit, ephemeral capabilities granted to Generic Provider workspace tools.
 * The access mode remains an upper bound: a policy can narrow a mode but cannot
 * use (for example) `write: true` to turn read-only access into write access.
 */
export interface AgentFileAccessPolicy {
  read: boolean;
  write: boolean;
  create: boolean;
  delete: boolean;
  readablePaths: string[];
  writablePaths: string[];
  /** Skip software path-range checks only; OS/SFTP user permissions still apply. */
  fullAccess: boolean;
}

export interface AgentBackendRef {
  kind: 'generic-provider';
  providerId: string;
}

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
  /** The structured command produced no output for the watchdog interval. */
  inactivityTimedOutAt?: string;
  interruptRequestedAt?: string;
  durationMs?: number;
}

export interface CommandApproval {
  id: string;
  sessionId: string;
  terminalId: string;
  command: string;
  reason?: string;
  /** Legacy values remain readable; Beta.4 emits terminal-command/file-operation. */
  kind?: 'standard' | 'workspace-tool-bypass' | 'terminal-command' | 'file-operation';
  fileOperation?: {
    toolName: string;
    operation: 'list' | 'read' | 'stat' | 'search' | 'glob' | 'write' | 'patch' | 'mkdir' | 'rename' | 'delete';
    target: string;
    recursive?: boolean;
    sensitive?: boolean;
    riskReason?: string;
  };
  fileCommandPolicy?: {
    categories: Array<'read' | 'search' | 'list' | 'stat'>;
    suggestedTools: string[];
    reasonCode: string;
  };
  status: 'waiting' | 'approved' | 'edited' | 'rejected';
  requestedAt: string;
  resolvedAt?: string;
}

export interface AgentChatItem {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  /** Stable task-turn grouping for the Beta.4 summary/process presentation. */
  turnId?: string;
  presentation?: 'intermediate' | 'summary';
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
  /**
   * Identifies the assistant message this activity belongs to. Absent for
   * activities persisted before the turn-grouping field existed; those remain
   * ungrouped in the renderer.
   */
  turnId?: string;
}

interface AgentContextUsageBase {
  source: 'estimated';
  status: 'ready' | 'compressing';
  lastCompressedAt?: string;
  // Optional on the shared union so diagnostic consumers can inspect a metric
  // after checking its source. Estimated sessions make these fields required.
  estimatedTokens?: number;
  messageEstimatedTokens?: number;
  toolSchemaEstimatedTokens?: number;
  fixedOverheadTokens?: number;
  safetyFactor?: number;
  boundToolCount?: number;
  providerReportedInputTokens?: number;
  currentTokens?: number;
  contextWindowTokens?: number;
  compressionThresholdTokens?: number;
  percentage?: number;
}

export interface AgentEstimatedContextUsage extends AgentContextUsageBase {
  source: 'estimated';
  /** Conservative final estimate after fixed overhead and the safety factor. */
  estimatedTokens: number;
  /** Message-only estimate before the safety factor. */
  messageEstimatedTokens?: number;
  /** Exact bound tool definitions estimated before the safety factor. */
  toolSchemaEstimatedTokens?: number;
  /** Provider/request wrapping allowance before the safety factor. */
  fixedOverheadTokens?: number;
  /** Configured multiplier applied to all locally estimated input components. */
  safetyFactor?: number;
  /** Number of tool definitions represented by toolSchemaEstimatedTokens. */
  boundToolCount?: number;
  /** Last Provider-reported input usage, retained for diagnostics only. */
  providerReportedInputTokens?: number;
  /** Configured hard model input window for the selected Provider. */
  contextWindowTokens: number;
  /** Safe threshold at which Glass Terminal automatically compacts context. */
  compressionThresholdTokens: number;
  /** Usage against the compression threshold, clamped to 0-100 for the UI. */
  percentage: number;
}

export type AgentContextUsage = AgentEstimatedContextUsage;

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
  /** Atomic approval/access mode. `fullTakeover` below is a derived legacy mirror. */
  reviewMode: AgentReviewMode;
  /** Ephemeral authority bound to this exact terminal runtime. */
  fullTakeover: boolean;
  /** Persistent Host hint only; never grants runtime authority. */
  fullTakeoverPreference: boolean;
  /** Explicit, in-memory permission for Generic Provider file tools. Never persisted. */
  fileAccessMode: AgentFileAccessMode;
  /** Optional for compatibility with persisted Alpha sessions and older render fixtures. */
  fileAccessPolicy?: AgentFileAccessPolicy;
  /** Default root for relative file paths; an explicit Workspace is guidance, not a permission boundary. */
  fileAccessRoot?: string;
  messages: AgentChatItem[];
  /** User-reviewed, bounded memories injected independently of summaries. */
  memories?: AgentMemoryCard[];
  /** Bounded, metadata-only summaries of recent tool use. */
  activities: AgentToolActivity[];
  /** Conservative local estimate for the configured compatible API model. */
  contextUsage?: AgentContextUsage;
  streamingMessageId?: string;
  /** Stable local turn identity for validating Assistant delta events. */
  streamingTurnId?: string;
  /** Last Assistant delta sequence already represented by this snapshot. */
  streamingSequence?: number;
  pendingApproval?: CommandApproval;
  authRequest?: InteractiveAuthRequest;
  pendingTakeover?: PendingTakeover;
  activeExecution?: CommandExecution;
  error?: string;
}

export interface AgentAssistantDelta {
  terminalId: string;
  threadId: string;
  messageId: string;
  turnId: string;
  /** Starts at one for each streaming message and increases without gaps. */
  sequence: number;
  delta: string;
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
  reason?: 'manual' | 'command-inactivity';
}

export interface SendAgentPromptRequest {
  terminalId: string;
  prompt: string;
  backend?: AgentBackendRef;
  /** @deprecated Use backend. */
  providerId?: string;
}

export interface ActivateAgentBackendRequest {
  terminalId: string;
  backend: AgentBackendRef;
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

export interface SetAgentReviewModeRequest {
  terminalId: string;
  mode: AgentReviewMode;
  backend?: AgentBackendRef;
  /** Required when entering Complete Access from the renderer confirmation flow. */
  completeAccessConfirmed?: boolean;
}

export interface SetFullTakeoverPreferenceRequest {
  terminalId: string;
  enabled: boolean;
}

export interface SetAgentFileAccessRequest {
  terminalId: string;
  mode: AgentFileAccessMode;
  backend: AgentBackendRef;
  /** Optional compare-and-set guard captured by a renderer confirmation dialog. */
  expectedWorkspaceRoot?: string;
  policy?: AgentFileAccessPolicy;
  /** Required by the service/UI confirmation flow before enabling full-access. */
  fullAccessConfirmed?: boolean;
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
  saveMemory: 'agent:save-memory',
  removeMemory: 'agent:remove-memory',
  getState: 'agent:get-state',
  activateBackend: 'agent:activate-backend',
  resolveApproval: 'agent:resolve-approval',
  setReviewMode: 'agent:set-review-mode',
  takeover: 'agent:takeover',
  resolveTakeover: 'agent:resolve-takeover',
  confirmShellReady: 'agent:confirm-shell-ready',
  stateChanged: 'agent:state-changed',
  assistantDelta: 'agent:assistant-delta',
} as const;

export type { AgentMemoryCard, RemoveAgentMemoryRequest, SaveAgentMemoryRequest };
