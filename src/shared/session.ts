import type { TerminalDescriptor } from './terminal';
import type { AgentBackendRef, AgentChatItem } from './agent';

export type SessionNameSource = 'automatic' | 'manual';
export type SessionConnectionState = 'connected' | 'disconnected';
export type SessionStatus = 'active' | 'disconnected' | 'interrupted';

export type TerminalJournalEvent =
  | { version: 1; sequence: number; timestamp: string; kind: 'output'; data: string }
  | {
    version: 1;
    sequence: number;
    timestamp: string;
    kind: 'resize';
    cols: number;
    rows: number;
  }
  | {
    version: 1;
    sequence: number;
    timestamp: string;
    kind: 'gap';
    droppedBytes: number;
  }
  | {
    version: 1;
    sequence: number;
    timestamp: string;
    kind: 'exit';
    exitCode: number;
    signal?: number;
  };

export interface SessionRecord {
  schemaVersion: 1;
  id: string;
  name: string;
  nameSource: SessionNameSource;
  transport: TerminalDescriptor['transport'];
  hostId?: string;
  shellProfileId: string;
  shellKind: TerminalDescriptor['shellKind'];
  targetSnapshot: {
    label: string;
    hostname?: string;
    port?: number;
    username?: string;
  };
  connectionState: SessionConnectionState;
  status: SessionStatus;
  runtimeTerminalId: string;
  cwd?: string;
  effectiveUser?: string;
  aiThreadId?: string;
  agentBackend?: AgentBackendRef;
  providerThreadId?: string;
  /** @deprecated Kept for schema-v1 Generic Provider sessions. */
  providerId?: string;
  pinned: boolean;
  preludeTruncated: boolean;
  droppedPreludeBytes: number;
  startedAt: string;
  promotedAt: string;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string;
}

export interface SessionAuditEvent {
  version: 1;
  sequence: number;
  id: string;
  sessionId: string;
  type:
    | 'session_created'
    | 'session_renamed'
    | 'session_reconnected'
    | 'session_disconnected'
    | 'provider_changed'
    | 'command_requested'
    | 'command_approved'
    | 'command_edited'
    | 'command_rejected'
    | 'command_completed'
    | 'file_modified'
    | 'file_permission_changed'
    | 'agent_paused'
    | 'full_takeover_changed'
    | 'interactive_auth'
    | 'interactive_response'
    | 'codex_native_approval';
  actor: 'user' | 'system' | 'ai';
  timestamp: string;
  details: Record<string, unknown>;
}

export interface UpgradeSessionRequest {
  terminalId: string;
}

export interface RenameSessionRequest {
  sessionId: string;
  name: string;
  source?: SessionNameSource;
}

export interface ReadSessionHistoryDetailRequest {
  sessionId: string;
}

export interface DeleteSessionRequest {
  sessionId: string;
  /** Optimistic concurrency guard so a stale renderer cannot delete a changed Session. */
  expectedUpdatedAt: string;
  expectedRuntimeTerminalId: string;
}

export interface SessionHistoryDetail {
  session: SessionRecord;
  terminal: {
    content: string;
    truncated: boolean;
  };
  conversation: {
    messages: AgentChatItem[];
    truncated: boolean;
  };
}

export const SESSION_CHANNELS = {
  list: 'session:list',
  upgrade: 'session:upgrade-terminal',
  rename: 'session:rename',
  readTerminalHistory: 'session:read-terminal-history',
  readHistoryDetail: 'session:read-history-detail',
  remove: 'session:remove',
} as const;
