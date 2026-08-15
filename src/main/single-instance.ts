export interface SingleInstanceApplication {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', listener: () => void): unknown;
}

export interface FocusableApplicationWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * Host metadata is an in-process snapshot and SSH credentials use a stable
 * per-Host Windows Credential Manager target. Multiple application processes
 * would therefore be able to race those two stores. Enforce one owner process
 * and route subsequent launches back to its existing window.
 */
export function acquireSingleInstance(
  application: SingleInstanceApplication,
  windows: () => FocusableApplicationWindow[],
): boolean {
  if (!application.requestSingleInstanceLock()) {
    application.quit();
    return false;
  }

  application.on('second-instance', () => {
    const target = windows().find((window) => !window.isDestroyed());
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  });
  return true;
}
