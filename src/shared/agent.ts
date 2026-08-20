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
  /**
   * Identifies the assistant message this activity belongs to. Absent for
   * activities persisted before the turn-grouping field existed; those remain
   * ungrouped in the renderer.
   */
  turnId?: string;
}

interface AgentContextUsageBase {
  /** Identifies whether Glass estimated this value or Codex reported it. */
  source: 'estimated' | 'provider-reported';
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

export interface AgentProviderContextUsage extends AgentContextUsageBase {
  source: 'provider-reported';
  /** Current context occupancy reported for the latest Codex turn, not lifetime usage. */
  currentTokens?: number;
  /** Codex model context window. Missing means the installed CLI has not reported it. */
  contextWindowTokens?: number;
  /** Current occupancy against the Codex model window. Missing is rendered as unknown. */
  percentage?: number;
}

export type AgentContextUsage = AgentEstimatedContextUsage | AgentProviderContextUsage;

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
  /** Ephemeral authority bound to this exact terminal runtime. */
  fullTakeover: boolean;
  /** Persistent Host hint only; never grants runtime authority. */
  fullTakeoverPreference: boolean;
  /** Explicit, in-memory permission for Generic Provider file tools. Never persisted. */
  fileAccessMode: AgentFileAccessMode;
  /** Optional for compatibility with persisted Alpha sessions and older render fixtures. */
  fileAccessPolicy?: AgentFileAccessPolicy;
  /** Canonical explicit Session Workspace Root captured when file access was enabled. */
  fileAccessRoot?: string;
  messages: AgentChatItem[];
  /** User-reviewed, bounded memories injected independently of summaries. */
  memories?: AgentMemoryCard[];
  /** Bounded, metadata-only summaries of recent tool use. */
  activities: AgentToolActivity[];
  /** Generic estimates or authoritative Codex provider-managed context state. */
  contextUsage?: AgentContextUsage;
  streamingMessageId?: string;
  /** Stable local turn identity for validating Assistant delta events. */
  streamingTurnId?: string;
  /** Last Assistant delta sequence already represented by this snapshot. */
  streamingSequence?: number;
  /** App Server interrupt is still draining; terminal input is human-owned but a new turn is unsafe. */
  backendTurnDraining?: boolean;
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
  resolveApproval: 'agent:resolve-approval',
  setFullTakeover: 'agent:set-full-takeover',
  setFullTakeoverPreference: 'agent:set-full-takeover-preference',
  setFileAccess: 'agent:set-file-access',
  takeover: 'agent:takeover',
  resolveTakeover: 'agent:resolve-takeover',
  confirmShellReady: 'agent:confirm-shell-ready',
  stateChanged: 'agent:state-changed',
  assistantDelta: 'agent:assistant-delta',
} as const;

export type { AgentMemoryCard, RemoveAgentMemoryRequest, SaveAgentMemoryRequest };
