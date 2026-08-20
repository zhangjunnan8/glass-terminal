import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  readSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type {
  SessionAuditEvent,
  SessionNameSource,
  SessionRecord,
  TerminalJournalEvent,
} from '../../shared/session';
import type { AgentBackendRef } from '../../shared/agent';
import type { TerminalDescriptor } from '../../shared/terminal';
import type { WorkspaceBinding } from '../../shared/tools';
import {
  WorkspaceOperationJournal,
  type WorkspaceDiffArtifact,
  type WorkspaceOperationHandle,
  type WorkspaceOperationIntent,
  type WorkspaceOperationOutcome,
  type WorkspaceOperationRecord,
  type WorkspaceOperationRecovery,
  type WorkspaceOperationSource,
} from './workspace-operation-journal';

const LOG_SCHEMA_VERSION = 2;
const TARGET_CHUNK_BYTES = 64 * 1024;
const FLUSH_DELAY_MS = 200;
const MAX_SESSION_LOG_BYTES = 200 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const AUDIT_SEQUENCE_TAIL_BYTES = 256 * 1024;
const PROVIDER_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

interface LogChunk {
  sequence: number;
  file: string;
  createdAt: string;
  compressedBytes: number;
  uncompressedBytes: number;
  /** Absolute UTF-16 offsets in the user-visible terminal history. */
  historyStart: number;
  historyEnd: number;
}

interface LogIndex {
  version: 2;
  chunks: LogChunk[];
  /** Monotonic even when retention removes every currently indexed chunk. */
  nextHistoryPosition: number;
}

type LegacyLogChunk = Omit<LogChunk, 'historyStart' | 'historyEnd'>;

interface LegacyLogIndex {
  version: 1;
  chunks: LegacyLogChunk[];
}

export interface TerminalHistoryCursor {
  version: 1;
  /** Absolute UTF-16 position in the Session's visible terminal history. */
  position: number;
}

export interface TerminalHistorySlice {
  content: string;
  nextCursor: TerminalHistoryCursor;
  /** Some requested history was unavailable or omitted to honor maxCharacters. */
  truncated: boolean;
}

export interface SessionStoreOptions {
  terminalLogRetentionDays?: number;
  /** Test seam; production always uses the 200 MiB default. */
  maxTerminalLogBytes?: number;
}

interface PendingLog {
  events: TerminalJournalEvent[];
  bytes: number;
  timer?: NodeJS.Timeout;
}

interface FileTail {
  text: string;
  truncated: boolean;
}

function terminalEventText(event: TerminalJournalEvent): string {
  if (event.kind === 'output') return event.data;
  if (event.kind === 'gap') {
    return `\r\n[Earlier terminal output truncated: ${event.droppedBytes} bytes]\r\n`;
  }
  return '';
}

function validatedRetentionDays(days: number): number {
  if (!Number.isSafeInteger(days) || days < 0) {
    throw new Error('Terminal log retention days must be a non-negative integer.');
  }
  return days;
}

function validatedMaxLogBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error('Terminal log capacity must be a positive integer.');
  }
  return bytes;
}

function readUtf8FileTail(path: string, maxBytes: number): FileTail {
  const size = statSync(path).size;
  const offset = Math.max(0, size - maxBytes);
  const length = size - offset;
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(path, 'r');
  try {
    let totalRead = 0;
    while (totalRead < length) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        totalRead,
        length - totalRead,
        offset + totalRead,
      );
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    let text = buffer.subarray(0, totalRead).toString('utf8');
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return { text, truncated: offset > 0 };
  } finally {
    closeSync(descriptor);
  }
}

export interface CreateSessionInput {
  descriptor: TerminalDescriptor;
  startedAt: string;
  history: TerminalJournalEvent[];
  preludeTruncated: boolean;
  droppedPreludeBytes: number;
  effectiveUser?: string;
  cwd?: string;
  targetSnapshot?: SessionRecord['targetSnapshot'];
}

