import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const JOURNAL_VERSION = 1 as const;
const DEFAULT_MAX_RECORD_BYTES = 32 * 1024;
const DEFAULT_MAX_DIFF_BYTES = 64 * 1024;
const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_WORKSPACE_PATH_CHARACTERS = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const WORKSPACE_OPERATION_JOURNAL_LIMITS = {
  maxRecordBytes: DEFAULT_MAX_RECORD_BYTES,
  maxDiffBytes: DEFAULT_MAX_DIFF_BYTES,
  maxLogBytes: DEFAULT_MAX_LOG_BYTES,
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
} as const;

export type WorkspaceOperation =
  | 'list'
  | 'read'
  | 'stat'
  | 'search'
  | 'glob'
  | 'write'
  | 'patch'
  | 'mkdir'
  | 'rename'
  | 'delete';

export type WorkspaceOperationBackend = 'local' | 'sftp';
export type WorkspaceOperationSource = 'agent_file_service' | 'policy_workspace_tool';

export type WorkspaceOperationPathScope =
  | 'workspace'
  | 'authorized'
  | 'filesystem'
  | 'rejected';

export type WorkspaceOperationCanonicalPath =
  | {
      scope: 'workspace';
      /** Canonical Workspace-relative path; never absolute or `..`. */
      path: string;
    }
  | {
      scope: 'authorized' | 'filesystem';
      /** Canonical scope-relative path; never absolute or `..`. */
      path: string;
      /** Opaque SHA-256 of the canonical scope root. */
      rootId: string;
    }
  | {
      scope: 'rejected';
      /** Bounded one-way identity for an unsafe spelling that cannot be canonicalized. */
      pathHash: string;
    };

export type WorkspaceOperationTarget =
  | { path: WorkspaceOperationCanonicalPath }
  | {
      source: WorkspaceOperationCanonicalPath;
      destination: WorkspaceOperationCanonicalPath;
    };

export interface WorkspaceOperationExpectedState {
  exists: boolean;
  type?: 'file' | 'directory';
  sha256?: string;
}

export interface WorkspaceOperationIntent {
  operation: WorkspaceOperation;
  backend: WorkspaceOperationBackend;
  target: WorkspaceOperationTarget;
  expected?: WorkspaceOperationExpectedState;
  recursive?: boolean;
  plan?: { items: number };
}

export interface WorkspaceDiffArtifact {
  /**
   * The bounded unified-diff body is written only to the protected artifact.
   * It is never copied into operations.jsonl.
   */
  body: string;
  additions: number;
  deletions: number;
  truncated: boolean;
}

export interface WorkspaceDiffReference {
  id: string;
  sha256: string;
  bytes: number;
  additions: number;
  deletions: number;
  truncated: boolean;
}

export interface WorkspaceOperationEffect {
  afterSha256?: string;
  bytes?: number;
  created?: boolean;
  count?: number;
  truncated?: boolean;
  itemsPlanned?: number;
  itemsCommitted?: number;
}

export interface WorkspaceOperationFailure {
  code:
    | 'conflict'
    | 'permission'
    | 'not_found'
    | 'quota'
    | 'io'
    | 'remote_disconnected'
    | 'unknown';
  stage: 'prepare' | 'dispatch' | 'commit' | 'cleanup' | 'outcome';
  retrySafe: boolean;
}

export interface WorkspaceOperationOutcome {
  outcome: 'succeeded' | 'failed';
  sideEffectCommitted: boolean | null;
  effect?: WorkspaceOperationEffect;
  failure?: WorkspaceOperationFailure;
}

export interface WorkspaceOperationHandle {
  sessionId: string;
  operationId: string;
  intentSequence: number;
}

interface WorkspaceOperationRecordBase {
  version: typeof JOURNAL_VERSION;
  sequence: number;
  operationId: string;
  sessionId: string;
  timestamp: string;
}

export interface WorkspaceOperationIntentRecord
  extends WorkspaceOperationRecordBase, WorkspaceOperationIntent {
  recordType: 'intent';
  actor: 'ai';
  source: WorkspaceOperationSource;
  diff?: WorkspaceDiffReference;
}

export interface WorkspaceOperationOutcomeRecord
  extends WorkspaceOperationRecordBase, WorkspaceOperationOutcome {
  recordType: 'outcome';
}

export type WorkspaceOperationRecord =
  | WorkspaceOperationIntentRecord
  | WorkspaceOperationOutcomeRecord;

export interface WorkspaceOperationRecovery {
  intent: WorkspaceOperationIntentRecord;
  outcome: WorkspaceOperationOutcomeRecord | null;
  sideEffectCommitted: boolean | null;
}

export interface WorkspaceOperationJournalOptions {
  /** Tests may lower limits, but production callers cannot raise the hard bounds. */
  maxRecordBytes?: number;
  maxDiffBytes?: number;
  maxLogBytes?: number;
  maxTotalBytes?: number;
}

interface JournalLimits {
  maxRecordBytes: number;
  maxDiffBytes: number;
  maxLogBytes: number;
  maxTotalBytes: number;
}

interface SessionJournalState {
  records: WorkspaceOperationRecord[];
  openIntents: Map<string, WorkspaceOperationIntentRecord>;
  operationIds: Set<string>;
  nextSequence: number;
  logBytes: number;
  diffBytes: number;
}

class WorkspaceJournalUncertainAppendError extends Error {
  constructor(cause: unknown, recoveryError?: unknown) {
    super('Workspace journal append could not be durably committed or rolled back.', {
      cause: recoveryError === undefined ? cause : new AggregateError([cause, recoveryError]),
    });
    this.name = 'WorkspaceJournalUncertainAppendError';
  }
}

