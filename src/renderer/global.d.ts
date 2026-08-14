import type { DesktopBridge } from '../shared/ipc';

declare global {
  interface Window {
    aiTerminal: DesktopBridge;
  }
}

export {};
