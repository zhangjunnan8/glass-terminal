import { describe, expect, it } from 'vitest';
import {
  buildCommandEnvelope,
  CommandDisplayFilter,
  EnvelopeEchoFilter,
  envelopeInputLines,
  SentinelCapture,
  stripEnvelopeEcho,
} from './structured-command';

describe('legacy structured command sentinels', () => {
  it.each(['cmd', 'posix'] as const)(
    'does not place the complete %s start marker in echoed input',
    (shellKind) => {
      const envelope = buildCommandEnvelope(shellKind, "printf 'hello'", '0123456789abcdef');
      expect(envelope.input).not.toContain(envelope.startMarker);
      expect(envelope.input).not.toContain(envelope.endPrefix);
    },
  );

  it('rejects printable PowerShell envelopes now that shell integration is required', () => {
    expect(() => buildCommandEnvelope(
      'powershell',
      'Get-Date',
      '0123456789abcdef',
    )).toThrow(/shell integration/i);
  });

  it('ignores echoed POSIX input and captures markers split across stream chunks', () => {
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
    const envelope = buildCommandEnvelope('posix', 'false', 'fedcba9876543210');
    const capture = new SentinelCapture(envelope);
    capture.push(envelope.startMarker);
    const large = 'x'.repeat(70 * 1024);
    const partial = capture.push(large);
    const completed = capture.push(`${envelope.endPrefix}7${envelope.endSuffix}`);

    expect(partial.output.join('').length).toBeGreaterThan(0);
    expect(completed.exitCode).toBe(7);
    expect(partial.output.join('') + completed.output.join('')).toBe(large);
  });

  it('re-presents the clean POSIX command and retains the following prompt', () => {
    const envelope = buildCommandEnvelope('posix', 'whoami', 'abcdef0123456789');
    const filter = new CommandDisplayFilter(envelope, 'whoami', 'posix');

    expect(filter.push(`${envelope.input}\r\n${envelope.startMarker}`)).toBe('$ whoami\r\n');
    const end = `${envelope.endPrefix}0${envelope.endSuffix}`;
    const display = filter.push(`alice\r\n${end}\r\ntester@host:~$ `);
    expect(display).toContain('alice');
    expect(display).toContain('tester@host:~$');
    expect(display).not.toContain(envelope.endPrefix);
    expect(filter.push('next prompt echo')).toBe('next prompt echo');
  });
});

describe('legacy envelope echo filtering', () => {
  it('keeps ordinary terminal lines untouched when nothing matches', () => {
    const recent = [envelopeInputLines(
      buildCommandEnvelope('cmd', 'dir', '1122334455667788').input,
    )];
    const data = 'C:\\work> echo hello\r\nhello\r\nC:\\work> ';
    expect(stripEnvelopeEcho(data, recent)).toBe(data);
  });

  it('hides cmd envelope input lines resurfaced by a later redraw', () => {
    const envelope = buildCommandEnvelope('cmd', 'dir', '1122334455667788');
    const recent = [envelopeInputLines(envelope.input)];
    const echoedInput = envelope.input.replaceAll('\r', '\r\n');
    const redraw = `C:\\work>\r\n${echoedInput}visible output\r\nC:\\work> `;
    const output = stripEnvelopeEcho(redraw, recent);

    expect(output).toContain('visible output');
    expect(output).not.toContain('__ait_a');
    expect(output).not.toContain('__AI_TERMINAL_');
  });

  it('holds a split private prefix and releases it unchanged when data diverges', () => {
    const envelope = buildCommandEnvelope('cmd', 'echo hi', '0011223344556677');
    const filter = new EnvelopeEchoFilter();
    filter.remember(envelope.input);
    const privateLine = [...envelopeInputLines(envelope.input)]
      .find((line) => line.length >= 30 && line.includes('__ait_'))!;
    const prefix = privateLine.slice(0, 30);

    expect(filter.push(`ordinary\r\n${prefix}`)).toBe('ordinary\r\n');
    expect(filter.push('not-the-rest\r\n')).toBe(`${prefix}not-the-rest\r\n`);
  });

  it('collects every cmd envelope input line', () => {
    const envelope = buildCommandEnvelope('cmd', 'echo hi', '9988776655443322');
    const lines = envelopeInputLines(envelope.input);
    expect(lines.size).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect(line).not.toMatch(/[\r\n]/u);
  });
});
