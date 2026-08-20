// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from './agent-backend';
import {
  deterministicStructuredContextSummary,
  mergeStructuredContextSummaries,
  parseStructuredContextSummary,
  serializeStructuredContextSummary,
  type StructuredContextSummary,
} from './structured-context-summary';

function summary(overrides: Partial<StructuredContextSummary> = {}): StructuredContextSummary {
  return {
    version: 1,
    goal: 'Complete the current task.',
    constraints: [],
    decisions: [],
    completed: [],
    artifacts: [],
    failures: [],
    pending: [],
    nextSteps: [],
    ...overrides,
  };
}

describe('structured context summaries', () => {
  it('accepts only the fixed schema and bounded field types', () => {
    expect(parseStructuredContextSummary(serializeStructuredContextSummary(summary({
      constraints: ['Do not push.'],
      pending: ['Run tests.'],
    })))).toEqual(summary({
      constraints: ['Do not push.'],
      pending: ['Run tests.'],
    }));

    expect(() => parseStructuredContextSummary('{"version":1,"goal":"x"}'))
      .toThrow(/field constraints/u);
    expect(() => parseStructuredContextSummary(JSON.stringify({
      ...summary(),
      unexpected: true,
    }))).toThrow(/schema/u);
    expect(() => parseStructuredContextSummary(JSON.stringify(summary({
      pending: ['x'.repeat(301)],
    })))).toThrow(/pending/u);
  });

  it('rejects apparent credentials before they can enter a persisted summary', () => {
    expect(() => parseStructuredContextSummary(JSON.stringify(summary({
      decisions: ['api_key=super-secret-value'],
    })))).toThrow(/credential/u);
  });

  it('retains prior constraints, decisions, and pending items when a later summary omits them', () => {
    const previous = summary({
      constraints: ['No push.'],
      decisions: ['Commit each issue separately.'],
      pending: ['Finish issue 11.'],
    });
    const merged = mergeStructuredContextSummaries(summary({
      goal: 'Continue after compaction.',
      pending: ['Run the build.'],
    }), [previous]);

    expect(merged.constraints).toContain('No push.');
    expect(merged.decisions).toContain('Commit each issue separately.');
    expect(merged.pending).toEqual(expect.arrayContaining([
      'Finish issue 11.',
      'Run the build.',
    ]));
  });

  it('produces a fixed-schema, secret-redacting deterministic fallback', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: '必须继续修复；api_key=super-secret-value' },
      { role: 'assistant', content: 'Changed src/main/app.ts.' },
      {
        role: 'tool',
        toolCallId: 'call-1',
        content: JSON.stringify({ ok: false, path: 'src/main/app.ts', error: 'build failed' }),
      },
    ];
    const fallback = deterministicStructuredContextSummary(messages);
    const serialized = serializeStructuredContextSummary(fallback);

    expect(() => parseStructuredContextSummary(serialized)).not.toThrow();
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('super-secret-value');
    expect(fallback.pending).not.toHaveLength(0);
    expect(fallback.artifacts).toContain('src/main/app.ts');
    expect(fallback.failures).toContain('build failed');
  });
});