const OPERATIONS = new Set<WorkspaceOperation>([
  'list',
  'read',
  'stat',
  'search',
  'glob',
  'write',
  'patch',
  'mkdir',
  'rename',
  'delete',
]);
const MUTATIONS = new Set<WorkspaceOperation>([
  'write',
  'patch',
  'mkdir',
  'rename',
  'delete',
]);
const DIFF_OPERATIONS = new Set<WorkspaceOperation>(['write', 'patch']);
const FAILURE_CODES = new Set<WorkspaceOperationFailure['code']>([
  'conflict',
  'permission',
  'not_found',
  'quota',
  'io',
  'remote_disconnected',
  'unknown',
]);
const FAILURE_STAGES = new Set<WorkspaceOperationFailure['stage']>([
  'prepare',
  'dispatch',
  'commit',
  'cleanup',
  'outcome',
]);
const OPERATION_SOURCES = new Set<WorkspaceOperationSource>([
  'agent_file_service',
  'policy_workspace_tool',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be a plain object.`);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new Error(`${label} contains an unsupported field: ${unexpected}.`);
}

function assertSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID.`);
  }
}

function assertTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) throw new Error('Workspace operation timestamp is invalid.');
}

function assertRelativePath(
  value: unknown,
  backend: WorkspaceOperationBackend,
  allowRoot: boolean,
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_WORKSPACE_PATH_CHARACTERS
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error(`${label} is not a bounded canonical workspace-relative path.`);
  if (value === '.') {
    if (allowRoot) return;
    throw new Error(`${label} cannot address the Workspace Root.`);
  }
  if (
    value.startsWith('/')
    || value.endsWith('/')
    || value.includes('//')
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) throw new Error(`${label} is not a canonical workspace-relative path.`);
  if (
    backend === 'local'
    && process.platform === 'win32'
    && (value.includes('\\') || value.includes(':') || /^[a-z]:/i.test(value))
  ) throw new Error(`${label} is not a safe Windows workspace-relative path.`);
}

function normalizeCanonicalPath(
  value: unknown,
  backend: WorkspaceOperationBackend,
  mutation: boolean,
  label: string,
): WorkspaceOperationCanonicalPath {
  assertRecord(value, label);
  assertExactKeys(value, ['scope', 'path', 'rootId', 'pathHash'], label);
  if (
    value.scope !== 'workspace'
    && value.scope !== 'authorized'
    && value.scope !== 'filesystem'
    && value.scope !== 'rejected'
  ) throw new Error(`${label} scope is invalid.`);
  if (value.scope === 'rejected') {
    if (
      typeof value.pathHash !== 'string'
      || !SHA256_PATTERN.test(value.pathHash)
      || value.path !== undefined
      || value.rootId !== undefined
    ) throw new Error(`${label} rejected path requires only an opaque SHA-256 pathHash.`);
    return { scope: 'rejected', pathHash: value.pathHash };
  }
  if (value.pathHash !== undefined) throw new Error(`${label} canonical path cannot contain pathHash.`);
  const allowRoot = !mutation || value.scope === 'authorized';
  assertRelativePath(value.path, backend, allowRoot, `${label} path`);
  if (value.scope === 'workspace') {
    if (value.rootId !== undefined) throw new Error(`${label} Workspace path cannot contain rootId.`);
    return { scope: value.scope, path: value.path };
  }
  if (typeof value.rootId !== 'string' || !SHA256_PATTERN.test(value.rootId)) {
    throw new Error(`${label} non-Workspace path requires an opaque SHA-256 rootId.`);
  }
  return { scope: value.scope, path: value.path, rootId: value.rootId };
}

function normalizeExpected(value: unknown): WorkspaceOperationExpectedState {
  assertRecord(value, 'Workspace expected state');
  assertExactKeys(value, ['exists', 'type', 'sha256'], 'Workspace expected state');
  if (typeof value.exists !== 'boolean') throw new Error('Expected exists flag is invalid.');
  if (value.type !== undefined && value.type !== 'file' && value.type !== 'directory') {
    throw new Error('Expected type is invalid.');
  }
  if (
    value.sha256 !== undefined
    && (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256))
  ) throw new Error('Expected SHA-256 is invalid.');
  return {
    exists: value.exists,
    ...(value.type === undefined ? {} : { type: value.type }),
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256 }),
  };
}

