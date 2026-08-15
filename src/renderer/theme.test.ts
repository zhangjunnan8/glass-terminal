import { describe, expect, it, vi } from 'vitest';
import { terminalTheme } from './terminal-theme';
import { readUiTheme, storeUiTheme, UI_THEME_STORAGE_KEY } from './theme';

describe('UI themes', () => {
  it('defaults unknown or unavailable storage values to dark', () => {
    expect(readUiTheme({ getItem: () => null })).toBe('dark');
    expect(readUiTheme({ getItem: () => 'unexpected' })).toBe('dark');
    expect(readUiTheme({ getItem: () => { throw new Error('blocked'); } })).toBe('dark');
  });

  it('reads and persists the application-local light preference', () => {
    const setItem = vi.fn();
    expect(readUiTheme({ getItem: () => 'light' })).toBe('light');
    storeUiTheme('light', { setItem });
    expect(setItem).toHaveBeenCalledWith(UI_THEME_STORAGE_KEY, 'light');
  });

  it('uses a white xterm surface only in light mode', () => {
    expect(terminalTheme('light')).toMatchObject({
      background: '#ffffff',
      foreground: '#172033',
    });
    expect(terminalTheme('dark')).toMatchObject({
      background: '#080c12',
      foreground: '#d7e0ed',
    });
  });
});
