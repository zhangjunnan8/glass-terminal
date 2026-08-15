export type TerminalShortcutAction = 'copy' | 'paste';

export interface TerminalShortcutEvent {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface TerminalContextMenuPosition {
  left: number;
  top: number;
}

export const TERMINAL_CONTEXT_MENU_WIDTH = 210;
export const TERMINAL_CONTEXT_MENU_HEIGHT = 190;

export function terminalPasteAllowed(inputMode: string): boolean {
  return inputMode !== 'locked';
}

/**
 * Keep the terminal shortcuts identical for local PTYs and SSH channels.
 * Ctrl+C remains available to interrupt the foreground process; copying uses
 * the conventional terminal Ctrl+Shift+C chord instead.
 */
export function terminalShortcutAction(
  event: TerminalShortcutEvent,
): TerminalShortcutAction | null {
  if (event.altKey || event.metaKey) return null;

  const key = event.key.toLowerCase();
  if (event.ctrlKey && event.shiftKey && key === 'c') return 'copy';
  if (event.ctrlKey && event.shiftKey && key === 'v') return 'paste';
  if (event.ctrlKey && !event.shiftKey && key === 'insert') return 'copy';
  if (!event.ctrlKey && event.shiftKey && key === 'insert') return 'paste';
  return null;
}

export function positionTerminalContextMenu(
  pointerX: number,
  pointerY: number,
  paneWidth: number,
  paneHeight: number,
  menuWidth = TERMINAL_CONTEXT_MENU_WIDTH,
  menuHeight = TERMINAL_CONTEXT_MENU_HEIGHT,
): TerminalContextMenuPosition {
  const inset = 6;
  return {
    left: Math.max(inset, Math.min(pointerX, paneWidth - menuWidth - inset)),
    top: Math.max(inset, Math.min(pointerY, paneHeight - menuHeight - inset)),
  };
}