function normalizeIntent(value: unknown): WorkspaceOperationIntent {
  assertRecord(value, 'Workspace operation intent');
  assertExactKeys(
    value,
    ['operation', 'backend', 'target', 'expected', 'recursive', 'plan'],
    'Workspace operation intent',
  );
  if (typeof value.operation !== 'string' || !OPERATIONS.has(value.operation as WorkspaceOperation)) {
    throw new Error('Workspace operation is invalid.');
  }
  if (value.backend !== 'local' && value.backend !== 'sftp') {
    throw new Error('Workspace operation backend is invalid.');
  }
  const operation = value.operation as WorkspaceOperation;
  const backend = value.backend;
  const mutation = MUTATIONS.has(operation);
  assertRecord(value.target, 'Workspace operation target');
  let target: WorkspaceOperationTarget;
  if (operation === 'rename') {
    assertExactKeys(value.target, ['source', 'destination'], 'Workspace rename target');
    target = {
      source: normalizeCanonicalPath(
        value.target.source,
        backend,
        true,
        'Workspace rename source',
      ),
      destination: normalizeCanonicalPath(
        value.target.destination,
        backend,
        true,
        'Workspace rename destination',
      ),
    };
  } else {
    assertExactKeys(value.target, ['path'], 'Workspace operation target');
    target = {
      path: normalizeCanonicalPath(
        value.target.path,
        backend,
        mutation,
        'Workspace operation path',
      ),
    };
  }

  if (!mutation && (
    value.expected !== undefined
    || value.recursive !== undefined
    || value.plan !== undefined
  )) throw new Error('Read-only workspace operations cannot contain mutation state.');
  const expected = value.expected === undefined ? undefined : normalizeExpected(value.expected);
  if (value.recursive !== undefined && (operation !== 'delete' || typeof value.recursive !== 'boolean')) {
    throw new Error('Recursive is valid only for delete operations.');
  }
  let plan: { items: number } | undefined;
  if (value.plan !== undefined) {
    if (operation !== 'delete') throw new Error('A delete plan is valid only for delete operations.');
    assertRecord(value.plan, 'Workspace delete plan');
    assertExactKeys(value.plan, ['items'], 'Workspace delete plan');
    assertSafeInteger(value.plan.items, 'Workspace delete plan items');
    plan = { items: value.plan.items };
  }
  return {
    operation,
    backend,
    target,
    ...(expected === undefined ? {} : { expected }),
    ...(value.recursive === undefined ? {} : { recursive: value.recursive as boolean }),
    ...(plan === undefined ? {} : { plan }),
  };
}

function normalizeDiffArtifact(value: unknown): WorkspaceDiffArtifact {
  assertRecord(value, 'Workspace diff artifact');
  assertExactKeys(value, ['body', 'additions', 'deletions', 'truncated'], 'Workspace diff artifact');
  if (typeof value.body !== 'string') throw new Error('Workspace diff body must be text.');
  assertSafeInteger(value.additions, 'Workspace diff additions');
  assertSafeInteger(value.deletions, 'Workspace diff deletions');
  if (typeof value.truncated !== 'boolean') throw new Error('Workspace diff truncated flag is invalid.');
  return {
    body: value.body,
    additions: value.additions,
    deletions: value.deletions,
    truncated: value.truncated,
  };
}

function normalizeEffect(value: unknown): WorkspaceOperationEffect {
  assertRecord(value, 'Workspace operation effect');
  assertExactKeys(
    value,
    [
      'afterSha256',
      'bytes',
      'created',
      'count',
      'truncated',
      'itemsPlanned',
      'itemsCommitted',
    ],
    'Workspace operation effect',
  );
  if (
    value.afterSha256 !== undefined
    && (typeof value.afterSha256 !== 'string' || !SHA256_PATTERN.test(value.afterSha256))
  ) throw new Error('Workspace outcome SHA-256 is invalid.');
  for (const key of ['bytes', 'count', 'itemsPlanned', 'itemsCommitted'] as const) {
    if (value[key] !== undefined) assertSafeInteger(value[key], `Workspace outcome ${key}`);
  }
  if (value.created !== undefined && typeof value.created !== 'boolean') {
    throw new Error('Workspace outcome created flag is invalid.');
  }
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') {
    throw new Error('Workspace outcome truncated flag is invalid.');
  }
  if (
    typeof value.itemsPlanned === 'number'
    && typeof value.itemsCommitted === 'number'
    && value.itemsCommitted > value.itemsPlanned
  ) throw new Error('Committed delete items cannot exceed the plan.');
  return {
    ...(value.afterSha256 === undefined ? {} : { afterSha256: value.afterSha256 }),
    ...(value.bytes === undefined ? {} : { bytes: value.bytes as number }),
    ...(value.created === undefined ? {} : { created: value.created as boolean }),
    ...(value.count === undefined ? {} : { count: value.count as number }),
    ...(value.truncated === undefined ? {} : { truncated: value.truncated as boolean }),
    ...(value.itemsPlanned === undefined ? {} : { itemsPlanned: value.itemsPlanned as number }),
    ...(value.itemsCommitted === undefined ? {} : { itemsCommitted: value.itemsCommitted as number }),
  };
}

function normalizeFailure(value: unknown): WorkspaceOperationFailure {
  assertRecord(value, 'Workspace operation failure');
  assertExactKeys(value, ['code', 'stage', 'retrySafe'], 'Workspace operation failure');
  if (typeof value.code !== 'string' || !FAILURE_CODES.has(value.code as WorkspaceOperationFailure['code'])) {
    throw new Error('Workspace failure code is invalid.');
  }
  if (
    typeof value.stage !== 'string'
    || !FAILURE_STAGES.has(value.stage as WorkspaceOperationFailure['stage'])
  ) throw new Error('Workspace failure stage is invalid.');
  if (typeof value.retrySafe !== 'boolean') throw new Error('Workspace retry-safe flag is invalid.');
  return {
    code: value.code as WorkspaceOperationFailure['code'],
    stage: value.stage as WorkspaceOperationFailure['stage'],
    retrySafe: value.retrySafe,
  };
}

