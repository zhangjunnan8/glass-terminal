import { describe, expect, it } from 'vitest';
import {
  isAgentOutputNearBottom,
  scrollAgentOutputToBottom,
} from './agent-scroll';

describe('agent output scrolling', () => {
  it('follows exact bottom, short content, and positions within the threshold', () => {
    expect(isAgentOutputNearBottom({ scrollTop: 500, clientHeight: 300, scrollHeight: 800 })).toBe(true);
    expect(isAgentOutputNearBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 300 })).toBe(true);
    expect(isAgentOutputNearBottom({ scrollTop: 470, clientHeight: 300, scrollHeight: 800 })).toBe(true);
    expect(isAgentOutputNearBottom({ scrollTop: 460, clientHeight: 300, scrollHeight: 800 })).toBe(false);
  });

  it('moves to the latest scroll height', () => {
    const element = { scrollTop: 120, scrollHeight: 900 };
    scrollAgentOutputToBottom(element);
    expect(element.scrollTop).toBe(900);
  });
});
