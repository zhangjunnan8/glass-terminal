import { describe, expect, it } from 'vitest';
import { buildCommandEnvelope, SentinelCapture } from './structured-command';

function decodedPowerShellPayloads(input: string): string[] {
  return [...input.matchAll(/\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/gu)]
    .map((match) => Buffer.from(match[1], 'base64').toString('utf16le'));
}

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

  it('prints a literal PowerShell command before capture and executes the original payload', () => {
    const command = "Write-Output 'plain $value; & still-data'";
    const envelope = buildCommandEnvelope('powershell', command, '0011223344556677');
    const [executionPayload, displayPayload] = decodedPowerShellPayloads(envelope.input);
    const displayIndex = envelope.input.indexOf('[Console]::WriteLine($__ait_display)');
    const startIndex = envelope.input.indexOf("':START'+[char]31");

    expect(executionPayload).toBe(command);
    expect(displayPayload).toBe(`$ ${command}`);
    expect(envelope.input).not.toContain(command);
    expect(envelope.input).toContain('[ScriptBlock]::Create($__ait_cmd)');
    expect(displayIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(displayIndex);

    const capture = new SentinelCapture(envelope);
    capture.push(`${displayPayload}\r\n${envelope.startMarker}`);
    const completed = capture.push(`result\r\n${envelope.endPrefix}0${envelope.endSuffix}`);
    expect(completed.output.join('')).toBe('result\r\n');
  });

  it('escapes PowerShell display controls without changing the executed command', () => {
    const command = "Write-Output \"first\r\nsecond\t\x1b[31m\u0085last\u202E\"";
    const envelope = buildCommandEnvelope('powershell', command, '8899aabbccddeeff');
    const [executionPayload, displayPayload] = decodedPowerShellPayloads(envelope.input);

    expect(executionPayload).toBe(command);
    expect(displayPayload).toBe(
      '$ Write-Output "first\\x0D\\x0Asecond\\x09\\x1B[31m\\x85last\\u202E"',
    );
    expect(displayPayload).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
    );
  });
});
