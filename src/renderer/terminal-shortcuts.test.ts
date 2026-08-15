import { describe, expect, it } from 'vitest';
import {
  positionTerminalContextMenu,
  terminalPasteAllowed,
  terminalShortcutAction,
} from './terminal-shortcuts';

function keyEvent(overrides: Partial<Parameters<typeof terminalShortcutAction>[0]>) {
  return {
    key: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

describe('terminal shortcuts', () => {
  it('uses Ubuntu-style copy and paste chords without stealing Ctrl+C', () => {
    expect(terminalShortcutAction(keyEvent({ key: 'C', ctrlKey: true, shiftKey: true })))
      .toBe('copy');
    expect(terminalShortcutAction(keyEvent({ key: 'v', ctrlKey: true, shiftKey: true })))
      .toBe('paste');
    expect(terminalShortcutAction(keyEvent({ key: 'c', ctrlKey: true }))).toBeNull();
  });

  it('supports the conventional Insert alternatives', () => {
    expect(terminalShortcutAction(keyEvent({ key: 'Insert', ctrlKey: true }))).toBe('copy');
    expect(terminalShortcutAction(keyEvent({ key: 'Insert', shiftKey: true }))).toBe('paste');
    expect(terminalShortcutAction(keyEvent({ key: 'Insert', altKey: true }))).toBeNull();
  });

  it('blocks paste while the agent owns terminal input', () => {
    expect(terminalPasteAllowed('locked')).toBe(false);
    expect(terminalPasteAllowed('human')).toBe(true);
    expect(terminalPasteAllowed('secure-human')).toBe(true);
  });

  it('keeps the context menu within the terminal pane', () => {
    expect(positionTerminalContextMenu(790, 490, 800, 500)).toEqual({
      left: 584,
      top: 304,
    });
    expect(positionTerminalContextMenu(-20, -30, 800, 500)).toEqual({ left: 6, top: 6 });
  });
});
