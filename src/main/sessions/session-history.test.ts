import { describe, expect, it } from 'vitest';
import { conversationPreview, plainTerminalPreview } from './session-history';

function chat(id: string, role: 'user' | 'assistant', content: string) {
  return {
    type: 'chat',
    item: { id, role, content, createdAt: '2026-08-16T00:00:00.000Z' },
  };
}

describe('Session history preview', () => {
  it('replays the latest user replacement without showing invalidated responses', () => {
    const preview = conversationPreview([
      chat('user-1', 'user', 'old request'),
      chat('assistant-1', 'assistant', 'old answer'),
      {
        type: 'chat_action',
        action: 'replace',
        targetMessageId: 'user-1',
        replacementItem: {
          id: 'user-2',
          role: 'user',
          content: 'new request',
          createdAt: '2026-08-16T00:01:00.000Z',
        },
      },
      chat('assistant-2', 'assistant', 'new answer'),
    ], false);

    expect(preview.messages.map((message) => message.content)).toEqual([
      'new request',
      'new answer',
    ]);
    expect(preview.truncated).toBe(false);
  });

  it('fails closed when a bounded tail retracts a target outside the preview', () => {
    const preview = conversationPreview([
      chat('assistant-old', 'assistant', 'stale answer'),
      { type: 'chat_action', action: 'retract', targetMessageId: 'missing-user' },
      chat('user-new', 'user', 'next request'),
    ], true);

    expect(preview.messages.map((message) => message.content)).toEqual(['next request']);
    expect(preview.truncated).toBe(true);
  });

  it('removes terminal control sequences from the plain-text preview', () => {
    expect(plainTerminalPreview('\u001b[31mred\u001b[0m\r\nplain\u0007'))
      .toBe('red\r\nplain');
  });

  it('rebuilds chat DTOs without forwarding unknown persisted fields', () => {
    const preview = conversationPreview([{
      type: 'chat',
      item: {
        id: 'message',
        role: 'assistant',
        content: 'safe content',
        createdAt: '2026-08-16T00:00:00.000Z',
        untrustedInternalField: { secret: true },
      },
    }], false);

    expect(preview.messages).toEqual([{
      id: 'message',
      role: 'assistant',
      content: 'safe content',
      createdAt: '2026-08-16T00:00:00.000Z',
    }]);
  });

  it('replays the persisted process/summary presentation for a completed turn', () => {
    const preview = conversationPreview([
      {
        type: 'chat',
        item: {
          id: 'step-1',
          role: 'assistant',
          content: 'intermediate work',
          createdAt: '2026-08-16T00:00:00.000Z',
          turnId: 'turn-1',
          presentation: 'intermediate',
        },
      },
      {
        type: 'chat',
        item: {
          id: 'summary-1',
          role: 'assistant',
          content: 'final summary',
          createdAt: '2026-08-16T00:01:00.000Z',
          turnId: 'turn-1',
          presentation: 'intermediate',
        },
      },
      {
        type: 'chat_presentation',
        targetMessageId: 'summary-1',
        presentation: 'summary',
      },
    ], false);

    expect(preview.messages).toEqual([
      expect.objectContaining({ id: 'step-1', turnId: 'turn-1', presentation: 'intermediate' }),
      expect.objectContaining({ id: 'summary-1', turnId: 'turn-1', presentation: 'summary' }),
    ]);
  });
});
