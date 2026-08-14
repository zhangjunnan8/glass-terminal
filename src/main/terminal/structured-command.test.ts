import { describe, expect, it } from 'vitest';
import { buildCommandEnvelope, SentinelCapture } from './structured-command';

describe('structured command sentinel', () => {
  it.each(['powershell', 'cmd', 'posix'] as const)(
    'does not place the complete %s start marker in echoed input',
    (shellKind) => {
      const envelope = buildCommandEnvelope(shellKind, "printf 'hello'", '0123456789abcdef');
      expect(envelope.input).not.toContain(envelope.startMarker);
      expect(envelope.input).not.toContain(envelope.endPrefix);
    },
  );

  it('ignores echoed input and captures markers split across stream chunks', () => {
    const envelope = buildCommandEnvelope('posix', 'whoami', 'abcdef0123456789');
    const capture = new SentinelCapture(envelope);
    const start = envelope.startMarker;
    const end = `${envelope.endPrefix}0${envelope.endSuffix}`;

    expect(capture.push(`${envelope.input}\r\n${start.slice(0, 8)}`).output).toEqual([]);
    expect(capture.push(`${start.slice(8)}alice\r\n${end.slice(0, 10)}`)).toMatchObject({
      completed: false,
    });
    const completed = capture.push(end.slice(10));

    expect(completed.completed).toBe(true);
    expect(completed.exitCode).toBe(0);
    expect(completed.output.join('')).toBe('alice\r\n');
  });

  it('reports a non-zero exit code and streams bounded output', () => {
    const envelope = buildCommandEnvelope('powershell', 'throw "boom"', 'fedcba9876543210');
    const capture = new SentinelCapture(envelope);
    capture.push(envelope.startMarker);
    const large = 'x'.repeat(70 * 1024);
    const partial = capture.push(large);
    const completed = capture.push(`${envelope.endPrefix}7${envelope.endSuffix}`);

    expect(partial.output.join('').length).toBeGreaterThan(0);
    expect(completed.exitCode).toBe(7);
    expect(partial.output.join('') + completed.output.join('')).toBe(large);
  });
});
