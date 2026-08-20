export interface TerminalRoutedEvent {
  terminalId: string;
}

type TerminalEventListener<Event extends TerminalRoutedEvent> = (event: Event) => void;

/**
 * Owns one upstream event registration and routes payloads to subscribers for
 * the exact terminal id. The preload context owns this object for the lifetime
 * of the renderer window, so a reload naturally discards every callback map.
 */
export function createTerminalEventDispatcher<Event extends TerminalRoutedEvent>(
  registerUpstream: (dispatch: TerminalEventListener<Event>) => void,
): (terminalId: string, listener: TerminalEventListener<Event>) => () => void {
  const listeners = new Map<string, Set<TerminalEventListener<Event>>>();

  registerUpstream((event) => {
    const terminalListeners = listeners.get(event.terminalId);
    if (!terminalListeners) return;
    for (const listener of [...terminalListeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error('Terminal event listener failed:', error);
      }
    }
  });

  return (terminalId, listener) => {
    if (!terminalId) throw new Error('Terminal event subscription requires a terminal id.');
    let terminalListeners = listeners.get(terminalId);
    if (!terminalListeners) {
      terminalListeners = new Set();
      listeners.set(terminalId, terminalListeners);
    }
    terminalListeners.add(listener);
    let subscribed = true;

    return () => {
      if (!subscribed) return;
      subscribed = false;
      terminalListeners!.delete(listener);
      if (terminalListeners!.size === 0) listeners.delete(terminalId);
    };
  };
}
