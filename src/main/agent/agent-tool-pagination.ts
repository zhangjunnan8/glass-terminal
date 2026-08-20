import { createHash } from 'node:crypto';
import type { WorkspaceFileReadResult } from '../../shared/tools';

type CursorKind = 'workspace-read' | 'workspace-search' | 'workspace-glob';

interface OffsetCursorPayload {
  v: 1;
  kind: 'workspace-search' | 'workspace-glob';
  fingerprint: string;
  offset: number;
}

interface ReadCursorPayload {
  v: 1;
  kind: 'workspace-read';
  fingerprint: string;
  sha256: string;
  offset: number;
  endOffset: number;
}

export interface WorkspaceReadPage {
  ok: true;
  path: string;
  content: string;
  bytes: number;
  sha256: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  nextCursor?: string;
}

export interface WorkspaceReadPageSource {
  result: WorkspaceFileReadResult;
  fingerprint: string;
  starts: number[];
  startOffset: number;
  endOffset: number;
}

function encodeCursor(payload: OffsetCursorPayload | ReadCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(value: string): unknown {
  if (!value || value.length > 2_048) throw new Error('Continuation cursor is invalid.');
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('Continuation cursor is invalid.');
  }
}

export function continuationFingerprint(kind: CursorKind, values: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([kind, values]), 'utf8')
    .digest('hex');
}

export function encodeOffsetCursor(
  kind: 'workspace-search' | 'workspace-glob',
  fingerprint: string,
  offset: number,
): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) {
    throw new Error('Continuation offset is outside the bounded traversal range.');
  }
  return encodeCursor({ v: 1, kind, fingerprint, offset });
}

export function decodeOffsetCursor(
  value: string | undefined,
  kind: 'workspace-search' | 'workspace-glob',
  fingerprint: string,
): number {
  if (value === undefined) return 0;
  const payload = decodeCursor(value);
  if (
    !payload
    || typeof payload !== 'object'
    || (payload as Partial<OffsetCursorPayload>).v !== 1
    || (payload as Partial<OffsetCursorPayload>).kind !== kind
    || (payload as Partial<OffsetCursorPayload>).fingerprint !== fingerprint
    || !Number.isSafeInteger((payload as Partial<OffsetCursorPayload>).offset)
    || Number((payload as Partial<OffsetCursorPayload>).offset) < 0
    || Number((payload as Partial<OffsetCursorPayload>).offset) > 10_000
  ) throw new Error('Continuation cursor does not match this tool request.');
  return Number((payload as OffsetCursorPayload).offset);
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 0x0a) starts.push(index + 1);
  }
  return starts;
}

function integerArgument(
  value: unknown,
  field: string,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`workspace_read_file.${field} must be an integer from 1 to ${maximum}.`);
  }
  return Number(value);
}

export function prepareWorkspaceReadPage(
  result: WorkspaceFileReadResult,
  requestedPath: string,
  args: Record<string, unknown>,
): WorkspaceReadPageSource {
  const fingerprint = continuationFingerprint('workspace-read', { path: requestedPath });
  const starts = lineStarts(result.content);
  const cursorValue = typeof args.cursor === 'string' ? args.cursor : undefined;
  if (cursorValue && (args.startLine !== undefined || args.endLine !== undefined)) {
    throw new Error('workspace_read_file cursor cannot be combined with startLine/endLine.');
  }

  if (cursorValue) {
    const payload = decodeCursor(cursorValue);
    if (
      !payload
      || typeof payload !== 'object'
      || (payload as Partial<ReadCursorPayload>).v !== 1
      || (payload as Partial<ReadCursorPayload>).kind !== 'workspace-read'
      || (payload as Partial<ReadCursorPayload>).fingerprint !== fingerprint
      || (payload as Partial<ReadCursorPayload>).sha256 !== result.sha256
      || !Number.isSafeInteger((payload as Partial<ReadCursorPayload>).offset)
      || !Number.isSafeInteger((payload as Partial<ReadCursorPayload>).endOffset)
    ) throw new Error('workspace_read_file cursor is invalid or the file changed; re-read it.');
    const { offset, endOffset } = payload as ReadCursorPayload;
    if (offset < 0 || endOffset < offset || endOffset > result.content.length) {
      throw new Error('workspace_read_file cursor is outside the current file.');
    }
    return { result, fingerprint, starts, startOffset: offset, endOffset };
  }

  const startLine = integerArgument(args.startLine, 'startLine', 10_000_000) ?? 1;
  const endLine = integerArgument(args.endLine, 'endLine', 10_000_000) ?? starts.length;
  if (startLine > starts.length || endLine > starts.length || endLine < startLine) {
    throw new Error(`workspace_read_file line range must be within 1-${starts.length}.`);
  }
  return {
    result,
    fingerprint,
    starts,
    startOffset: starts[startLine - 1]!,
    endOffset: endLine < starts.length ? starts[endLine]! : result.content.length,
  };
}

function lineAtOffset(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

export function renderWorkspaceReadPage(
  source: WorkspaceReadPageSource,
  maxContentChars: number,
): WorkspaceReadPage {
  const boundedChars = Math.max(0, Math.floor(maxContentChars));
  let pageEnd = Math.min(source.endOffset, source.startOffset + boundedChars);
  if (
    pageEnd > source.startOffset
    && pageEnd < source.endOffset
    && /[\uD800-\uDBFF]/u.test(source.result.content[pageEnd - 1] ?? '')
  ) pageEnd -= 1;
  const truncated = pageEnd < source.endOffset;
  const content = source.result.content.slice(source.startOffset, pageEnd);
  const endProbe = Math.max(source.startOffset, pageEnd - 1);
  return {
    ok: true,
    path: source.result.path,
    content,
    bytes: source.result.bytes,
    sha256: source.result.sha256,
    startLine: lineAtOffset(source.starts, source.startOffset),
    endLine: lineAtOffset(source.starts, endProbe),
    totalLines: source.starts.length,
    truncated,
    ...(truncated
      ? {
        nextCursor: encodeCursor({
          v: 1,
          kind: 'workspace-read',
          fingerprint: source.fingerprint,
          sha256: source.result.sha256,
          offset: pageEnd,
          endOffset: source.endOffset,
        }),
      }
      : {}),
  };
}
