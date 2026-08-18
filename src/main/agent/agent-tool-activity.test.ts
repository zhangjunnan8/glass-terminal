import { describe, expect, it } from 'vitest';
import type { AgentToolActivity } from '../../shared/agent';
import type { AgentBackendEvent, AgentToolCall } from './agent-backend';
import {
  limitAgentToolActivities,
  MAX_AGENT_TOOL_ACTIVITIES,
  MAX_AGENT_TOOL_ACTIVITY_LABEL_CHARS,
  MAX_AGENT_TOOL_ACTIVITY_SUMMARY_CHARS,
  reduceAgentToolActivities,
  settleRunningToolActivities,
} from './agent-tool-activity';

const START = '2026-08-16T10:00:00.000Z';
const FINISH = '2026-08-16T10:00:01.000Z';

function call(id: string, name: string, args: Record<string, unknown> | string): AgentToolCall {
  return {
    id,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  };
}

function event(
  type: 'tool_started' | 'tool_completed',
  toolCall: AgentToolCall,
  result?: Record<string, unknown> | string,
): AgentBackendEvent {
  return {
    type,
    toolCall,
    ...(result !== undefined
      ? { result: typeof result === 'string' ? result : JSON.stringify(result) }
      : {}),
  };
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe('Agent tool activity reducer', () => {
  it('creates and completes a search activity using counts but never query or previews', () => {
    const querySecret = 'QUERY_SECRET_8b316f';
    const previewSecret = 'PREVIEW_BODY_81d4a2';
    const toolCall = call('search-1', 'workspace_search', {
      query: querySecret,
      path: 'src\u001b[31m',
      maxResults: 20,
    });
    const original: AgentToolActivity[] = [];
    const running = reduceAgentToolActivities(original, event('tool_started', toolCall), START);

    expect(original).toEqual([]);
    expect(running).toEqual([expect.objectContaining({
      id: 'search-1',
      toolName: 'workspace_search',
      kind: 'workspace',
      label: 'Search workspace src [31m',
      status: 'running',
      startedAt: START,
    })]);
    expect(serialized(running)).not.toContain(querySecret);

    const completed = reduceAgentToolActivities(running, event('tool_completed', toolCall, {
      ok: true,
      query: querySecret,
      matches: [
        { path: 'src/a.ts', line: 1, column: 1, preview: previewSecret },
        { path: 'src/b.ts', line: 2, column: 2, preview: previewSecret },
      ],
      filesScanned: 7,
      truncated: false,
    }), FINISH);

    expect(completed[0]).toMatchObject({
      status: 'succeeded',
      finishedAt: FINISH,
      summary: '2 matches · 7 files',
    });
    expect(serialized(completed)).not.toContain(querySecret);
    expect(serialized(completed)).not.toContain(previewSecret);
  });

  it('never stores terminal command, reason, output, or raw error', () => {
    const commandSecret = 'COMMAND_SECRET_4fbff1';
    const reasonSecret = 'REASON_SECRET_b9c214';
    const outputSecret = 'TERMINAL_OUTPUT_07476f';
    const errorSecret = 'RAW_ERROR_ba357e';
    const toolCall = call('terminal-1', 'terminal_execute', {
      command: commandSecret,
      reason: reasonSecret,
    });
    const running = reduceAgentToolActivities([], event('tool_started', toolCall), START);
    const completed = reduceAgentToolActivities(running, event('tool_completed', toolCall, {
      ok: false,
      exitCode: 23,
      output: outputSecret,
      error: errorSecret,
    }), FINISH);

    expect(completed[0]).toMatchObject({
      label: 'Run terminal command',
      kind: 'terminal',
      status: 'failed',
    });
    expect(completed[0]).not.toHaveProperty('summary');
    for (const secret of [commandSecret, reasonSecret, outputSecret, errorSecret]) {
      expect(serialized(completed)).not.toContain(secret);
    }

    const succeeded = reduceAgentToolActivities([], event('tool_completed', toolCall, {
      ok: true,
      exitCode: 0,
      output: outputSecret,
    }), FINISH);
    expect(succeeded[0]).toMatchObject({ status: 'succeeded', summary: 'Exit code 0' });
    expect(serialized(succeeded)).not.toContain(outputSecret);
  });

  it.each(['', 'not-json', '{"count":2}'])(
    'fails closed when a completed result has no explicit ok=true hint: %j',
    (result) => {
      const completed = reduceAgentToolActivities([], event(
        'tool_completed',
        call('', 'custom_tool', '{}'),
        result,
      ), FINISH);
      expect(completed[0]).toMatchObject({ status: 'failed', finishedAt: FINISH });
      expect(completed[0]!.id).toMatch(/^tool-[a-f0-9]{24}$/u);
    },
  );

  it('retains only paths and +/- counts for mutations', () => {
    const patchBody = 'PATCH_BODY_SECRET_c2b349';
    const content = 'WHOLE_FILE_SECRET_8454ec';
    const diff = 'DIFF_SECRET_43a292';
    const toolCall = call('patch-1', 'workspace_apply_patch', {
      path: 'src/demo.ts',
      expectedSha256: 'a'.repeat(64),
      content,
      patches: [{ search: patchBody, replace: content }],
    });
    const completed = reduceAgentToolActivities(
      reduceAgentToolActivities([], event('tool_started', toolCall), START),
      event('tool_completed', toolCall, {
        ok: true,
        path: 'src/demo.ts',
        sha256: 'b'.repeat(64),
        diff,
        additions: 2,
        deletions: 1,
      }),
      FINISH,
    );

    expect(completed[0]).toMatchObject({
      label: 'Patch src/demo.ts',
      summary: '+2/-1',
      status: 'succeeded',
    });
    for (const secret of [patchBody, content, diff, 'b'.repeat(64)]) {
      expect(serialized(completed)).not.toContain(secret);
    }

    const rename = call('rename-1', 'workspace_rename', {
      source: 'src/old.ts',
      destination: 'src/new.ts',
      content,
    });
    const renamed = reduceAgentToolActivities([], event('tool_started', rename), START);
    expect(renamed[0]?.label).toBe('Rename src/old.ts → src/new.ts');
    expect(serialized(renamed)).not.toContain(content);
  });

  it('does not retain search/glob terms even when they contain controls', () => {
    const query = 'SEARCH\u0000\u001bQUERY_SECRET';
    const pattern = 'GLOB\nPATTERN_SECRET';
    const search = reduceAgentToolActivities([], event('tool_started', call(
      'search-control',
      'workspace_search',
      { query, path: 'src' },
    )), START);
    const glob = reduceAgentToolActivities(search, event('tool_started', call(
      'glob-control',
      'workspace_glob',
      { pattern, path: 'tests' },
    )), START);

    expect(glob.map((activity) => activity.label)).toEqual([
      'Search workspace src',
      'Glob workspace tests',
    ]);
    expect(serialized(glob)).not.toContain('QUERY_SECRET');
    expect(serialized(glob)).not.toContain('PATTERN_SECRET');
  });

  it('fails closed for malicious 3 MiB args/result/error and strips controls', () => {
    const argumentSecret = 'ARGUMENT_SECRET_3M';
    const errorSecret = 'ERROR_SECRET_3M';
    const hugeArguments = JSON.stringify({
      path: `src/${argumentSecret}`,
      query: argumentSecret,
      command: argumentSecret,
      content: `${argumentSecret}${'A'.repeat(3 * 1024 * 1024)}`,
    });
    const hugeFailure = `{"ok":false,"error":"${errorSecret}${'E'.repeat(3 * 1024 * 1024)}"}`;
    const toolCall = call(
      `bad\u0000id-${'I'.repeat(3 * 1024 * 1024)}`,
      'workspace_apply_patch\u001b',
      hugeArguments,
    );

    const running = reduceAgentToolActivities([], event('tool_started', toolCall), START);
    const completed = reduceAgentToolActivities(
      running,
      event('tool_completed', toolCall, hugeFailure),
      FINISH,
    );
    const rendered = serialized(completed);

    expect(completed[0]).toMatchObject({ status: 'failed', finishedAt: FINISH });
    expect(completed[0]!.id.length).toBeLessThanOrEqual(29);
    expect(completed[0]!.label.length).toBeLessThanOrEqual(MAX_AGENT_TOOL_ACTIVITY_LABEL_CHARS);
    expect(rendered.length).toBeLessThan(1_000);
    expect(rendered).not.toContain(argumentSecret);
    expect(rendered).not.toContain(errorSecret);
    expect(rendered).not.toContain('\\u0000');
    expect(rendered).not.toContain('\\u001b');
  });

  it('bounds labels and summaries after removing control/format characters', () => {
    const longPath = `src/\u202E\u0007${'🚀'.repeat(300)}.ts`;
    const toolCall = call('bounded', 'workspace_read_file', { path: longPath });
    const activity = reduceAgentToolActivities([], event('tool_started', toolCall), START)[0]!;
    expect(Array.from(activity.label).length)
      .toBeLessThanOrEqual(MAX_AGENT_TOOL_ACTIVITY_LABEL_CHARS);
    expect(activity.label).not.toMatch(/[\p{Cc}\p{Cf}]/u);

    const other = call('other', 'custom_tool', {});
    const completed = reduceAgentToolActivities([], event('tool_completed', other, {
      ok: true,
      count: Number.MAX_SAFE_INTEGER,
      exitCode: -1,
      ignored: 'X'.repeat(10_000),
    }), FINISH)[0]!;
    expect(Array.from(completed.summary ?? '').length)
      .toBeLessThanOrEqual(MAX_AGENT_TOOL_ACTIVITY_SUMMARY_CHARS);
    expect(completed.summary).toBe(`${Number.MAX_SAFE_INTEGER} items · Exit code -1`);
  });

  it('keeps only the 24 most recent activities without mutating input', () => {
    let activities: AgentToolActivity[] = [];
    for (let index = 0; index < 30; index += 1) {
      const previous = activities;
      activities = reduceAgentToolActivities(
        activities,
        event('tool_started', call(`id-${index}`, 'workspace_stat', { path: `p-${index}` })),
        START,
      );
      expect(activities).not.toBe(previous);
    }
    expect(activities).toHaveLength(MAX_AGENT_TOOL_ACTIVITIES);
    expect(activities[0]?.id).toBe('id-6');
    expect(activities.at(-1)?.id).toBe('id-29');
    expect(limitAgentToolActivities(activities, 3).map((activity) => activity.id))
      .toEqual(['id-27', 'id-28', 'id-29']);
    expect(limitAgentToolActivities(activities, 0)).toEqual([]);
  });

  it.each(['failed', 'cancelled'] as const)(
    'settles only running activities as %s',
    (status) => {
      const running = reduceAgentToolActivities([], event('tool_started', call(
        'running',
        'workspace_stat',
        { path: 'src/demo.ts' },
      )), START);
      const succeeded: AgentToolActivity = {
        ...running[0]!,
        id: 'done',
        status: 'succeeded',
        finishedAt: START,
      };
      const settled = settleRunningToolActivities([...running, succeeded], status, FINISH);

      expect(settled[0]).toMatchObject({ status, finishedAt: FINISH });
      expect(settled[1]).toEqual(succeeded);
      expect(running[0]?.status).toBe('running');
    },
  );

  it('attaches and preserves the turn id across start and completion', () => {
    const toolCall = call('turn-1', 'workspace_read_file', { path: 'src/a.ts' });
    const running = reduceAgentToolActivities(
      [],
      event('tool_started', toolCall),
      START,
      'turn-42',
    );
    expect(running[0]).toMatchObject({ id: 'turn-1', turnId: 'turn-42' });

    const completed = reduceAgentToolActivities(
      running,
      event('tool_completed', toolCall, { ok: true, sha256: 'a'.repeat(64) }),
      FINISH,
      'turn-42',
    );
    expect(completed[0]).toMatchObject({ turnId: 'turn-42', status: 'succeeded', finishedAt: FINISH });
  });
});