/** Main-process-only filesystem boundary that Workspace operations must never mutate. */
export interface SessionStorageProtection {
  /** Root containing every persisted Session, terminal journal, and Workspace audit. */
  root: string;
  /** Current Session's operation log, used to avoid self-targeting denial records. */
  operationJournalPath: string;
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function parseSession(value: unknown, source: string): SessionRecord {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid Session metadata in ${source}.`);
  }
  const candidate = value as Partial<SessionRecord>;
  if (
    candidate.schemaVersion !== 1
    || typeof candidate.id !== 'string'
    || typeof candidate.name !== 'string'
    || (candidate.transport !== 'local' && candidate.transport !== 'ssh')
    || typeof candidate.createdAt !== 'string'
    || typeof candidate.updatedAt !== 'string'
  ) {
    throw new Error(`Unsupported Session metadata in ${source}.`);
  }
  const record: SessionRecord = {
    ...(candidate as SessionRecord),
    targetSnapshot: candidate.targetSnapshot ?? { label: candidate.name },
  };
  record.agentBackendFingerprint = typeof candidate.agentBackendFingerprint === 'string'
    && PROVIDER_FINGERPRINT_PATTERN.test(candidate.agentBackendFingerprint)
    ? candidate.agentBackendFingerprint
    : undefined;
  record.workspace = validateWorkspaceBinding(record, candidate.workspace, source);
  return record;
}

/** Strict, side-effect-free Session metadata validation for staged backups. */
export function validateSessionBackupMetadata(value: unknown, source: string): SessionRecord {
  return parseSession(value, source);
}

function validateWorkspaceBinding(
  session: Pick<SessionRecord, 'transport' | 'hostId'>,
  value: unknown,
  source = 'Session',
): WorkspaceBinding | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid workspace binding in ${source}.`);
  }
  const workspace = value as Partial<WorkspaceBinding>;
  if (
    (workspace.backend !== 'local' && workspace.backend !== 'sftp')
    || typeof workspace.root !== 'string'
    || !workspace.root
    || (workspace.hostId !== undefined && typeof workspace.hostId !== 'string')
  ) throw new Error(`Invalid workspace binding in ${source}.`);

  if (session.transport === 'local') {
    if (
      workspace.backend !== 'local'
      || workspace.hostId !== undefined
      || !isAbsolute(workspace.root)
    ) {
      throw new Error('Local Session requires a local workspace without a host binding.');
    }
  } else if (
    !session.hostId
    || workspace.backend !== 'sftp'
    || workspace.hostId !== session.hostId
    || !posix.isAbsolute(workspace.root)
  ) {
    throw new Error('SSH Session requires an SFTP workspace bound to the same Host.');
  }
  return {
    backend: workspace.backend,
    root: workspace.root,
    ...(workspace.hostId === undefined ? {} : { hostId: workspace.hostId }),
  };
}

