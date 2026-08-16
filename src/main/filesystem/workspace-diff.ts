export interface WorkspaceDiffResult {
  diff: string;
  additions: number;
  deletions: number;
  diffTruncated: boolean;
}

export interface WorkspaceDiffLimits {
  contextLines: number;
  maxBytes: number;
  maxLines: number;
  maxEditDistance: number;
  maxWork: number;
  maxDurationMs: number;
  maxInputLines: number;
}

export const DEFAULT_WORKSPACE_DIFF_LIMITS: Readonly<WorkspaceDiffLimits> = {
  contextLines: 3,
  maxBytes: 64 * 1024,
  maxLines: 2_000,
  maxEditDistance: 512,
  maxWork: 2_000_000,
  maxDurationMs: 250,
  maxInputLines: 50_000,
};

interface TextLine {
  value: string;
  ending: '' | '\n' | '\r' | '\r\n';
}

interface DiffOperation {
  type: 'equal' | 'delete' | 'add';
  line: TextLine;
}

function textLines(content: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character !== '\n' && character !== '\r') continue;
    const ending = character === '\r' && content[index + 1] === '\n' ? '\r\n' : character;
    lines.push({ value: content.slice(start, index), ending });
    if (ending === '\r\n') index += 1;
    start = index + 1;
  }
  if (start < content.length) lines.push({ value: content.slice(start), ending: '' });
  return lines;
}

function textLineCount(content: string): number {
  if (!content) return 0;
  let lines = 0;
  let lastWasEnding = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character !== '\n' && character !== '\r') {
      lastWasEnding = false;
      continue;
    }
    lines += 1;
    lastWasEnding = true;
    if (character === '\r' && content[index + 1] === '\n') index += 1;
  }
  return lines + (lastWasEnding ? 0 : 1);
}

function lineKey(line: TextLine): string {
  return `${line.value}\u0000${line.ending}`;
}

function safeDiffPath(path: string): string {
  return path
    .replace(/[\u0000-\u001F\u007F]/gu, '?')
    .replace(/^\/+|\/+$/gu, '') || 'workspace-file';
}

function range(start: number, count: number): string {
  if (count === 0) return '0,0';
  return `${start + 1},${count}`;
}

class BoundedDiffBuilder {
  private readonly parts: string[] = [];
  private bytes = 0;
  private lines = 0;
  private truncated = false;
  private readonly marker = '# ... diff truncated by Workspace limits ...\n';

  constructor(private readonly limits: Readonly<WorkspaceDiffLimits>) {}

  push(line: string): void {
    if (this.truncated) return;
    const rendered = `${line}\n`;
    const bytes = Buffer.byteLength(rendered, 'utf8');
    const markerBytes = Buffer.byteLength(this.marker, 'utf8');
    if (
      this.lines >= Math.max(0, this.limits.maxLines - 1)
      || this.bytes + bytes + markerBytes > this.limits.maxBytes
    ) {
      this.truncated = true;
      return;
    }
    this.parts.push(rendered);
    this.bytes += bytes;
    this.lines += 1;
  }

  finish(algorithmTruncated: boolean): { diff: string; truncated: boolean } {
    const truncated = this.truncated || algorithmTruncated;
    if (truncated) {
      const markerBytes = Buffer.byteLength(this.marker, 'utf8');
      if (
        this.bytes + markerBytes <= this.limits.maxBytes
        && this.lines < this.limits.maxLines
      ) this.parts.push(this.marker);
    }
    return { diff: this.parts.join(''), truncated };
  }
}

function renderTextLine(builder: BoundedDiffBuilder, prefix: ' ' | '-' | '+', line: TextLine): void {
  builder.push(`${prefix}${line.value}`);
  if (!line.ending) builder.push('\\ No newline at end of file');
}

function fallbackOperations(oldLines: TextLine[], newLines: TextLine[]): DiffOperation[] {
  let prefix = 0;
  while (
    prefix < oldLines.length
    && prefix < newLines.length
    && lineKey(oldLines[prefix]!) === lineKey(newLines[prefix]!)
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && lineKey(oldLines[oldLines.length - suffix - 1]!)
      === lineKey(newLines[newLines.length - suffix - 1]!)
  ) suffix += 1;
  return [
    ...oldLines.slice(0, prefix).map((line): DiffOperation => ({ type: 'equal', line })),
    ...oldLines.slice(prefix, oldLines.length - suffix)
      .map((line): DiffOperation => ({ type: 'delete', line })),
    ...newLines.slice(prefix, newLines.length - suffix)
      .map((line): DiffOperation => ({ type: 'add', line })),
    ...oldLines.slice(oldLines.length - suffix)
      .map((line): DiffOperation => ({ type: 'equal', line })),
  ];
}

