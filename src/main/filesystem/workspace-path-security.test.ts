import { describe, expect, it } from 'vitest';
import {
  assertSafeWindowsRequestedPath,
  assertSafeWindowsResolvedPath,
} from './workspace-path-security';

describe('Windows Workspace path validation', () => {
  it('rejects drive-relative and device namespace spellings before resolve', () => {
    for (const path of ['C:child.txt', '\\\\?\\C:\\work\\file', '\\\\.\\PIPE\\name']) {
      expect(() => assertSafeWindowsRequestedPath(path)).toThrow();
    }
  });

  it('rejects ADS, reserved names, and trailing dot or space in raw segments', () => {
    for (const path of [
      'src\\visible.txt:hidden',
      'src\\CON.txt',
      'src\\CONIN$',
      'src\\COM¹.log',
      'src\\trailing.',
      'src\\trailing ',
    ]) expect(() => assertSafeWindowsRequestedPath(path)).toThrow();
  });

  it('allows normal absolute/relative paths and checks the resolved root boundary', () => {
    expect(() => assertSafeWindowsRequestedPath('C:\\work\\src\\demo.ts')).not.toThrow();
    expect(() => assertSafeWindowsRequestedPath('src\\demo.ts')).not.toThrow();
    expect(() => assertSafeWindowsResolvedPath('C:\\work', 'C:\\work\\src\\demo.ts'))
      .not.toThrow();
    expect(() => assertSafeWindowsResolvedPath('C:\\work', 'C:\\outside\\demo.ts')).toThrow();
  });
});
