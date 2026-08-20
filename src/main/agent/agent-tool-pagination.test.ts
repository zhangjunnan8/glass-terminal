// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  continuationFingerprint,
  decodeOffsetCursor,
  encodeOffsetCursor,
  prepareWorkspaceReadPage,
  renderWorkspaceReadPage,
} from './agent-tool-pagination';

describe('Agent read-only tool continuation cursors', () => {
  it('pages an explicit file line range and resumes without overlap', () => {
    const result = {
      path: '/work/demo.txt',
      content: 'one\ntwo\n三四\nfive\n',
      bytes: 20,
      sha256: 'a'.repeat(64),
    };
    const firstSource = prepareWorkspaceReadPage(result, 'demo.txt', {
      startLine: 2,
      endLine: 4,
    });
    const first = renderWorkspaceReadPage(firstSource, 6);
    expect(first).toMatchObject({
      content: 'two\n三四',
      startLine: 2,
      endLine: 3,
      totalLines: 5,
      truncated: true,
    });

    const secondSource = prepareWorkspaceReadPage(result, 'demo.txt', {
      cursor: first.nextCursor,
    });
    const second = renderWorkspaceReadPage(secondSource, 100);
    expect(first.content + second.content).toBe('two\n三四\nfive\n');
    expect(second.truncated).toBe(false);
  });

  it('rejects a file cursor after the file hash changes', () => {
    const original = {
      path: '/work/demo.txt', content: 'abcdef', bytes: 6, sha256: 'b'.repeat(64),
    };
    const first = renderWorkspaceReadPage(
      prepareWorkspaceReadPage(original, 'demo.txt', {}),
      3,
    );
    expect(() => prepareWorkspaceReadPage(
      { ...original, content: 'changed', sha256: 'c'.repeat(64) },
      'demo.txt',
      { cursor: first.nextCursor },
    )).toThrow(/file changed/u);
  });

  it('binds search/glob cursors to the original arguments and bounded offset', () => {
    const fingerprint = continuationFingerprint('workspace-search', {
      query: 'needle', path: 'src',
    });
    const cursor = encodeOffsetCursor('workspace-search', fingerprint, 17);
    expect(decodeOffsetCursor(cursor, 'workspace-search', fingerprint)).toBe(17);
    expect(() => decodeOffsetCursor(
      cursor,
      'workspace-search',
      continuationFingerprint('workspace-search', { query: 'other', path: 'src' }),
    )).toThrow(/does not match/u);
  });
});
