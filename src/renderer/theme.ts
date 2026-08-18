export type UiTheme = 'dark' | 'light';

export const UI_THEME_STORAGE_KEY = 'ai-terminal:ui-theme';

/** Resolves a stored preference (which may be `system`) to a concrete theme. */
export function resolveUiTheme(theme: 'system' | UiTheme): UiTheme {
  if (theme === 'system') {
    try {
      return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }
  return theme;
}

export function readUiTheme(storage: Pick<Storage, 'getItem'> = window.localStorage): UiTheme {
  try {
    return storage.getItem(UI_THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
export function storeUiTheme(
  theme: UiTheme,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try {
    storage.setItem(UI_THEME_STORAGE_KEY, theme);
  } catch {
    // The UI remains usable when storage is disabled or at quota.
  }
}
