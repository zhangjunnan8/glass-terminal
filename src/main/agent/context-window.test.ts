// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from './agent-backend';
import {
  agentContextBudget,
  agentContextUsage,
  compactCompletedWorkspaceHistory,
  compressContextIfNeeded,
  estimateAgentContextTokens,
  estimateAgentMessagesTokens,
  estimateAgentToolSchemaTokens,
  estimateTextTokens,
} from './context-window';
import { agentToolDefinitionsForAccess } from './agent-tool-definitions';
import {
  STRUCTURED_SUMMARY_PREFIX,
  parseStructuredContextSummary,
} from './structured-context-summary';

function structuredSummary(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    goal: 'Continue the retained coding task.',
    constraints: [],
    decisions: [],
    completed: [],
    artifacts: [],
    failures: [],
    pending: ['Continue the current request.'],
    nextSteps: ['Continue the current request.'],
    ...overrides,
  });
}

describe('Agent context window', () => {
  it('keeps an explicit output reserve out of the Provider input budget', () => {
    const budget = agentContextBudget(
      [{ role: 'user', content: 'hello' }],
      8_192,
      { safetyFactor: 1 },
    );
    expect(budget.inputLimitTokens + budget.outputReserveTokens).toBe(8_192);
    expect(budget.outputReserveTokens).toBeGreaterThan(1_000);
    expect(budget.fits).toBe(true);
  });

  it('uses a conservative provider-agnostic token estimate for ASCII and CJK text', () => {
    expect(estimateTextTokens('a'.repeat(40))).toBe(10);
    expect(estimateTextTokens('上下文压缩')).toBe(5);
    expect(estimateTextTokens('{}[]():;,'.repeat(4)))
      .toBeGreaterThan(estimateTextTokens('a'.repeat(36)));
    expect(estimateAgentMessagesTokens([
      { role: 'user', content: '上下文' },
      { role: 'assistant', content: 'done' },
    ])).toBeGreaterThan(10);
  });

  it('includes exact exposed tool schemas, wrapping overhead, and the configured safety factor', () => {
    const messages: AgentMessage[] = [{
      role: 'assistant',
      content: '```ts\nconst result = await run();\n```',
      toolCalls: [{
        id: 'call-1',
        name: 'workspace_read_file',
        arguments: '{"path":"源码/index.ts"}',
      }],
    }];
    const offTools = agentToolDefinitionsForAccess({
      fileAccessMode: 'off',
      workspaceAvailable: false,
      workspaceEnabled: false,
      workspaceRead: false,
    });
    const readTools = agentToolDefinitionsForAccess({
      fileAccessMode: 'read-only',
      workspaceAvailable: true,
      workspaceEnabled: true,
      workspaceRead: true,
    });
    const writeTools = agentToolDefinitionsForAccess({
      fileAccessMode: 'read-write',
      workspaceAvailable: true,
      workspaceEnabled: true,
      workspaceRead: true,
    });

    expect(offTools).toHaveLength(3);
    expect(readTools).toHaveLength(8);
    expect(writeTools).toHaveLength(13);
    expect(estimateAgentToolSchemaTokens(offTools))
      .toBeLessThan(estimateAgentToolSchemaTokens(readTools));
    expect(estimateAgentToolSchemaTokens(readTools))
      .toBeLessThan(estimateAgentToolSchemaTokens(writeTools));

    const raw = estimateAgentContextTokens(messages, { tools: readTools, safetyFactor: 1 });
    const guarded = estimateAgentContextTokens(messages, { tools: readTools, safetyFactor: 1.5 });
    expect(raw.messageEstimatedTokens).toBe(estimateAgentMessagesTokens(messages));
    expect(raw.toolSchemaEstimatedTokens).toBeGreaterThan(0);
    expect(raw.fixedOverheadTokens).toBeGreaterThan(0);
    expect(guarded.estimatedTokens).toBe(Math.ceil(raw.estimatedTokens * 1.5));
  });

  it('removes completed Workspace bodies after one reasoning step', () => {
    const secret = 'FULL-FILE-BODY-CANARY';
    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{
          id: 'read-1',
          name: 'workspace_read_file',
          arguments: JSON.stringify({ path: 'src/app.ts', content: secret }),
        }],
      },
      {
        role: 'tool',
        toolCallId: 'read-1',
        content: JSON.stringify({ ok: true, path: 'src/app.ts', bytes: 99, content: secret }),
      },
      { role: 'assistant', content: 'The file was inspected.' },
    ];

    expect(compactCompletedWorkspaceHistory(messages)).toBe(true);
    expect(JSON.stringify(messages)).not.toContain(secret);
    expect(messages[0]).toMatchObject({
      toolCalls: [{ arguments: '{"historyCompacted":true}' }],
    });
    expect(messages[1]).toMatchObject({ content: expect.stringContaining('"compacted":true') });
  });

  it('keeps an unconsumed halted tool group intact until a later Provider request', () => {
    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolResultsPending: true,
        toolCalls: [{
          id: 'pending-write',
          name: 'workspace_write_file',
          arguments: JSON.stringify({ path: 'a.txt', content: 'UNCONSUMED-CANARY' }),
        }],
      },
      {
        role: 'tool',
        toolCallId: 'pending-write',
        content: JSON.stringify({ ok: false, code: 'CONTEXT_BUDGET_EXCEEDED' }),
      },
      { role: 'user', content: 'continue after the local halt' },
    ];

    expect(compactCompletedWorkspaceHistory(messages)).toBe(false);
    expect(JSON.stringify(messages)).toContain('UNCONSUMED-CANARY');
    delete (messages[0] as Extract<AgentMessage, { role: 'assistant' }>).toolResultsPending;
    expect(compactCompletedWorkspaceHistory(messages)).toBe(true);
    expect(JSON.stringify(messages)).not.toContain('UNCONSUMED-CANARY');
  });

  it('summarizes older turns at the safe threshold and preserves the latest complete turn', async () => {
    const messages: AgentMessage[] = [{ role: 'system', content: 'System policy.' }];
    for (let turn = 1; turn <= 5; turn += 1) {
      messages.push({ role: 'user', content: `turn-${turn}:` + '汉'.repeat(1_700) });
      messages.push({ role: 'assistant', content: `answer-${turn}` });
    }
    const summarize = vi.fn(async (_serializedHistory: string) => structuredSummary({
      goal: 'Preserve the earlier task.',
      completed: ['Turns 1-4 are complete.'],
      pending: ['Continue from turn 5.'],
      nextSteps: ['Continue from turn 5.'],
    }));

    const result = await compressContextIfNeeded(messages, 8_192, summarize, {
      now: () => '2026-08-20T00:00:00.000Z',
    });

    expect(result.compressed).toBe(true);
    expect(result.rewritten).toBe(true);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    expect(result.lastCompressedAt).toBe('2026-08-20T00:00:00.000Z');
    expect(summarize).toHaveBeenCalledOnce();
    expect(summarize.mock.calls[0]?.[0]).toContain('turn-1:');
    expect(JSON.stringify(result.messages)).not.toContain('turn-1:');
    expect(JSON.stringify(result.messages)).toContain('turn-5:');
    expect(result.messages.some((message) => (
      message.role === 'assistant' && message.contextSummary === true
    ))).toBe(true);
    expect(agentContextUsage(result.messages, 8_192).percentage).toBeLessThan(100);
  });

  it('keeps a contiguous recent suffix instead of reordering history around a large group', async () => {
    const messages: AgentMessage[] = [
      { role: 'assistant', content: 'EARLY-SMALL-MARKER' },
      { role: 'assistant', content: `LARGE-MIDDLE:${'汉'.repeat(7_000)}` },
      { role: 'user', content: 'CURRENT-REQUEST' },
      { role: 'assistant', content: 'CURRENT-ANSWER' },
    ];
    const summarize = vi.fn(async (_serializedHistory: string) => structuredSummary({
      goal: 'Preserve the ordered history.',
    }));

    const result = await compressContextIfNeeded(messages, 8_192, summarize);

    expect(summarize.mock.calls[0]?.[0]).toContain('EARLY-SMALL-MARKER');
    expect(summarize.mock.calls[0]?.[0]).toContain('LARGE-MIDDLE:');
    expect(JSON.stringify(result.messages)).not.toContain('EARLY-SMALL-MARKER');
    expect(JSON.stringify(result.messages)).toContain('CURRENT-REQUEST');
  });

  it('does not call the summarizer below the automatic threshold', async () => {
    const summarize = vi.fn(async () => 'unused');
    const messages: AgentMessage[] = [
      { role: 'system', content: 'System policy.' },
      { role: 'user', content: 'Short request.' },
      { role: 'assistant', content: 'Short answer.' },
    ];

    const result = await compressContextIfNeeded(messages, 8_192, summarize);

    expect(result.compressed).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('uses a bounded fallback when semantic summarization fails', async () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: '旧上下文'.repeat(2_500) },
      { role: 'assistant', content: '旧回复' },
      { role: 'user', content: '当前请求' },
    ];

    const result = await compressContextIfNeeded(messages, 8_192, async () => {
      throw new Error('provider unavailable');
    });

    expect(result.compressed).toBe(true);
    const summaryMessage = result.messages.find((message) => (
      message.role === 'assistant' && message.contextSummary
    ));
    expect(summaryMessage?.content).toContain(STRUCTURED_SUMMARY_PREFIX);
    const parsed = parseStructuredContextSummary(summaryMessage?.content ?? '');
    expect(parsed.goal).toBeTruthy();
    expect(parsed.pending).not.toHaveLength(0);
    expect(JSON.stringify(result.messages)).toContain('当前请求');
  });

  it('preserves durable constraint, decision, and pending fields across repeated compression', async () => {
    const messages: AgentMessage[] = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      messages.push({ role: 'user', content: `initial-${turn}:` + '汉'.repeat(1_700) });
      messages.push({ role: 'assistant', content: `initial-answer-${turn}` });
    }
    const summarize = vi.fn()
      .mockResolvedValueOnce(structuredSummary({
        constraints: ['Never push this repository.'],
        decisions: ['Use one commit per issue.'],
        pending: ['Finish issue 11.'],
      }))
      .mockResolvedValueOnce(structuredSummary({
        goal: 'Continue after another compression.',
        constraints: [],
        decisions: [],
        pending: ['Run the final tests.'],
      }));

    const first = await compressContextIfNeeded(messages, 8_192, summarize);
    const continued = [...first.messages];
    for (let turn = 1; turn <= 4; turn += 1) {
      continued.push({ role: 'user', content: `continued-${turn}:` + '新'.repeat(1_700) });
      continued.push({ role: 'assistant', content: `continued-answer-${turn}` });
    }
    const second = await compressContextIfNeeded(continued, 8_192, summarize);
    const finalSummary = second.messages.find((message) => (
      message.role === 'assistant' && message.contextSummary
    ));
    const parsed = parseStructuredContextSummary(finalSummary?.content ?? '');

    expect(second.compressed).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(parsed.constraints).toContain('Never push this repository.');
    expect(parsed.decisions).toContain('Use one commit per issue.');
    expect(parsed.pending).toEqual(expect.arrayContaining([
      'Finish issue 11.',
      'Run the final tests.',
    ]));
  });

  it('does not swallow cancellation errors while generating a summary', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by user'));
    const messages: AgentMessage[] = [
      { role: 'user', content: '旧上下文'.repeat(2_500) },
      { role: 'assistant', content: '旧回复' },
      { role: 'user', content: '当前请求' },
    ];

    await expect(compressContextIfNeeded(
      messages,
      8_192,
      async () => {
        throw new Error('provider cancellation');
      },
      { signal: controller.signal },
    )).rejects.toThrow('provider cancellation');
  });
});
