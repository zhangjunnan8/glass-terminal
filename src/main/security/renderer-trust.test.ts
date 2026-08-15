import { describe, expect, it } from 'vitest';
import {
  isTrustedRendererUrl,
  resolveDevelopmentRendererUrl,
} from './renderer-trust';

describe('renderer trust boundary', () => {
  it('only enables an unpackaged loopback development server', () => {
    expect(resolveDevelopmentRendererUrl('http://127.0.0.1:5173/', false)?.origin)
      .toBe('http://127.0.0.1:5173');
    expect(resolveDevelopmentRendererUrl('http://localhost:5173/', true)).toBeUndefined();
    expect(() => resolveDevelopmentRendererUrl('https://example.com/', false)).toThrow(
      /本机回环/,
    );
    expect(() => resolveDevelopmentRendererUrl(
      'http://127.0.0.1:5173@evil.example/',
      false,
    )).toThrow(/本机回环/);
  });

  it('compares development origins instead of string prefixes', () => {
    const entry = 'http://127.0.0.1:5173/';
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/src/main.tsx', entry, true))
      .toBe(true);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173@evil.example/p', entry, true))
      .toBe(false);
    expect(isTrustedRendererUrl('http://127.0.0.1:5174/', entry, true)).toBe(false);
  });

  it('allows only the packaged entry file, with an optional hash', () => {
    const entry = 'file:///C:/Program%20Files/AI%20Terminal/dist/index.html';
    expect(isTrustedRendererUrl(`${entry}#settings`, entry, false)).toBe(true);
    expect(isTrustedRendererUrl(
      'file:///C:/Program%20Files/AI%20Terminal/dist/other.html',
      entry,
      false,
    )).toBe(false);
    expect(isTrustedRendererUrl('https://example.com/', entry, false)).toBe(false);
  });
});
