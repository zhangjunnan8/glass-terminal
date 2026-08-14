import { describe, expect, it } from 'vitest';
import { TerminalInteractionDetector } from './interaction-detector';

describe('TerminalInteractionDetector', () => {
  it('detects an ANSI-decorated authentication prompt split across chunks', () => {
    const detector = new TerminalInteractionDetector();
    expect(detector.push('\x1b[33m[sudo] pass')).toBeNull();
    expect(detector.push('word for tester:\x1b[0m ')).toEqual({ kind: 'authentication' });
  });

  it('does not flag ordinary prose containing the word password', () => {
    const detector = new TerminalInteractionDetector();
    expect(detector.push('The password policy was updated successfully.\r\n')).toBeNull();
    expect(detector.push('passwordless login is enabled')).toBeNull();
  });

  it.each([
    ['Continue? [Y/n]', 'y'],
    ['Proceed? [y/N]', 'n'],
    ['Install package (Y/n)', 'y'],
  ] as const)('chooses the displayed default for %s', (prompt, answer) => {
    const detector = new TerminalInteractionDetector();
    expect(detector.push(prompt)).toEqual({ kind: 'confirmation', answer });
  });

  it('can be rearmed for a repeated authentication prompt', () => {
    const detector = new TerminalInteractionDetector();
    expect(detector.push('Password: ')).toEqual({ kind: 'authentication' });
    expect(detector.push('\r\nPassword: ')).toBeNull();
    detector.rearm();
    expect(detector.push('Password: ')).toEqual({ kind: 'authentication' });
  });

  it('does not invent a confirmation answer without one displayed uppercase default', () => {
    const detector = new TerminalInteractionDetector();
    expect(detector.push('Continue? [y/n] ')).toBeNull();

    const ambiguous = new TerminalInteractionDetector();
    expect(ambiguous.push('Continue? [Y/N] ')).toBeNull();
  });
});
