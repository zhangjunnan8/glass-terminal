import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
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
import { basename, dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type {
  SessionAuditEvent,
  SessionNameSource,
  SessionRecord,
  TerminalJournalEvent,
} from '../../shared/session';
import type { AgentBackendRef } from '../../shared/agent';
import type { TerminalDescriptor } from '../../shared/terminal';

const LOG_SCHEMA_VERSION = 1;
const TARGET_CHUNK_BYTES = 64 * 1024;
const FLUSH_DELAY_MS = 200;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_SESSION_LOG_BYTES = 200 * 1024 * 1024;
const AUDIT_SEQUENCE_TAIL_BYTES = 256 * 1024;

interface LogChunk {
  sequence: number;
  file: string;
  createdAt: string;
  compressedBytes: number;
  uncompressedBytes: number;
}

interface LogIndex {
  version: 1;
  chunks: LogChunk[];
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
  return {
    ...(candidate as SessionRecord),
    targetSnapshot: candidate.targetSnapshot ?? { label: candidate.name },
  };
}

function jsonLines(events: TerminalJournalEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly pendingLogs = new Map<string, PendingLog>();
  private auditSequence = 0;

  constructor(private readonly rootPath: string) {
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
      const index: LogIndex = { version: LOG_SCHEMA_VERSION, chunks: [] };
      if (input.history.length) {
        index.chunks.push(this.writeChunkAt(creatingPath, 1, input.history));
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

  flush(sessionId: string): void {
    const pending = this.pendingLogs.get(sessionId);
    if (!pending || pending.events.length === 0) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingLogs.delete(sessionId);

    const index = this.readLogIndex(sessionId);
    const sequence = (index.chunks.at(-1)?.sequence ?? 0) + 1;
    index.chunks.push(this.writeChunkAt(this.sessionPath(sessionId), sequence, pending.events));
    this.applyRetention(this.get(sessionId), index);
    atomicWriteJson(this.logIndexPath(sessionId), index);
  }

  flushAll(): void {
    for (const sessionId of [...this.pendingLogs.keys()]) this.flush(sessionId);
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
    return this.readTerminalEvents(sessionId).map((event) => {
      if (event.kind === 'output') return event.data;
      if (event.kind === 'gap') {
        return `\r\n[Earlier terminal output truncated: ${event.droppedBytes} bytes]\r\n`;
      }
      return '';
    }).join('');
  }

  readRecentTerminalHistory(
    sessionId: string,
    maxCharacters = 120_000,
  ): { content: string; truncated: boolean } {
    this.get(sessionId);
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error('Invalid terminal history preview limit.');
    }
    this.flush(sessionId);
    const index = this.readLogIndex(sessionId);
    const pieces: string[] = [];
    let remaining = maxCharacters;
    let truncated = false;

    for (let chunkIndex = index.chunks.length - 1; chunkIndex >= 0; chunkIndex -= 1) {
      const chunk = index.chunks[chunkIndex]!;
      const compressed = readFileSync(this.safeChunkPath(sessionId, chunk.file));
      const events: TerminalJournalEvent[] = [];
      for (const line of gunzipSync(compressed).toString('utf8').split('\n')) {
        if (!line) continue;
        try {
          events.push(JSON.parse(line) as TerminalJournalEvent);
        } catch {
          // A corrupt partial line does not make the rest of the preview unreadable.
        }
      }
      const text = events.map((event) => {
        if (event.kind === 'output') return event.data;
        if (event.kind === 'gap') {
          return `\r\n[Earlier terminal output truncated: ${event.droppedBytes} bytes]\r\n`;
        }
        return '';
      }).join('');
      if (text.length > remaining) {
        pieces.unshift(text.slice(-remaining));
        truncated = true;
        remaining = 0;
        break;
      }
      pieces.unshift(text);
      remaining -= text.length;
      if (remaining === 0 && chunkIndex > 0) {
        truncated = true;
        break;
      }
    }

    return { content: pieces.join(''), truncated };
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

  bindAgentThread(sessionId: string, providerId: string, threadId: string): SessionRecord {
    return this.bindAgentBackendThread(
      sessionId,
      { kind: 'generic-provider', providerId },
      threadId,
    );
  }

  bindAgentBackendThread(
    sessionId: string,
    backend: AgentBackendRef,
    threadId: string,
  ): SessionRecord {
    const current = this.get(sessionId);
    const updated: SessionRecord = {
      ...current,
      aiThreadId: threadId,
      agentBackend: backend,
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
  ): LogChunk {
    const raw = Buffer.from(jsonLines(events), 'utf8');
    const compressed = gzipSync(raw);
    const file = `${String(sequence).padStart(8, '0')}-${randomUUID()}.jsonl.gz`;
    const path = join(sessionPath, 'terminal', file);
    writeFileSync(path, compressed, { mode: 0o600 });
    return {
      sequence,
      file,
      createdAt: new Date().toISOString(),
      compressedBytes: compressed.length,
      uncompressedBytes: raw.length,
    };
  }

  private readLogIndex(sessionId: string): LogIndex {
    const path = this.logIndexPath(sessionId);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LogIndex>;
    if (parsed.version !== LOG_SCHEMA_VERSION || !Array.isArray(parsed.chunks)) {
      throw new Error(`Unsupported terminal log index for Session ${sessionId}.`);
    }
    return parsed as LogIndex;
  }

  private applyRetention(session: SessionRecord, index: LogIndex): void {
    if (session.pinned) return;
    const cutoff = Date.now() - RETENTION_MS;
    let total = index.chunks.reduce((sum, chunk) => sum + chunk.compressedBytes, 0);
    while (index.chunks.length) {
      const oldest = index.chunks[0];
      const expired = Date.parse(oldest.createdAt) < cutoff;
      if (!expired && total <= MAX_SESSION_LOG_BYTES) break;
      index.chunks.shift();
      total -= oldest.compressedBytes;
      const path = this.safeChunkPath(session.id, oldest.file);
      if (existsSync(path)) unlinkSync(path);
    }
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