function normalizeOutcome(
  value: unknown,
  operation: WorkspaceOperation,
): WorkspaceOperationOutcome {
  assertRecord(value, 'Workspace operation outcome');
  assertExactKeys(
    value,
    ['outcome', 'sideEffectCommitted', 'effect', 'failure'],
    'Workspace operation outcome',
  );
  if (value.outcome !== 'succeeded' && value.outcome !== 'failed') {
    throw new Error('Workspace operation outcome is invalid.');
  }
  if (
    value.sideEffectCommitted !== true
    && value.sideEffectCommitted !== false
    && value.sideEffectCommitted !== null
  ) throw new Error('Workspace side-effect state is invalid.');
  const mutation = MUTATIONS.has(operation);
  if (!mutation && value.sideEffectCommitted !== false) {
    throw new Error('Read-only operations must report sideEffectCommitted=false.');
  }
  if (mutation && value.outcome === 'succeeded' && value.sideEffectCommitted !== true) {
    throw new Error('Successful mutations must report a committed side effect.');
  }
  const effect = value.effect === undefined ? undefined : normalizeEffect(value.effect);
  const failure = value.failure === undefined ? undefined : normalizeFailure(value.failure);
  if (value.outcome === 'succeeded' && failure !== undefined) {
    throw new Error('Successful workspace operations cannot contain failure metadata.');
  }
  if (value.outcome === 'failed' && failure === undefined) {
    throw new Error('Failed workspace operations require bounded failure metadata.');
  }
  if (
    mutation
    && value.outcome === 'failed'
    && value.sideEffectCommitted !== false
    && failure?.retrySafe !== false
  ) throw new Error('Committed or ambiguous mutations cannot be marked retry-safe.');
  return {
    outcome: value.outcome,
    sideEffectCommitted: value.sideEffectCommitted,
    ...(effect === undefined ? {} : { effect }),
    ...(failure === undefined ? {} : { failure }),
  };
}

function normalizeDiffReference(value: unknown): WorkspaceDiffReference {
  assertRecord(value, 'Workspace diff reference');
  assertExactKeys(
    value,
    ['id', 'sha256', 'bytes', 'additions', 'deletions', 'truncated'],
    'Workspace diff reference',
  );
  assertUuid(value.id, 'Workspace diff identifier');
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error('Workspace diff SHA-256 is invalid.');
  }
  assertSafeInteger(value.bytes, 'Workspace diff bytes');
  assertSafeInteger(value.additions, 'Workspace diff additions');
  assertSafeInteger(value.deletions, 'Workspace diff deletions');
  if (typeof value.truncated !== 'boolean') throw new Error('Workspace diff truncated flag is invalid.');
  return {
    id: value.id,
    sha256: value.sha256,
    bytes: value.bytes,
    additions: value.additions,
    deletions: value.deletions,
    truncated: value.truncated,
  };
}

function validateBaseRecord(
  value: Record<string, unknown>,
  sessionId: string,
): WorkspaceOperationRecordBase {
  if (value.version !== JOURNAL_VERSION) throw new Error('Unsupported workspace journal version.');
  assertSafeInteger(value.sequence, 'Workspace operation sequence');
  if (value.sequence < 1) throw new Error('Workspace operation sequence must be positive.');
  assertUuid(value.operationId, 'Workspace operation identifier');
  assertUuid(value.sessionId, 'Workspace operation Session identifier');
  if (value.sessionId !== sessionId) throw new Error('Workspace operation Session does not match its journal.');
  assertTimestamp(value.timestamp);
  return {
    version: JOURNAL_VERSION,
    sequence: value.sequence,
    operationId: value.operationId,
    sessionId: value.sessionId,
    timestamp: value.timestamp,
  };
}

