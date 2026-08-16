import { describe, expect, it } from 'vitest';
import {
  createWorkspaceDiff,
  DEFAULT_WORKSPACE_DIFF_LIMITS,
} from './workspace-diff';

describe('createWorkspaceDiff', () => {
  it('returns a compact unified diff with accurate line counts', () => {
    const result = createWorkspaceDiff(
      'src/demo.ts',
      'const value = 1;\nexport { value };\n',
      'const value = 2;\nexport { value };\n',
    );

    expect(result).toMatchObject({ additions: 1, deletions: 1, diffTruncated: false });
    expect(result.diff).toContain('--- a/src/demo.ts');
    expect(result.diff).toContain('+++ b/src/demo.ts');
    expect(result.diff).toContain('-const value = 1;');
    expect(result.diff).toContain('+const value = 2;');
  });

  it('preserves a backslash as a literal character in an SSH-style label', () => {
    const result = createWorkspaceDiff('dir\\literal.ts', 'old\n', 'new\n');
    expect(result.diff).toContain('--- a/dir\\literal.ts');
    expect(result.diff).toContain('+++ b/dir\\literal.ts');
    expect(result.diff).not.toContain('a/dir/literal.ts');
  });

  it('uses separate small hunks for distant changes', () => {
    const beforeLines = Array.from({ length: 1_000 }, (_, index) => `line-${index}`);
    const afterLines = [...beforeLines];
    afterLines[9] = 'line-9-changed';
    afterLines[989] = 'line-989-changed';

    const result = createWorkspaceDiff(
      'large.txt',
      `${beforeLines.join('\n')}\n`,
      `${afterLines.join('\n')}\n`,
    );

    expect(result).toMatchObject({ additions: 2, deletions: 2, diffTruncated: false });
    expect(result.diff.match(/^@@/gmu)).toHaveLength(2);
    expect(result.diff).toContain('-line-9');
    expect(result.diff).toContain('+line-9-changed');
    expect(result.diff).toContain('-line-989');
    expect(result.diff).not.toContain(' line-500\n');
  });

  it('marks creation against /dev/null', () => {
    const result = createWorkspaceDiff('new.txt', undefined, 'first\nsecond\n');
    expect(result).toMatchObject({ additions: 2, deletions: 0, diffTruncated: false });
    expect(result.diff).toContain('--- /dev/null');
    expect(result.diff).toContain('+++ b/new.txt');
  });

  it('handles pure insertions, pure deletions, repeated lines, and line endings', () => {
    expect(createWorkspaceDiff('insert.txt', 'a\nc\n', 'a\nb\nc\n')).toMatchObject({
      additions: 1, deletions: 0, diffTruncated: false,
    });
    expect(createWorkspaceDiff('delete.txt', 'a\nb\nc\n', 'a\nc\n')).toMatchObject({
      additions: 0, deletions: 1, diffTruncated: false,
    });
    expect(createWorkspaceDiff('repeat.txt', 'a\nx\na\n', 'a\na\nx\n')).toMatchObject({
      additions: 1, deletions: 1, diffTruncated: false,
    });
    expect(createWorkspaceDiff('eof.txt', 'value', 'value\n')).toMatchObject({
      additions: 1, deletions: 1, diffTruncated: false,
    });
    expect(createWorkspaceDiff('crlf.txt', 'a\r\nb\r\n', 'a\r\nc\r\n')).toMatchObject({
      additions: 1, deletions: 1, diffTruncated: false,
    });
  });

  it('matches LCS edit counts for deterministic small repeated-line sequences', () => {
    let state = 0x5eed;
    const random = () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state;
    };
    const lcs = (left: string[], right: string[]) => {
      let previous = new Uint16Array(right.length + 1);
      for (const leftLine of left) {
        const current = new Uint16Array(right.length + 1);
        for (let index = 1; index <= right.length; index += 1) {
          current[index] = leftLine === right[index - 1]
            ? previous[index - 1]! + 1
            : Math.max(previous[index]!, current[index - 1]!);
        }
        previous = current;
      }
      return previous[right.length]!;
    };

    for (let sample = 0; sample < 40; sample += 1) {
      const left = Array.from({ length: random() % 12 }, () => `v${random() % 4}`);
      const right = Array.from({ length: random() % 12 }, () => `v${random() % 4}`);
      const shared = lcs(left, right);
      const result = createWorkspaceDiff(
        'random.txt',
        left.length ? `${left.join('\n')}\n` : '',
        right.length ? `${right.join('\n')}\n` : '',
      );
      expect(result.diffTruncated).toBe(false);
      expect(result.deletions).toBe(left.length - shared);
      expect(result.additions).toBe(right.length - shared);
    }
  });

  it('explicitly marks a complexity or output bound fallback', () => {
    const limits = {
      ...DEFAULT_WORKSPACE_DIFF_LIMITS,
      maxEditDistance: 0,
      maxBytes: 512,
      maxLines: 20,
    };
    const result = createWorkspaceDiff(
      'bounded.txt',
      `${'old\n'.repeat(100)}`,
      `${'new\n'.repeat(100)}`,
      limits,
    );
    expect(result.diffTruncated).toBe(true);
    expect(Buffer.byteLength(result.diff, 'utf8')).toBeLessThanOrEqual(limits.maxBytes);
    expect(result.diff).toContain('diff truncated');
  });

  it('does not allocate per-line diff objects past the input line bound', () => {
    const result = createWorkspaceDiff(
      'many-lines.txt',
      '',
      '\n'.repeat(DEFAULT_WORKSPACE_DIFF_LIMITS.maxInputLines + 1),
    );
    expect(result.diffTruncated).toBe(true);
    expect(result.diff).toContain('input line limit');
    expect(Buffer.byteLength(result.diff, 'utf8'))
      .toBeLessThan(DEFAULT_WORKSPACE_DIFF_LIMITS.maxBytes);
  });
});