function jsonLines(events: TerminalJournalEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly pendingLogs = new Map<string, PendingLog>();
  private readonly workspaceOperations: WorkspaceOperationJournal;
  private terminalLogRetentionDays: number;
  private readonly maxTerminalLogBytes: number;
  private auditSequence = 0;

  constructor(
    private readonly rootPath: string,
    options: SessionStoreOptions = {},
  ) {
    this.terminalLogRetentionDays = validatedRetentionDays(
      options.terminalLogRetentionDays ?? 90,
    );
    this.maxTerminalLogBytes = validatedMaxLogBytes(
      options.maxTerminalLogBytes ?? MAX_SESSION_LOG_BYTES,
    );
    this.workspaceOperations = new WorkspaceOperationJournal(rootPath);
    this.load();
    this.markInterruptedSessions();
  }

  list(hostId?: string): SessionRecord[] {
    return [...this.sessions.values()]
      .filter((session) => hostId === undefined || session.hostId === hostId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  create(input: CreateSessionInput): SessionRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const record: SessionRecord = {
      schemaVersion: 1,
      id,
      name: input.descriptor.title,
      nameSource: 'automatic',
      transport: input.descriptor.transport,
      hostId: input.descriptor.hostId,
      shellProfileId: input.descriptor.profileId,
      shellKind: input.descriptor.shellKind,
      targetSnapshot: input.targetSnapshot ?? { label: input.descriptor.title },
      connectionState: 'connected',
      status: 'active',
      runtimeTerminalId: input.descriptor.id,
      cwd: input.cwd,
      effectiveUser: input.effectiveUser,
      pinned: false,
      preludeTruncated: input.preludeTruncated,
      droppedPreludeBytes: input.droppedPreludeBytes,
      startedAt: input.startedAt,
      promotedAt: now,
      createdAt: now,
      updatedAt: now,
      lastConnectedAt: now,
    };

    const creatingPath = join(this.rootPath, `.creating-${id}`);
    const finalPath = join(this.rootPath, id);
    mkdirSync(join(creatingPath, 'terminal'), { recursive: true });
    try {
      atomicWriteJson(join(creatingPath, 'session.json'), record);
      const index: LogIndex = {
        version: LOG_SCHEMA_VERSION,
        chunks: [],
        nextHistoryPosition: 0,
      };
      if (input.history.length) {
        const chunk = this.writeChunkAt(creatingPath, 1, input.history, 0);
        index.chunks.push(chunk);
        index.nextHistoryPosition = chunk.historyEnd;
      }
      atomicWriteJson(join(creatingPath, 'terminal', 'index.json'), index);
      const createdAudit: SessionAuditEvent = {
        version: 1,
        sequence: this.nextAuditSequence(),
        id: randomUUID(),
        sessionId: id,
        type: 'session_created',
        actor: 'user',
        timestamp: now,
        details: {
          runtimeTerminalId: input.descriptor.id,
          preludeEvents: input.history.length,
          preludeTruncated: input.preludeTruncated,
          droppedPreludeBytes: input.droppedPreludeBytes,
        },
      };
      appendFileSync(
        join(creatingPath, 'audit.jsonl'),
        `${JSON.stringify(createdAudit)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      mkdirSync(this.rootPath, { recursive: true });
      renameSync(creatingPath, finalPath);
    } catch (error) {
      if (existsSync(creatingPath)) rmSync(creatingPath, { recursive: true, force: true });
      throw error;
    }
    this.sessions.set(id, record);
    return record;
  }

  rename(sessionId: string, name: string, source: SessionNameSource): SessionRecord {
    const current = this.get(sessionId);
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Session name is required.');
    if (source === 'automatic' && current.nameSource === 'manual') return current;
    const updated: SessionRecord = {
      ...current,
      name: trimmed,
      nameSource: source,
      updatedAt: new Date().toISOString(),
    };
    this.save(updated);
    this.audit(updated.id, 'session_renamed', source === 'manual' ? 'user' : 'system', {
      previousName: current.name,
      name: updated.name,
      source,
    });
    return updated;
  }

  markConnected(sessionId: string, runtimeTerminalId: string): SessionRecord {
    const current = this.get(sessionId);
    const now = new Date().toISOString();
    const updated: SessionRecord = {
      ...current,
      runtimeTerminalId,
      connectionState: 'connected',
      status: 'active',
      updatedAt: now,
      lastConnectedAt: now,
    };
    this.save(updated);
    this.audit(sessionId, 'session_reconnected', 'user', { runtimeTerminalId });
    return updated;
  }

  updateShellContext(
    sessionId: string,
    context: { cwd?: string; effectiveUser?: string },
  ): SessionRecord {
    const current = this.get(sessionId);
    const cwd = context.cwd ?? current.cwd;
    const effectiveUser = context.effectiveUser ?? current.effectiveUser;
    if (cwd === current.cwd && effectiveUser === current.effectiveUser) return current;
    const updated: SessionRecord = {
      ...current,
      cwd,
      effectiveUser,
      updatedAt: new Date().toISOString(),
    };
    this.save(updated);
    return updated;
  }

  setWorkspace(
    sessionId: string,
    workspace: WorkspaceBinding | undefined,
  ): SessionRecord {
    const current = this.get(sessionId);
    const validatedWorkspace = validateWorkspaceBinding(current, workspace);
    if (
      current.workspace?.backend === validatedWorkspace?.backend
      && current.workspace?.root === validatedWorkspace?.root
      && current.workspace?.hostId === validatedWorkspace?.hostId
    ) return current;

    const updated: SessionRecord = {
      ...current,
      workspace: validatedWorkspace,
      updatedAt: new Date().toISOString(),
    };
    this.save(updated);
    this.audit(sessionId, 'workspace_changed', 'user', {
      previousWorkspace: current.workspace ? { ...current.workspace } : null,
      workspace: updated.workspace ? { ...updated.workspace } : null,
    });
    return updated;
  }

  markDisconnected(
    sessionId: string,
    exitCode: number,
    signal?: number,
  ): SessionRecord {
    const current = this.get(sessionId);
    if (current.connectionState === 'disconnected') return current;
    const updated: SessionRecord = {
      ...current,
      connectionState: 'disconnected',
      status: 'disconnected',
      updatedAt: new Date().toISOString(),
    };
    this.save(updated);
    this.audit(sessionId, 'session_disconnected', 'system', { exitCode, signal });
    this.flush(sessionId);
    return updated;
  }

  appendTerminalEvents(sessionId: string, events: TerminalJournalEvent[]): void {
    this.get(sessionId);
    if (!events.length) return;
    let pending = this.pendingLogs.get(sessionId);
    if (!pending) {
      pending = { events: [], bytes: 0 };
      this.pendingLogs.set(sessionId, pending);
    }
    for (const event of events) {
      pending.events.push(event);
      pending.bytes += Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
    }
    if (pending.bytes >= TARGET_CHUNK_BYTES) {
      this.flush(sessionId);
      return;
    }
    if (!pending.timer) {
      pending.timer = setTimeout(() => this.flush(sessionId), FLUSH_DELAY_MS);
      pending.timer.unref();
    }
  }

  flush(sessionId: string, enforceRetention = true): void {
    const pending = this.pendingLogs.get(sessionId);
    if (!pending || pending.events.length === 0) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingLogs.delete(sessionId);

    const index = this.readLogIndex(sessionId);
    const sequence = (index.chunks.at(-1)?.sequence ?? 0) + 1;
    const chunk = this.writeChunkAt(
      this.sessionPath(sessionId),
      sequence,
      pending.events,
      index.nextHistoryPosition,
    );
    index.chunks.push(chunk);
    index.nextHistoryPosition = chunk.historyEnd;
    if (enforceRetention) this.applyRetention(this.get(sessionId), index);
    atomicWriteJson(this.logIndexPath(sessionId), index);
  }

  flushAll(): void {
    for (const sessionId of [...this.pendingLogs.keys()]) this.flush(sessionId);
  }

  setTerminalLogRetentionDays(days: number): void {
    this.terminalLogRetentionDays = validatedRetentionDays(days);
  }

  /**
   * Applies terminal-only retention one chunk at a time. Each removal is
   * persisted before yielding so a concurrent journal append cannot be lost
   * through a stale index write. Other Session journals are never touched.
   */
  async enforceTerminalLogRetention(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      while (true) {
        this.flush(sessionId, false);
        const session = this.get(sessionId);
        if (session.pinned) break;
        const index = this.readLogIndex(sessionId);
        const total = index.chunks.reduce((sum, chunk) => sum + chunk.compressedBytes, 0);
        const oldest = index.chunks[0];
        if (!oldest || !this.shouldRemoveChunk(oldest, total)) break;
        index.chunks.shift();
        const chunkPath = this.safeChunkPath(session.id, oldest.file);
        if (existsSync(chunkPath)) unlinkSync(chunkPath);
        atomicWriteJson(this.logIndexPath(sessionId), index);
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      }
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    }
  }

  readTerminalEvents(sessionId: string): TerminalJournalEvent[] {
    this.flush(sessionId);
    const index = this.readLogIndex(sessionId);
    const events: TerminalJournalEvent[] = [];
    for (const chunk of index.chunks) {
      const compressed = readFileSync(this.safeChunkPath(sessionId, chunk.file));
      const lines = gunzipSync(compressed).toString('utf8').split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          events.push(JSON.parse(line) as TerminalJournalEvent);
        } catch {
          // A partial final line is ignored so a crash does not make older history unreadable.
        }
      }
    }
    return events;
  }

  readTerminalHistory(sessionId: string): string {
    return this.readTerminalEvents(sessionId).map(terminalEventText).join('');
  }

  readRecentTerminalHistory(
    sessionId: string,
    maxCharacters = 120_000,
  ): { content: string; truncated: boolean } {
    const result = this.readTerminalHistorySince(sessionId, undefined, maxCharacters);
    return { content: result.content, truncated: result.truncated };
  }

  currentTerminalHistoryCursor(sessionId: string): TerminalHistoryCursor {
    this.get(sessionId);
    this.flush(sessionId);
    const index = this.readLogIndex(sessionId);
    return { version: 1, position: index.nextHistoryPosition };
  }

  readTerminalHistorySince(
    sessionId: string,
    cursor?: TerminalHistoryCursor,
    maxCharacters = 120_000,
  ): TerminalHistorySlice {
    this.get(sessionId);
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error('Invalid terminal history preview limit.');
    }
    if (
      cursor !== undefined
      && (
        cursor.version !== 1
        || !Number.isSafeInteger(cursor.position)
        || cursor.position < 0
      )
    ) throw new Error('Invalid terminal history cursor.');

    this.flush(sessionId);
    const index = this.readLogIndex(sessionId);
    const end = index.nextHistoryPosition;
    if (cursor && cursor.position > end) {
      throw new Error('Terminal history cursor is ahead of the current Session history.');
    }

    const earliest = index.chunks[0]?.historyStart ?? end;
    let start = cursor?.position ?? Math.max(earliest, end - maxCharacters);
    let truncated = false;
    if (start < earliest) {
      start = earliest;
      truncated = true;
    }
    if (end - start > maxCharacters) {
      start = end - maxCharacters;
      truncated = true;
    }
    if (!cursor && start > earliest) truncated = true;

    const pieces: string[] = [];
    for (const chunk of index.chunks) {
      if (chunk.historyEnd <= start || chunk.historyStart >= end) continue;
      const text = this.readChunkText(sessionId, chunk);
      if (text.length !== chunk.historyEnd - chunk.historyStart) {
        throw new Error(`Terminal history index metadata mismatch for chunk ${chunk.sequence}.`);
      }
      const localStart = Math.max(0, start - chunk.historyStart);
      const localEnd = Math.min(text.length, end - chunk.historyStart);
      if (localEnd > localStart) pieces.push(text.slice(localStart, localEnd));
    }

    return {
      content: pieces.join(''),
      nextCursor: { version: 1, position: end },
      truncated,
    };
  }

  readAudit(sessionId: string): SessionAuditEvent[] {
    this.get(sessionId);
    const path = join(this.sessionPath(sessionId), 'audit.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SessionAuditEvent];
        } catch {
          return [];
        }
      });
  }

  bindAgentThread(
    sessionId: string,
    providerId: string,
    threadId: string,
    backendFingerprint: string,
  ): SessionRecord {
    return this.bindAgentBackendThread(
      sessionId,
      { kind: 'generic-provider', providerId },
      threadId,
      backendFingerprint,
    );
  }

  bindAgentBackendThread(
    sessionId: string,
    backend: AgentBackendRef,
    threadId: string,
    backendFingerprint?: string,
  ): SessionRecord {
    if (
      backend.kind === 'generic-provider'
      && (
        typeof backendFingerprint !== 'string'
        || !PROVIDER_FINGERPRINT_PATTERN.test(backendFingerprint)
      )
    ) throw new Error('Generic Provider thread requires a valid recipient fingerprint.');
    const current = this.get(sessionId);
    const updated: SessionRecord = {
      ...current,
      aiThreadId: threadId,
      agentBackend: backend,
      agentBackendFingerprint: backend.kind === 'generic-provider'
        ? backendFingerprint
        : undefined,
      providerThreadId: undefined,
      providerId: backend.kind === 'generic-provider' ? backend.providerId : undefined,
      updatedAt: new Date().toISOString(),
    };
    this.save(updated);
    mkdirSync(join(this.sessionPath(sessionId), 'ai'), { recursive: true });
    const threadPath = this.threadPath(sessionId, threadId);
    if (!existsSync(threadPath)) {
      writeFileSync(threadPath, '', { encoding: 'utf8', mode: 0o600 });
    }
    this.audit(sessionId, 'provider_changed', 'user', { backend, threadId });
    return updated;
  }

  bindProviderThread(
    sessionId: string,
    localThreadId: string,
    providerThreadId: string,
  ): SessionRecord {
    const current = this.get(sessionId);
    if (current.aiThreadId !== localThreadId) {
      throw new Error('AI Thread changed before the Provider thread could be bound.');
    }
    const updated: SessionRecord = {
      ...current,
      providerThreadId,
      updatedAt: new Date().toISOString(),
    };
    this.save(updated);
    return updated;
  }

  appendThreadEvent(
    sessionId: string,
    threadId: string,
    event: Record<string, unknown>,
  ): void {
    this.get(sessionId);
    appendFileSync(
      this.threadPath(sessionId, threadId),
      `${JSON.stringify(event)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  readThreadEvents(sessionId: string, threadId: string): Array<Record<string, unknown>> {
    this.get(sessionId);
    const path = this.threadPath(sessionId, threadId);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  }

  readRecentThreadEvents(
    sessionId: string,
    threadId: string,
    maxBytes = 2 * 1024 * 1024,
  ): { events: Array<Record<string, unknown>>; truncated: boolean } {
    this.get(sessionId);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('Invalid AI conversation preview limit.');
    }
    const path = this.threadPath(sessionId, threadId);
    if (!existsSync(path)) return { events: [], truncated: false };
    const tail = readUtf8FileTail(path, maxBytes);
    const events = tail.text.split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    return { events, truncated: tail.truncated };
  }

  async remove(sessionId: string): Promise<void> {
    const session = this.get(sessionId);
    if (session.connectionState === 'connected' || session.status === 'active') {
      throw new Error('活动或正在运行的会话不能删除，请先关闭对应终端。');
    }
    if (!/^[0-9a-f-]{36}$/i.test(session.id) || session.id !== sessionId) {
      throw new Error('Invalid Session identifier.');
    }
    this.flush(sessionId);

    const sourcePath = this.sessionPath(sessionId);
    const root = resolve(this.rootPath);
    if (dirname(sourcePath) !== root || basename(sourcePath) !== sessionId) {
      throw new Error('Invalid Session deletion path.');
    }
    const deletingName = `.deleting-${sessionId}-${randomUUID()}`;
    const deletingPath = resolve(root, deletingName);
    if (dirname(deletingPath) !== root || basename(deletingPath) !== deletingName) {
      throw new Error('Invalid Session deletion path.');
    }

    renameSync(sourcePath, deletingPath);
    this.sessions.delete(sessionId);
    try {
      await rm(deletingPath, {
        recursive: true,
        force: false,
        maxRetries: 2,
        retryDelay: 50,
      });
    } catch (error) {
      try {
        renameSync(deletingPath, sourcePath);
        this.sessions.set(sessionId, session);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          '删除会话失败，且无法自动恢复已隔离的会话目录。',
        );
      }
      throw error;
    }
  }

  appendAudit(
    sessionId: string,
    type: SessionAuditEvent['type'],
    actor: SessionAuditEvent['actor'],
    details: Record<string, unknown>,
  ): void {
    this.get(sessionId);
    this.audit(sessionId, type, actor, details);
  }

  beginWorkspaceOperation(
    sessionId: string,
    intent: WorkspaceOperationIntent,
    diff?: WorkspaceDiffArtifact,
    source?: WorkspaceOperationSource,
  ): WorkspaceOperationHandle {
    this.get(sessionId);
    return this.workspaceOperations.begin(sessionId, intent, diff, source);
  }

  finishWorkspaceOperation(
    handle: WorkspaceOperationHandle,
    outcome: WorkspaceOperationOutcome,
  ): void {
    this.get(handle.sessionId);
    this.workspaceOperations.finish(handle, outcome);
  }

  readWorkspaceOperations(sessionId: string): WorkspaceOperationRecord[] {
    this.get(sessionId);
    return this.workspaceOperations.read(sessionId);
  }

  recoverWorkspaceOperations(sessionId: string): WorkspaceOperationRecovery[] {
    this.get(sessionId);
    return this.workspaceOperations.recover(sessionId);
  }

  workspaceStorageProtection(sessionId: string): SessionStorageProtection {
    this.get(sessionId);
    // Full Access may address the same storage through a different lexical
    // spelling (for example, a junction/symlink ancestor). Always publish the
    // physical root used by the OS so AgentFileService compares aliases in one
    // canonical coordinate space. A missing/unresolvable root is fail-closed.
    const root = realpathSync(resolve(this.rootPath));
    if (!statSync(root).isDirectory()) {
      throw new Error('Session storage protection root is not a directory.');
    }
    return {
      root,
      operationJournalPath: join(
        root,
        sessionId,
        'workspace',
        'operations.jsonl',
      ),
    };
  }

  private load(): void {
    if (!existsSync(this.rootPath)) return;
    for (const entry of readdirSync(this.rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.creating-')) continue;
      const metadataPath = join(this.rootPath, entry.name, 'session.json');
      if (!existsSync(metadataPath)) continue;
      const record = parseSession(JSON.parse(readFileSync(metadataPath, 'utf8')), metadataPath);
      if (record.id !== entry.name) {
        throw new Error(`Session directory does not match metadata: ${entry.name}`);
      }
      this.sessions.set(record.id, record);
      this.auditSequence = Math.max(
        this.auditSequence,
        this.readLastAuditSequence(record.id),
      );
    }
  }

  private markInterruptedSessions(): void {
    for (const session of this.sessions.values()) {
      if (session.status !== 'active') continue;
      const updated: SessionRecord = {
        ...session,
        status: 'interrupted',
        connectionState: 'disconnected',
        updatedAt: new Date().toISOString(),
      };
      this.save(updated);
      this.audit(session.id, 'session_disconnected', 'system', {
        reason: 'application_restarted',
      });
    }
  }

  private save(record: SessionRecord): void {
    this.sessions.set(record.id, record);
    atomicWriteJson(join(this.sessionPath(record.id), 'session.json'), record);
  }

  private audit(
    sessionId: string,
    type: SessionAuditEvent['type'],
    actor: SessionAuditEvent['actor'],
    details: Record<string, unknown>,
  ): void {
    const event: SessionAuditEvent = {
      version: 1,
      sequence: this.nextAuditSequence(),
      id: randomUUID(),
      sessionId,
      type,
      actor,
      timestamp: new Date().toISOString(),
      details,
    };
    appendFileSync(
      join(this.sessionPath(sessionId), 'audit.jsonl'),
      `${JSON.stringify(event)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  private nextAuditSequence(): number {
    this.auditSequence += 1;
    return this.auditSequence;
  }

  private readLastAuditSequence(sessionId: string): number {
    const path = join(this.sessionPath(sessionId), 'audit.jsonl');
    if (!existsSync(path)) return 0;
    const size = statSync(path).size;
    let windowBytes = Math.min(size, AUDIT_SEQUENCE_TAIL_BYTES);
    while (windowBytes > 0) {
      const tail = readUtf8FileTail(path, windowBytes);
      const lines = tail.text.split('\n');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line) continue;
        try {
          const event = JSON.parse(line) as Partial<SessionAuditEvent>;
          if (Number.isSafeInteger(event.sequence) && (event.sequence ?? 0) >= 0) {
            return event.sequence!;
          }
        } catch {
          // Ignore corrupt or partial records and continue backwards.
        }
      }
      if (!tail.truncated) break;
      windowBytes = Math.min(size, windowBytes * 2);
    }
    return 0;
  }

  private writeChunkAt(
    sessionPath: string,
    sequence: number,
    events: TerminalJournalEvent[],
    historyStart: number,
  ): LogChunk {
    const raw = Buffer.from(jsonLines(events), 'utf8');
    const compressed = gzipSync(raw);
    const file = `${String(sequence).padStart(8, '0')}-${randomUUID()}.jsonl.gz`;
    const path = join(sessionPath, 'terminal', file);
    writeFileSync(path, compressed, { mode: 0o600 });
    const historyCharacters = events.reduce(
      (total, event) => total + terminalEventText(event).length,
      0,
    );
    return {
      sequence,
      file,
      createdAt: new Date().toISOString(),
      compressedBytes: compressed.length,
      uncompressedBytes: raw.length,
      historyStart,
      historyEnd: historyStart + historyCharacters,
    };
  }

  private readLogIndex(sessionId: string): LogIndex {
    const path = this.logIndexPath(sessionId);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LogIndex | LegacyLogIndex>;
    if (!Array.isArray(parsed.chunks)) {
      throw new Error(`Unsupported terminal log index for Session ${sessionId}.`);
    }
    if (parsed.version === LOG_SCHEMA_VERSION) {
      const index = parsed as LogIndex;
      if (!Number.isSafeInteger(index.nextHistoryPosition) || index.nextHistoryPosition < 0) {
        throw new Error(`Invalid terminal history position for Session ${sessionId}.`);
      }
      let previousEnd = index.chunks[0]?.historyStart ?? index.nextHistoryPosition;
      for (const chunk of index.chunks) {
        if (
          !Number.isSafeInteger(chunk.historyStart)
          || !Number.isSafeInteger(chunk.historyEnd)
          || chunk.historyStart !== previousEnd
          || chunk.historyEnd < chunk.historyStart
          || chunk.historyEnd > index.nextHistoryPosition
        ) throw new Error(`Invalid terminal chunk history metadata for Session ${sessionId}.`);
        previousEnd = chunk.historyEnd;
      }
      if (previousEnd !== index.nextHistoryPosition) {
        throw new Error(`Invalid terminal history extent for Session ${sessionId}.`);
      }
      return index;
    }
    if (parsed.version !== 1) {
      throw new Error(`Unsupported terminal log index for Session ${sessionId}.`);
    }

    let position = 0;
    const chunks = (parsed as LegacyLogIndex).chunks.map((legacy): LogChunk => {
      const text = this.readLegacyChunkText(sessionId, legacy);
      const chunk: LogChunk = {
        ...legacy,
        historyStart: position,
        historyEnd: position + text.length,
      };
      position = chunk.historyEnd;
      return chunk;
    });
    const migrated: LogIndex = {
      version: LOG_SCHEMA_VERSION,
      chunks,
      nextHistoryPosition: position,
    };
    atomicWriteJson(path, migrated);
    return migrated;
  }

  private readChunkText(sessionId: string, chunk: LogChunk): string {
    return this.readLegacyChunkText(sessionId, chunk);
  }

  private readLegacyChunkText(sessionId: string, chunk: LegacyLogChunk): string {
    const compressed = readFileSync(this.safeChunkPath(sessionId, chunk.file));
    const pieces: string[] = [];
    for (const line of gunzipSync(compressed).toString('utf8').split('\n')) {
      if (!line) continue;
      try {
        pieces.push(terminalEventText(JSON.parse(line) as TerminalJournalEvent));
      } catch {
        // A corrupt partial final record does not make earlier history unreadable.
      }
    }
    return pieces.join('');
  }

  private applyRetention(session: SessionRecord, index: LogIndex): void {
    if (session.pinned) return;
    let total = index.chunks.reduce((sum, chunk) => sum + chunk.compressedBytes, 0);
    while (index.chunks.length) {
      const oldest = index.chunks[0];
      if (!this.shouldRemoveChunk(oldest, total)) break;
      index.chunks.shift();
      total -= oldest.compressedBytes;
      const path = this.safeChunkPath(session.id, oldest.file);
      if (existsSync(path)) unlinkSync(path);
    }
  }

  private shouldRemoveChunk(chunk: LogChunk, totalCompressedBytes: number): boolean {
    const createdAt = Date.parse(chunk.createdAt);
    const expired = this.terminalLogRetentionDays > 0
      && Number.isFinite(createdAt)
      && createdAt < Date.now() - this.terminalLogRetentionDays * DAY_MS;
    return expired || totalCompressedBytes > this.maxTerminalLogBytes;
  }

  private sessionPath(sessionId: string): string {
    if (!this.sessions.has(sessionId) && !/^[0-9a-f-]{36}$/i.test(sessionId)) {
      throw new Error('Invalid Session identifier.');
    }
    const path = resolve(this.rootPath, sessionId);
    if (dirname(path) !== resolve(this.rootPath)) throw new Error('Invalid Session path.');
    return path;
  }

  private logIndexPath(sessionId: string): string {
    return join(this.sessionPath(sessionId), 'terminal', 'index.json');
  }

  private safeChunkPath(sessionId: string, file: string): string {
    if (basename(file) !== file) throw new Error('Invalid terminal log chunk path.');
    return join(this.sessionPath(sessionId), 'terminal', file);
  }

  private threadPath(sessionId: string, threadId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error('Invalid AI Thread identifier.');
    return join(this.sessionPath(sessionId), 'ai', `${threadId}.jsonl`);
  }
}
