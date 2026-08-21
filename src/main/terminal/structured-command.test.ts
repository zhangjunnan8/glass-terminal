import { describe, expect, it } from 'vitest';
import {
  buildCommandEnvelope,
  CommandDisplayFilter,
  EnvelopeEchoFilter,
  envelopeInputLines,
  SentinelCapture,
  stripEnvelopeEcho,
} from './structured-command';

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
    const startIndex = envelope.input.indexOf("'_START__')");

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

  it('strips the envelope echo and start sentinel, re-presenting the clean command', () => {
    const envelope = buildCommandEnvelope('posix', 'whoami', 'abcdef0123456789');
    const filter = new CommandDisplayFilter(envelope, 'whoami', 'posix');

    const display = filter.push(`${envelope.input}\r\n${envelope.startMarker}`);
    expect(display).toBe('$ whoami\r\n');
    expect(display).not.toContain(envelope.startMarker);
    expect(display).not.toContain('__ait_a');
  });

  it('hides the end sentinel and keeps command output and the following prompt', () => {
    const envelope = buildCommandEnvelope('posix', 'whoami', 'abcdef0123456789');
    const filter = new CommandDisplayFilter(envelope, 'whoami', 'posix');
    filter.push(`${envelope.input}\r\n${envelope.startMarker}`);
    const end = `${envelope.endPrefix}0${envelope.endSuffix}`;

    const display = filter.push(`alice\r\n${end}\r\ntester@host:~$ `);
    expect(display).toContain('alice');
    expect(display).toContain('tester@host:~$');
    expect(display).not.toContain(envelope.endPrefix);
    expect(display).not.toContain(envelope.startMarker);

    // Once complete, subsequent stream data passes through unchanged.
    expect(filter.push('next prompt echo')).toBe('next prompt echo');
  });
});

