import { describe, expect, it, vi } from 'vitest';
import {
  acquireSingleInstance,
  type FocusableApplicationWindow,
  type SingleInstanceApplication,
} from './single-instance';

function fixture(acquired: boolean) {
  let secondInstance: (() => void) | undefined;
  const application: SingleInstanceApplication = {
    requestSingleInstanceLock: vi.fn(() => acquired),
    quit: vi.fn(),
    on: vi.fn((_event, listener) => {
      secondInstance = listener;
      return application;
    }),
  };
  return { application, trigger: () => secondInstance?.() };
}

function fakeWindow(options: { destroyed?: boolean; minimized?: boolean } = {}) {
  const window: FocusableApplicationWindow = {
    isDestroyed: vi.fn(() => Boolean(options.destroyed)),
    isMinimized: vi.fn(() => Boolean(options.minimized)),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
  return window;
}

describe('single application instance guard', () => {
  it('quits before initialization when another process owns the lock', () => {
    const current = fixture(false);
    expect(acquireSingleInstance(current.application, () => [])).toBe(false);
    expect(current.application.quit).toHaveBeenCalledOnce();
    expect(current.application.on).not.toHaveBeenCalled();
  });

  it('focuses and restores the existing live window for a second launch', () => {
    const current = fixture(true);
    const destroyed = fakeWindow({ destroyed: true });
    const live = fakeWindow({ minimized: true });
    expect(acquireSingleInstance(current.application, () => [destroyed, live])).toBe(true);

    current.trigger();

    expect(live.restore).toHaveBeenCalledOnce();
    expect(live.show).toHaveBeenCalledOnce();
    expect(live.focus).toHaveBeenCalledOnce();
    expect(destroyed.focus).not.toHaveBeenCalled();
    expect(current.application.quit).not.toHaveBeenCalled();
  });

  it('does nothing when the primary process does not yet have a live window', () => {
    const current = fixture(true);
    const destroyed = fakeWindow({ destroyed: true });
    acquireSingleInstance(current.application, () => [destroyed]);
    current.trigger();
    expect(destroyed.show).not.toHaveBeenCalled();
  });
});