function parsePersistedRecord(value: unknown, sessionId: string): WorkspaceOperationRecord {
  assertRecord(value, 'Workspace operation record');
  const commonKeys = ['version', 'sequence', 'recordType', 'operationId', 'sessionId', 'timestamp'];
  if (value.recordType === 'intent') {
    assertExactKeys(
      value,
      [
        ...commonKeys,
        'actor',
        'source',
        'operation',
        'backend',
        'target',
        'expected',
        'recursive',
        'plan',
        'diff',
      ],
      'Workspace intent record',
    );
    if (
      value.actor !== 'ai'
      || typeof value.source !== 'string'
      || !OPERATION_SOURCES.has(value.source as WorkspaceOperationSource)
    ) {
      throw new Error('Workspace intent provenance is invalid.');
    }
    const intentInput: Record<string, unknown> = {
      operation: value.operation,
      backend: value.backend,
      target: value.target,
    };
    for (const key of ['expected', 'recursive', 'plan'] as const) {
      if (value[key] !== undefined) intentInput[key] = value[key];
    }
    const intent = normalizeIntent(intentInput);
    const diff = value.diff === undefined ? undefined : normalizeDiffReference(value.diff);
    if (!DIFF_OPERATIONS.has(intent.operation) && diff !== undefined) {
      throw new Error('Only write and patch intents may contain a diff reference.');
    }
    return {
      ...validateBaseRecord(value, sessionId),
      recordType: 'intent',
      actor: 'ai',
      source: value.source as WorkspaceOperationSource,
      ...intent,
      ...(diff === undefined ? {} : { diff }),
    };
  }
  if (value.recordType === 'outcome') {
    assertExactKeys(
      value,
      [...commonKeys, 'outcome', 'sideEffectCommitted', 'effect', 'failure'],
      'Workspace outcome record',
    );
    // The operation-specific outcome validation is completed after its intent is located.
    return {
      ...validateBaseRecord(value, sessionId),
      recordType: 'outcome',
      outcome: value.outcome as WorkspaceOperationOutcome['outcome'],
      sideEffectCommitted: value.sideEffectCommitted as boolean | null,
      ...(value.effect === undefined ? {} : { effect: value.effect as WorkspaceOperationEffect }),
      ...(value.failure === undefined ? {} : { failure: value.failure as WorkspaceOperationFailure }),
    };
  }
  throw new Error('Workspace operation record type is invalid.');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeAll(fileDescriptor: number, value: Buffer): void {
  let offset = 0;
  while (offset < value.length) {
    const written = writeSync(fileDescriptor, value, offset, value.length - offset, null);
    if (written <= 0) throw new Error('Workspace journal write made no progress.');
    offset += written;
  }
}

function hardenFile(fileDescriptor: number): void {
  // Node's mode bits do not establish a private Windows DACL. Phase A relies on
  // the Electron userData directory's inherited ACL and deliberately does not
  // claim that fchmod is a Windows confidentiality boundary.
  if (process.platform !== 'win32') fchmodSync(fileDescriptor, 0o600);
}

function hardenDirectory(path: string): void {
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertPrivateDirectory(path: string, label: string): void {
  const attributes = lstatSync(path);
  if (attributes.isSymbolicLink() || !attributes.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink or reparse link.`);
  }
  hardenDirectory(path);
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function ensurePrivateDirectory(path: string, label: string): void {
  if (!lstatIfPresent(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
      syncDirectory(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  assertPrivateDirectory(path, label);
}

function openNoFollowFlags(baseFlags: number): number {
  return baseFlags | (fsConstants.O_NOFOLLOW ?? 0);
}

function assertRegularDescriptor(fileDescriptor: number, label: string): void {
  const attributes = fstatSync(fileDescriptor);
  if (!attributes.isFile() || attributes.nlink !== 1) {
    throw new Error(`${label} must be a regular, singly-linked file.`);
  }
}

function assertRegularPath(path: string, label: string): void {
  const attributes = lstatSync(path);
  if (attributes.isSymbolicLink() || !attributes.isFile() || attributes.nlink !== 1) {
    throw new Error(`${label} must be a regular, singly-linked file.`);
  }
}

function cloneRecord<T>(record: T): T {
  return structuredClone(record);
}

export class WorkspaceOperationJournal {
  private readonly limits: JournalLimits;
  private readonly states = new Map<string, SessionJournalState>();
  private readonly busySessions = new Set<string>();

  constructor(
    private readonly rootPath: string,
    options: WorkspaceOperationJournalOptions = {},
  ) {
    this.limits = {
      maxRecordBytes: this.boundedOption(
        options.maxRecordBytes,
        DEFAULT_MAX_RECORD_BYTES,
        'record',
      ),
      maxDiffBytes: this.boundedOption(options.maxDiffBytes, DEFAULT_MAX_DIFF_BYTES, 'diff'),
      maxLogBytes: this.boundedOption(options.maxLogBytes, DEFAULT_MAX_LOG_BYTES, 'log'),
      maxTotalBytes: this.boundedOption(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 'total'),
    };
  }

  begin(
    sessionId: string,
    intentInput: WorkspaceOperationIntent,
    diffInput?: WorkspaceDiffArtifact,
    source: WorkspaceOperationSource = 'agent_file_service',
  ): WorkspaceOperationHandle {
    return this.exclusive(sessionId, () => {
      if (!OPERATION_SOURCES.has(source)) throw new Error('Workspace operation source is invalid.');
      const intent = normalizeIntent(intentInput);
      if (!DIFF_OPERATIONS.has(intent.operation) && diffInput !== undefined) {
        throw new Error('Only write and patch operations may contain a diff artifact.');
      }
      const diff = diffInput === undefined ? undefined : normalizeDiffArtifact(diffInput);
      const diffBody = diff === undefined ? undefined : Buffer.from(diff.body, 'utf8');
      if (diffBody && diffBody.length > this.limits.maxDiffBytes) {
        throw new Error(`Workspace diff exceeds the ${this.limits.maxDiffBytes}-byte limit.`);
      }

      const state = this.state(sessionId);
      let operationId = randomUUID();
      while (state.operationIds.has(operationId)) operationId = randomUUID();
      const diffReference: WorkspaceDiffReference | undefined = diff && diffBody
        ? {
            id: operationId,
            sha256: sha256(diffBody),
            bytes: diffBody.length,
            additions: diff.additions,
            deletions: diff.deletions,
            truncated: diff.truncated,
          }
        : undefined;
      const record: WorkspaceOperationIntentRecord = {
        version: JOURNAL_VERSION,
        sequence: state.nextSequence,
        recordType: 'intent',
        operationId,
        sessionId,
        timestamp: new Date().toISOString(),
        actor: 'ai',
        source,
        ...intent,
        ...(diffReference === undefined ? {} : { diff: diffReference }),
      };
      const recordBytes = this.serializedRecord(record);
      const pendingReservations = state.openIntents.size * this.limits.maxRecordBytes;
      const futureLogBytes = state.logBytes
        + recordBytes.length
        + pendingReservations
        + this.limits.maxRecordBytes;
      if (futureLogBytes > this.limits.maxLogBytes) {
        throw new Error('Workspace operation journal is full; no operation was started.');
      }
      const futureTotalBytes = state.logBytes
        + state.diffBytes
        + recordBytes.length
        + (diffBody?.length ?? 0)
        + pendingReservations
        + this.limits.maxRecordBytes;
      if (futureTotalBytes > this.limits.maxTotalBytes) {
        throw new Error('Workspace operation audit quota is exhausted; no operation was started.');
      }

      let diffWritten = false;
      try {
        if (diffBody) {
          this.writeDiff(sessionId, operationId, diffBody);
          diffWritten = true;
        }
        this.appendRecord(sessionId, state, recordBytes);
      } catch (error) {
        this.states.delete(sessionId);
        if (!(error instanceof WorkspaceJournalUncertainAppendError) && (diffWritten || diffBody)) {
          try {
            this.removeDiff(sessionId, operationId);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'Workspace intent failed and its diff artifact could not be cleaned up.',
            );
          }
        }
        throw error;
      }
      state.records.push(record);
      state.openIntents.set(operationId, record);
      state.operationIds.add(operationId);
      state.nextSequence += 1;
      state.diffBytes += diffBody?.length ?? 0;
      return { sessionId, operationId, intentSequence: record.sequence };
    });
  }

  finish(handleInput: WorkspaceOperationHandle, outcomeInput: WorkspaceOperationOutcome): void {
    assertRecord(handleInput, 'Workspace operation handle');
    assertExactKeys(
      handleInput,
      ['sessionId', 'operationId', 'intentSequence'],
      'Workspace operation handle',
    );
    assertUuid(handleInput.sessionId, 'Workspace operation Session identifier');
    assertUuid(handleInput.operationId, 'Workspace operation identifier');
    assertSafeInteger(handleInput.intentSequence, 'Workspace intent sequence');
    this.exclusive(handleInput.sessionId, () => {
      const state = this.state(handleInput.sessionId);
      const intent = state.openIntents.get(handleInput.operationId);
      if (!intent || intent.sequence !== handleInput.intentSequence) {
        throw new Error('Workspace operation handle is stale, unknown, or already finished.');
      }
      const outcome = normalizeOutcome(outcomeInput, intent.operation);
      if (
        DIFF_OPERATIONS.has(intent.operation)
        && intent.diff === undefined
        && (
          outcome.outcome === 'succeeded'
          || outcome.sideEffectCommitted !== false
          || outcome.failure?.stage !== 'prepare'
        )
      ) {
        throw new Error('A dispatched write or patch outcome requires its bounded diff artifact.');
      }
      const record: WorkspaceOperationOutcomeRecord = {
        version: JOURNAL_VERSION,
        sequence: state.nextSequence,
        recordType: 'outcome',
        operationId: handleInput.operationId,
        sessionId: handleInput.sessionId,
        timestamp: new Date().toISOString(),
        ...outcome,
      };
      const recordBytes = this.serializedRecord(record);
      const remainingReservations = (state.openIntents.size - 1) * this.limits.maxRecordBytes;
      if (state.logBytes + recordBytes.length + remainingReservations > this.limits.maxLogBytes) {
        throw new Error('Reserved Workspace outcome space is unavailable.');
      }
      if (
        state.logBytes
        + state.diffBytes
        + recordBytes.length
        + remainingReservations
        > this.limits.maxTotalBytes
      ) throw new Error('Reserved Workspace audit quota is unavailable.');
      try {
        this.appendRecord(handleInput.sessionId, state, recordBytes);
      } catch (error) {
        this.states.delete(handleInput.sessionId);
        throw error;
      }
      state.records.push(record);
      state.openIntents.delete(handleInput.operationId);
      state.nextSequence += 1;
    });
  }

  read(sessionId: string): WorkspaceOperationRecord[] {
    return this.exclusive(sessionId, () => this.state(sessionId).records.map(cloneRecord));
  }

  recover(sessionId: string): WorkspaceOperationRecovery[] {
    return this.exclusive(sessionId, () => {
      const records = this.state(sessionId).records;
      const outcomes = new Map(
        records
          .filter((record): record is WorkspaceOperationOutcomeRecord => record.recordType === 'outcome')
          .map((record) => [record.operationId, record]),
      );
      return records
        .filter((record): record is WorkspaceOperationIntentRecord => record.recordType === 'intent')
        .map((intent) => {
          const outcome = outcomes.get(intent.operationId) ?? null;
          return {
            intent: cloneRecord(intent),
            outcome: outcome === null ? null : cloneRecord(outcome),
            sideEffectCommitted: outcome?.sideEffectCommitted
              ?? (MUTATIONS.has(intent.operation) ? null : false),
          };
        });
    });
  }

  private boundedOption(value: number | undefined, maximum: number, label: string): number {
    const selected = value ?? maximum;
    if (!Number.isSafeInteger(selected) || selected < 256 || selected > maximum) {
      throw new Error(`Workspace journal ${label} limit is invalid.`);
    }
    return selected;
  }

  private exclusive<T>(sessionId: string, operation: () => T): T {
    assertUuid(sessionId, 'Workspace operation Session identifier');
    if (this.busySessions.has(sessionId)) {
      throw new Error('Re-entrant Workspace journal access is not allowed.');
    }
    this.busySessions.add(sessionId);
    try {
      return operation();
    } finally {
      this.busySessions.delete(sessionId);
    }
  }

  private state(sessionId: string): SessionJournalState {
    const existing = this.states.get(sessionId);
    if (existing) return existing;
    const loaded = this.loadState(sessionId);
    this.states.set(sessionId, loaded);
    return loaded;
  }

  private loadState(sessionId: string): SessionJournalState {
    this.ensureStorage(sessionId);
    const logPath = this.logPath(sessionId);
    const contents = this.readAndRepairLog(logPath);
    const records: WorkspaceOperationRecord[] = [];
    const openIntents = new Map<string, WorkspaceOperationIntentRecord>();
    const operationIds = new Set<string>();
    let expectedSequence = 1;
    for (const line of contents.buffer.toString('utf8').split('\n')) {
      if (!line) continue;
      if (Buffer.byteLength(`${line}\n`, 'utf8') > this.limits.maxRecordBytes) {
        throw new Error('Workspace operation record exceeds its hard limit.');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error('Workspace operation journal contains a corrupt complete record.');
      }
      let record = parsePersistedRecord(parsed, sessionId);
      if (record.sequence !== expectedSequence) {
        throw new Error('Workspace operation journal sequence is not contiguous.');
      }
      expectedSequence += 1;
      if (record.recordType === 'intent') {
        if (operationIds.has(record.operationId)) {
          throw new Error('Workspace operation identifier was reused.');
        }
        operationIds.add(record.operationId);
        openIntents.set(record.operationId, record);
      } else {
        const intent = openIntents.get(record.operationId);
        if (!intent) throw new Error('Workspace outcome has no unmatched intent.');
        const normalized = normalizeOutcome({
          outcome: record.outcome,
          sideEffectCommitted: record.sideEffectCommitted,
          ...(record.effect === undefined ? {} : { effect: record.effect }),
          ...(record.failure === undefined ? {} : { failure: record.failure }),
        }, intent.operation);
        if (
          DIFF_OPERATIONS.has(intent.operation)
          && intent.diff === undefined
          && (
            normalized.outcome === 'succeeded'
            || normalized.sideEffectCommitted !== false
            || normalized.failure?.stage !== 'prepare'
          )
        ) throw new Error('A dispatched write or patch outcome has no bounded diff artifact.');
        record = { ...record, ...normalized };
        openIntents.delete(record.operationId);
      }
      records.push(record);
    }

    const referencedDiffs = new Map<string, WorkspaceDiffReference>();
    for (const record of records) {
      if (record.recordType === 'intent' && record.diff) {
        referencedDiffs.set(record.diff.id, record.diff);
      }
    }
    const diffBytes = this.validateAndCleanDiffs(sessionId, referencedDiffs);
    if (contents.validBytes + diffBytes > this.limits.maxTotalBytes) {
      throw new Error('Workspace operation audit storage exceeds its hard quota.');
    }
    return {
      records,
      openIntents,
      operationIds,
      nextSequence: expectedSequence,
      logBytes: contents.validBytes,
      diffBytes,
    };
  }

  private ensureStorage(sessionId: string): void {
    const root = resolve(this.rootPath);
    const sessionPath = this.sessionPath(sessionId);
    assertPrivateDirectory(root, 'Session storage root');
    assertPrivateDirectory(sessionPath, 'Session directory');
    const workspacePath = join(sessionPath, 'workspace');
    const diffsPath = join(workspacePath, 'diffs');
    ensurePrivateDirectory(workspacePath, 'Workspace operation directory');
    ensurePrivateDirectory(diffsPath, 'Workspace diff directory');
    const logPath = join(workspacePath, 'operations.jsonl');
    if (!lstatIfPresent(logPath)) {
      try {
        const descriptor = openSync(
          logPath,
          openNoFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL),
          0o600,
        );
        try {
          assertRegularDescriptor(descriptor, 'Workspace operation journal');
          hardenFile(descriptor);
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        syncDirectory(workspacePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    assertRegularPath(logPath, 'Workspace operation journal');
  }

  private readAndRepairLog(path: string): { buffer: Buffer; validBytes: number } {
    assertRegularPath(path, 'Workspace operation journal');
    const descriptor = openSync(path, openNoFollowFlags(fsConstants.O_RDWR));
    try {
      assertRegularDescriptor(descriptor, 'Workspace operation journal');
      hardenFile(descriptor);
      const attributes = fstatSync(descriptor);
      if (attributes.size > this.limits.maxLogBytes) {
        throw new Error('Workspace operation journal exceeds its hard limit.');
      }
      const buffer = readFileSync(descriptor);
      const validBytes = buffer.length === 0 || buffer.at(-1) === 0x0a
        ? buffer.length
        : buffer.lastIndexOf(0x0a) + 1;
      if (validBytes !== buffer.length) {
        ftruncateSync(descriptor, validBytes);
        fsyncSync(descriptor);
      }
      return { buffer: buffer.subarray(0, validBytes), validBytes };
    } finally {
      closeSync(descriptor);
    }
  }

  private appendRecord(
    sessionId: string,
    state: SessionJournalState,
    value: Buffer,
  ): void {
    const path = this.logPath(sessionId);
    this.prepareForAppend(path, state.logBytes);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        openNoFollowFlags(fsConstants.O_WRONLY | fsConstants.O_APPEND),
      );
      assertRegularDescriptor(descriptor, 'Workspace operation journal');
      hardenFile(descriptor);
      writeAll(descriptor, value);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // The recovery path below reopens and verifies the exact suffix.
        }
      }
      let recovered: 'committed' | 'rolled-back';
      try {
        recovered = this.recoverFailedAppend(path, state.logBytes, value);
      } catch (recoveryError) {
        throw new WorkspaceJournalUncertainAppendError(error, recoveryError);
      }
      if (recovered === 'rolled-back') throw error;
    }
    state.logBytes += value.length;
  }

  private prepareForAppend(path: string, expectedBytes: number): void {
    const descriptor = openSync(path, openNoFollowFlags(fsConstants.O_RDWR));
    try {
      assertRegularDescriptor(descriptor, 'Workspace operation journal');
      hardenFile(descriptor);
      const size = fstatSync(descriptor).size;
      if (size < expectedBytes || size > this.limits.maxLogBytes) {
        throw new Error('Workspace operation journal changed outside its serializer.');
      }
      if (expectedBytes > 0) {
        const finalByte = Buffer.alloc(1);
        if (readSync(descriptor, finalByte, 0, 1, expectedBytes - 1) !== 1 || finalByte[0] !== 0x0a) {
          throw new Error('Workspace operation journal has no complete durable tail.');
        }
      }
      if (size === expectedBytes) return;
      const suffix = Buffer.alloc(size - expectedBytes);
      let offset = 0;
      while (offset < suffix.length) {
        const bytesRead = readSync(
          descriptor,
          suffix,
          offset,
          suffix.length - offset,
          expectedBytes + offset,
        );
        if (bytesRead <= 0) throw new Error('Workspace journal tail read made no progress.');
        offset += bytesRead;
      }
      if (suffix.includes(0x0a)) {
        throw new Error('Workspace operation journal contains an untracked complete record.');
      }
      ftruncateSync(descriptor, expectedBytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private recoverFailedAppend(
    path: string,
    expectedBytes: number,
    intended: Buffer,
  ): 'committed' | 'rolled-back' {
    const descriptor = openSync(path, openNoFollowFlags(fsConstants.O_RDWR));
    try {
      assertRegularDescriptor(descriptor, 'Workspace operation journal');
      const size = fstatSync(descriptor).size;
      if (size === expectedBytes) return 'rolled-back';
      if (size < expectedBytes || size > expectedBytes + intended.length) {
        throw new Error('Workspace journal size is ambiguous after a failed append.');
      }
      const suffix = Buffer.alloc(size - expectedBytes);
      let offset = 0;
      while (offset < suffix.length) {
        const bytesRead = readSync(
          descriptor,
          suffix,
          offset,
          suffix.length - offset,
          expectedBytes + offset,
        );
        if (bytesRead <= 0) throw new Error('Workspace journal recovery read made no progress.');
        offset += bytesRead;
      }
      if (!intended.subarray(0, suffix.length).equals(suffix)) {
        throw new Error('Workspace journal contains unexpected bytes after a failed append.');
      }
      if (suffix.length === intended.length) {
        fsyncSync(descriptor);
        return 'committed';
      }
      ftruncateSync(descriptor, expectedBytes);
      fsyncSync(descriptor);
      return 'rolled-back';
    } finally {
      closeSync(descriptor);
    }
  }

  private serializedRecord(record: WorkspaceOperationRecord): Buffer {
    const value = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    if (value.length > this.limits.maxRecordBytes) {
      throw new Error(`Workspace operation record exceeds the ${this.limits.maxRecordBytes}-byte limit.`);
    }
    return value;
  }

  private writeDiff(sessionId: string, operationId: string, value: Buffer): void {
    const directory = this.diffsPath(sessionId);
    const finalPath = this.diffPath(sessionId, operationId);
    if (lstatIfPresent(finalPath)) throw new Error('Workspace diff artifact already exists.');
    const temporaryName = `.tmp-${randomUUID()}`;
    const temporaryPath = join(directory, temporaryName);
    const descriptor = openSync(
      temporaryPath,
      openNoFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL),
      0o600,
    );
    let closed = false;
    try {
      assertRegularDescriptor(descriptor, 'Workspace diff temporary file');
      hardenFile(descriptor);
      writeAll(descriptor, value);
      fsyncSync(descriptor);
      closeSync(descriptor);
      closed = true;
      if (lstatIfPresent(finalPath)) throw new Error('Workspace diff artifact already exists.');
      renameSync(temporaryPath, finalPath);
      assertRegularPath(finalPath, 'Workspace diff artifact');
      syncDirectory(directory);
    } catch (error) {
      if (!closed) closeSync(descriptor);
      if (lstatIfPresent(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
  }

  private removeDiff(sessionId: string, operationId: string): void {
    const path = this.diffPath(sessionId, operationId);
    if (!lstatIfPresent(path)) return;
    assertRegularPath(path, 'Workspace diff artifact');
    unlinkSync(path);
    syncDirectory(this.diffsPath(sessionId));
  }

  private validateAndCleanDiffs(
    sessionId: string,
    referenced: Map<string, WorkspaceDiffReference>,
  ): number {
    const directory = this.diffsPath(sessionId);
    let total = 0;
    const seen = new Set<string>();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error('Workspace diff directory contains a non-regular entry.');
      }
      if (/^\.tmp-[0-9a-f-]{36}$/i.test(entry.name)) {
        assertRegularPath(path, 'Workspace diff temporary file');
        unlinkSync(path);
        continue;
      }
      const match = /^([0-9a-f-]{36})\.patch$/i.exec(entry.name);
      if (!match || !UUID_PATTERN.test(match[1]!)) {
        throw new Error('Workspace diff directory contains an unexpected file.');
      }
      const id = match[1]!;
      const reference = referenced.get(id);
      assertRegularPath(path, 'Workspace diff artifact');
      if (!reference) {
        unlinkSync(path);
        continue;
      }
      const attributes = lstatSync(path);
      if (attributes.size !== reference.bytes || attributes.size > this.limits.maxDiffBytes) {
        throw new Error('Workspace diff artifact size does not match its journal reference.');
      }
      const body = readFileSync(path);
      if (sha256(body) !== reference.sha256) {
        throw new Error('Workspace diff artifact hash does not match its journal reference.');
      }
      total += attributes.size;
      seen.add(id);
    }
    for (const id of referenced.keys()) {
      if (!seen.has(id)) throw new Error('Workspace journal references a missing diff artifact.');
    }
    syncDirectory(directory);
    return total;
  }

  private sessionPath(sessionId: string): string {
    const root = resolve(this.rootPath);
    const path = resolve(root, sessionId);
    if (dirname(path) !== root || basename(path) !== sessionId) {
      throw new Error('Invalid Workspace operation Session path.');
    }
    return path;
  }

  private workspacePath(sessionId: string): string {
    return join(this.sessionPath(sessionId), 'workspace');
  }

  private diffsPath(sessionId: string): string {
    return join(this.workspacePath(sessionId), 'diffs');
  }

  private logPath(sessionId: string): string {
    return join(this.workspacePath(sessionId), 'operations.jsonl');
  }

  private diffPath(sessionId: string, operationId: string): string {
    assertUuid(operationId, 'Workspace diff identifier');
    return join(this.diffsPath(sessionId), `${operationId}.patch`);
  }
}