function myersOperations(
  oldLines: TextLine[],
  newLines: TextLine[],
  limits: Readonly<WorkspaceDiffLimits>,
): { operations: DiffOperation[]; truncated: boolean } {
  const oldKeys = oldLines.map(lineKey);
  const newKeys = newLines.map(lineKey);
  const maximum = oldLines.length + newLines.length;
  const maximumDistance = Math.min(maximum, limits.maxEditDistance);
  const deadline = Date.now() + limits.maxDurationMs;
  let work = 0;
  const frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  let completedDistance = -1;

  outer: for (let distance = 0; distance <= maximumDistance; distance += 1) {
    if (Date.now() > deadline) break;
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      work += 1;
      if (work > limits.maxWork) break outer;
      const previousDelete = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      const previousInsert = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      let x = diagonal === -distance
        || (diagonal !== distance && previousDelete < previousInsert)
        ? previousInsert
        : previousDelete + 1;
      if (!Number.isFinite(x)) x = 0;
      let y = x - diagonal;
      while (
        x < oldKeys.length
        && y < newKeys.length
        && oldKeys[x] === newKeys[y]
      ) {
        x += 1;
        y += 1;
        work += 1;
        if (work > limits.maxWork || Date.now() > deadline) break outer;
      }
      frontier.set(diagonal, x);
      if (x >= oldKeys.length && y >= newKeys.length) {
        completedDistance = distance;
        break outer;
      }
    }
  }

  if (completedDistance < 0) {
    return { operations: fallbackOperations(oldLines, newLines), truncated: true };
  }

  const reversed: DiffOperation[] = [];
  let x = oldLines.length;
  let y = newLines.length;
  for (let distance = completedDistance; distance >= 0; distance -= 1) {
    const snapshot = trace[distance]!;
    const diagonal = x - y;
    const deleteX = snapshot.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const insertX = snapshot.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal = diagonal === -distance
      || (diagonal !== distance && deleteX < insertX)
      ? diagonal + 1
      : diagonal - 1;
    const previousX = snapshot.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      reversed.push({ type: 'equal', line: oldLines[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (distance === 0) break;
    if (x === previousX) {
      reversed.push({ type: 'add', line: newLines[y - 1]! });
      y -= 1;
    } else {
      reversed.push({ type: 'delete', line: oldLines[x - 1]! });
      x -= 1;
    }
  }
  return { operations: reversed.reverse(), truncated: false };
}

function hunkRanges(operations: DiffOperation[], context: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index]!.type === 'equal') continue;
    const start = Math.max(0, index - context);
    const end = Math.min(operations.length, index + context + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
  }
  return ranges;
}

/**
 * Creates a deterministic multi-hunk unified-style diff. Myers is bounded by
 * edit distance, work, and wall time; on exhaustion a linear fallback is used
 * and diffTruncated explicitly tells the caller that the summary is partial.
 */
export function createWorkspaceDiff(
  relativePath: string,
  before: string | undefined,
  after: string,
  limits: Readonly<WorkspaceDiffLimits> = DEFAULT_WORKSPACE_DIFF_LIMITS,
): WorkspaceDiffResult {
  if (before !== undefined && before === after) {
    return { diff: '', additions: 0, deletions: 0, diffTruncated: false };
  }
  const oldLineCount = textLineCount(before ?? '');
  const newLineCount = textLineCount(after);
  if (
    oldLineCount > limits.maxInputLines
    || newLineCount > limits.maxInputLines
  ) {
    const label = safeDiffPath(relativePath);
    const builder = new BoundedDiffBuilder(limits);
    builder.push(`--- ${before === undefined ? '/dev/null' : `a/${label}`}`);
    builder.push(`+++ b/${label}`);
    builder.push(`@@ -${range(0, oldLineCount)} +${range(0, newLineCount)} @@`);
    builder.push('# diff body omitted because the input line limit was exceeded');
    const finished = builder.finish(true);
    return {
      diff: finished.diff,
      // The bounded fallback conservatively represents the entire input as a
      // replacement. diffTruncated tells consumers these are summary counts.
      additions: newLineCount,
      deletions: oldLineCount,
      diffTruncated: true,
    };
  }
  const oldLines = textLines(before ?? '');
  const newLines = textLines(after);
  const calculated = myersOperations(oldLines, newLines, limits);
  const additions = calculated.operations.filter((operation) => operation.type === 'add').length;
  const deletions = calculated.operations.filter((operation) => operation.type === 'delete').length;
  if (additions === 0 && deletions === 0) {
    return { diff: '', additions: 0, deletions: 0, diffTruncated: calculated.truncated };
  }

  const oldBefore = new Uint32Array(calculated.operations.length + 1);
  const newBefore = new Uint32Array(calculated.operations.length + 1);
  for (let index = 0; index < calculated.operations.length; index += 1) {
    const operation = calculated.operations[index]!;
    oldBefore[index + 1] = oldBefore[index]! + (operation.type === 'add' ? 0 : 1);
    newBefore[index + 1] = newBefore[index]! + (operation.type === 'delete' ? 0 : 1);
  }

  const label = safeDiffPath(relativePath);
  const builder = new BoundedDiffBuilder(limits);
  builder.push(`--- ${before === undefined ? '/dev/null' : `a/${label}`}`);
  builder.push(`+++ b/${label}`);
  for (const [start, end] of hunkRanges(calculated.operations, limits.contextLines)) {
    const oldCount = oldBefore[end]! - oldBefore[start]!;
    const newCount = newBefore[end]! - newBefore[start]!;
    builder.push(
      `@@ -${range(oldBefore[start]!, oldCount)} +${range(newBefore[start]!, newCount)} @@`,
    );
    for (let index = start; index < end; index += 1) {
      const operation = calculated.operations[index]!;
      renderTextLine(
        builder,
        operation.type === 'equal' ? ' ' : operation.type === 'delete' ? '-' : '+',
        operation.line,
      );
    }
  }

  const finished = builder.finish(calculated.truncated);
  return {
    diff: finished.diff,
    additions,
    deletions,
    diffTruncated: finished.truncated,
  };
}
