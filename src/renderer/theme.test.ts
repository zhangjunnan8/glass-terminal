import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('keeps light turn details legible and Provider actions solid in both themes', () => {
    const styles = readFileSync(join(process.cwd(), 'src/renderer/styles.css'), 'utf8');
    const rule = (selector: string) => {
      const start = styles.indexOf(`${selector} {`);
      expect(start, `missing CSS rule: ${selector}`).toBeGreaterThanOrEqual(0);
      return styles.slice(start, styles.indexOf('}', start) + 1);
    };

    expect(rule('.app-shell[data-theme="light"] .agent-turn-process'))
      .toContain('background: #f5f8fa');
    expect(rule('.app-shell[data-theme="light"] .agent-turn-process-message'))
      .toContain('background: #ffffff');
    expect(rule('.provider-configure.primary')).toContain('background: #18846c');
    expect(rule('.app-shell[data-theme="light"] .provider-configure.primary'))
      .toContain('background: #18846c');
    expect(styles).toContain('.provider-configure:not(.primary)');
  });
});
