export type UiTheme = 'dark' | 'light';

export const UI_THEME_STORAGE_KEY = 'ai-terminal:ui-theme';

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
