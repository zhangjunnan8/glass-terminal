import type { ITheme } from '@xterm/xterm';
import type { UiTheme } from './theme';

const DARK_TERMINAL_THEME: ITheme = {
  background: '#080c12',
  foreground: '#d7e0ed',
  cursor: '#6de6c3',
  cursorAccent: '#0b1018',
  selectionBackground: '#315f6d88',
  black: '#0a0f16',
  red: '#f07178',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#c0caf5',
  brightBlack: '#565f89',
};

const LIGHT_TERMINAL_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#172033',
  cursor: '#087f68',
  cursorAccent: '#ffffff',
  selectionBackground: '#80cbbd66',
  black: '#1b2433',
  red: '#b42336',
  green: '#287a45',
  yellow: '#8a5a00',
  blue: '#245cba',
  magenta: '#7b3fb0',
  cyan: '#087b8f',
  white: '#d8dee8',
  brightBlack: '#657184',
  brightRed: '#d52d45',
  brightGreen: '#318b51',
  brightYellow: '#a86b00',
  brightBlue: '#356fd1',
  brightMagenta: '#914fc5',
  brightCyan: '#0b8fa5',
  brightWhite: '#f7f9fc',
};

export function terminalTheme(theme: UiTheme): ITheme {
  return theme === 'light' ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
}
