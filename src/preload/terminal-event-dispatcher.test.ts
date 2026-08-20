import { describe, expect, it, vi } from 'vitest';
import { createTerminalEventDispatcher } from './terminal-event-dispatcher';

interface TestEvent {
  terminalId: string;
  sequence: number;
}

describe('terminal event dispatcher', () => {
  it('registers one upstream listener and routes only to the exact terminal', () => {
    let dispatch: ((event: TestEvent) => void) | undefined;
    const register = vi.fn((listener: (event: TestEvent) => void) => {
      dispatch = listener;
    });
    const subscribe = createTerminalEventDispatcher(register);
    const first = vi.fn();
    const second = vi.fn();
    subscribe('terminal-1', first);
    subscribe('terminal-2', second);

    dispatch!({ terminalId: 'terminal-2', sequence: 1 });

    expect(register).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ terminalId: 'terminal-2', sequence: 1 });
  });

  it('preserves subscription order for multiple listeners and removes empty routes', () => {
    let dispatch: ((event: TestEvent) => void) | undefined;
    const subscribe = createTerminalEventDispatcher<TestEvent>((listener) => {
      dispatch = listener;
    });
    const order: string[] = [];
    const removeFirst = subscribe('terminal-1', () => order.push('first'));
    const removeSecond = subscribe('terminal-1', () => order.push('second'));

    dispatch!({ terminalId: 'terminal-1', sequence: 1 });
    removeFirst();
    removeFirst();
    dispatch!({ terminalId: 'terminal-1', sequence: 2 });
    removeSecond();
    dispatch!({ terminalId: 'terminal-1', sequence: 3 });

    expect(order).toEqual(['first', 'second', 'second']);
  });

  it('keeps later subscribers alive when one renderer callback throws', () => {
    let dispatch: ((event: TestEvent) => void) | undefined;
    const subscribe = createTerminalEventDispatcher<TestEvent>((listener) => {
      dispatch = listener;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const survivor = vi.fn();
    subscribe('terminal-1', () => { throw new Error('closed component'); });
    subscribe('terminal-1', survivor);

    dispatch!({ terminalId: 'terminal-1', sequence: 1 });

    expect(survivor).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