describe('envelope echo redraw filtering', () => {
  it('hides envelope input lines resurfaced by a later full-screen redraw', () => {
    const envelope = buildCommandEnvelope('powershell', 'Get-Date', 'abcdef0123456789');
    const recent = [envelopeInputLines(envelope.input)];
    const redraw = [
      '\x1b[H(base) PS C:\\Users\\tester> \r\n',
      `\x1b[92m${envelope.input}\x1b[m\r\n`,
      '(base) PS C:\\Users\\tester> ^C\r\n',
      '(base) PS C:\\Users\\tester> ',
    ].join('');

    const output = stripEnvelopeEcho(redraw, recent);
    expect(output).toContain('(base) PS C:\\Users\\tester>');
    expect(output).toContain('^C');
    expect(output).not.toContain('__ait_a');
    expect(output).not.toContain('__ait_cmd');
    expect(output).not.toContain('Get-Date');
  });

  it('keeps ordinary terminal lines untouched when nothing matches', () => {
    const recent = [envelopeInputLines(buildCommandEnvelope('cmd', 'dir', '1122334455667788').input)];
    const data = 'C:\\work> echo hello\r\nhello\r\nC:\\work> ';
    expect(stripEnvelopeEcho(data, recent)).toBe(data);
  });

  it('hides a PowerShell envelope hard-wrapped to a narrower Windows PTY', () => {
    const envelope = buildCommandEnvelope(
      'powershell',
      "Get-ChildItem 'C:\\Program Files' | Select-Object -First 5",
      'aabbccddeeff0011',
    );
    const input = envelope.input.replace(/\r+$/u, '');
    const wrapped = [...input.matchAll(/[\s\S]{1,31}/gu)].map((match) => match[0]).join('\r\n');
    const recent = [envelopeInputLines(envelope.input)];
    const redraw = [
      '\x1b[2J\x1b[HPS C:\\Users\\tester> ',
      `\x1b[92m${wrapped}\x1b[m\r\n`,
      'command output stays visible\r\n',
      'PS C:\\Users\\tester> ',
    ].join('');

    const output = stripEnvelopeEcho(redraw, recent);
    expect(output).toContain('PS C:\\Users\\tester>');
    expect(output).toContain('command output stays visible');
    expect(output).not.toContain('__ait_');
    expect(output).not.toContain('FromBase64String');
  });

  it('hides a wrapped envelope split across redraw data events', () => {
    const envelope = buildCommandEnvelope('powershell', 'Get-Date', '1234567890abcdef');
    const input = envelope.input.replace(/\r+$/u, '');
    const wrapped = [...input.matchAll(/[\s\S]{1,27}/gu)].map((match) => match[0]).join('\r\n');
    const redraw = `\x1b[HPS C:\\work> ${wrapped}\r\nPS C:\\work> `;
    const splitAt = Math.floor(redraw.length / 2);
    const filter = new EnvelopeEchoFilter();
    filter.remember(envelope.input);

    const first = filter.push(redraw.slice(0, splitAt));
    const second = filter.push(redraw.slice(splitAt));
    const output = first + second;

    expect(first).toContain('PS C:\\work>');
    expect(output).toContain('PS C:\\work>');
    expect(output).not.toContain('__ait_');
    expect(output).not.toContain('FromBase64String');
  });

  it('hides overlapping partial PowerShell redraws during rapid large resizes', () => {
    const envelope = buildCommandEnvelope(
      'powershell',
      "Get-ChildItem 'C:\\Windows\\System32' | Select-Object -First 20",
      'fedcba0987654321',
    );
    const input = envelope.input.replace(/\r+$/u, '');
    const fragments = [
      input.slice(0, 143),
      input.slice(0, 91),
      input.slice(76, 278),
      input.slice(244, 511),
      input.slice(480),
    ];
    const redraw = [
      'PS C:\\work> ',
      `\x1b[2K${fragments[0]}   \r\n`,
      `\x1b[1A\x1b[2K${fragments[1]}     \r\n`,
      `\x1b[2K${fragments[2]} \r\n`,
      `\x1b[2K${fragments[3]}       \r\n`,
      `\x1b[2K${fragments[4]}\r\n`,
      'visible after resize\r\nPS C:\\work> ',
    ].join('');
    const filter = new EnvelopeEchoFilter('powershell');
    filter.remember(envelope.input);
    filter.noteResize();

    const cuts = [73, 219, 487, redraw.length];
    let previous = 0;
    let output = '';
    for (const cut of cuts) {
      output += filter.push(redraw.slice(previous, cut));
      previous = cut;
    }

    expect(output).toContain('visible after resize');
    expect(output).toContain('PS C:\\work>');
    expect(output).not.toContain('__ait_');
    expect(output).not.toContain('FromBase64String');
    expect(output).not.toContain('fedcba09');
  });

  it('drops repeated completed PowerShell transcript redraws from the real ConPTY shape', () => {
    const command = 'echo "Hello, Glass Terminal!"';
    const nonce = '02336944c80d414fbc7c47bd6a49e0d5';
    const envelope = buildCommandEnvelope('powershell', command, nonce);
    const completedBlock = [
      `$ ${command}\r\n`,
      `${envelope.startMarker}\r\n`,
      'Hello, Glass Terminal!\r\n',
      `${envelope.endPrefix}0${envelope.endSuffix}\r\n`,
      '(base) PS C:\\Users\\zjn> ',
    ].join('');
    const clippedThenComplete = [
      `$ ${command}\r\n`,
      `      ERMINAL_${nonce.slice(6)}\r\n`,
      completedBlock,
    ].join('');
    const redraw = `${completedBlock}\r\n${clippedThenComplete}\r\n${completedBlock}`;
    const filter = new EnvelopeEchoFilter('powershell');
    filter.remember(envelope.input, envelope, command);
    filter.complete(envelope.startMarker);
    filter.noteResize();

    const cuts = [81, 207, 419, 600, redraw.length];
    let previous = 0;
    let output = '';
    for (const cut of cuts) {
      output += filter.push(redraw.slice(previous, cut));
      previous = cut;
    }

    expect(output).not.toContain(command);
    expect(output).not.toContain('Hello, Glass Terminal!');
    expect(output).not.toContain('__AI_TERMINAL_');
    expect(output).not.toContain(`ERMINAL_${nonce.slice(6, 18)}`);
    expect(output).not.toContain('(base) PS C:\\Users\\zjn>');
    expect(filter.push('\r\nfresh output\r\n')).toContain('fresh output');
  });

  it('keeps ordinary resize-time output that has no completed transcript nonce', () => {
    const command = 'echo "Hello, Glass Terminal!"';
    const envelope = buildCommandEnvelope(
      'powershell',
      command,
      '12344321123443211234432112344321',
    );
    const filter = new EnvelopeEchoFilter('powershell');
    filter.remember(envelope.input, envelope, command);
    filter.complete(envelope.startMarker);
    filter.noteResize();

    const output = 'build still running\r\nnew output remains visible\r\n';
    expect(filter.push(output)).toBe(output);
  });

  it('does not enable partial-redraw suppression for POSIX shells', () => {
    const envelope = buildCommandEnvelope('posix', 'printf hello', 'abcdef1234567890');
    const fragment = [...envelopeInputLines(envelope.input)][0]!.slice(4, 38);
    const filter = new EnvelopeEchoFilter('posix');
    filter.remember(envelope.input);
    filter.noteResize();

    expect(filter.push(`literal ${fragment} output\r\n`)).toBe(`literal ${fragment} output\r\n`);
  });

  it('releases a partial private prefix unchanged when later data diverges', () => {
    const envelope = buildCommandEnvelope('powershell', 'Get-Date', '0011223344556677');
    const filter = new EnvelopeEchoFilter();
    filter.remember(envelope.input);
    const prefix = envelope.input.slice(0, 30);

    expect(filter.push(`ordinary\r\n${prefix}`)).toBe('ordinary\r\n');
    expect(filter.push('not-the-rest\r\n')).toBe(`${prefix}not-the-rest\r\n`);
  });

  it('collects every envelope input line including cmd multi-line envelopes', () => {
    const envelope = buildCommandEnvelope('cmd', 'echo hi', '9988776655443322');
    const lines = envelopeInputLines(envelope.input);
    expect(lines.size).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      expect(line).not.toMatch(/[\r\n]/u);
    }
  });
});
