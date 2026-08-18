import type { ShellProfile } from '../../shared/terminal';

export interface CommandEnvelope {
  input: string;
  startMarker: string;
  endPrefix: string;
  endSuffix: string;
}

export interface CaptureUpdate {
  output: string[];
  observed: string;
  exitCode?: number;
  completed: boolean;
}

function splitNonce(nonce: string): [string, string] {
  const midpoint = Math.floor(nonce.length / 2);
  return [nonce.slice(0, midpoint), nonce.slice(midpoint)];
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeTerminalControls(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => {
      const codePoint = character.charCodeAt(0);
      const width = codePoint <= 0xff ? 2 : 4;
      const prefix = codePoint <= 0xff ? 'x' : 'u';
      return `\\${prefix}${codePoint.toString(16).padStart(width, '0').toUpperCase()}`;
    },
  );
}

export function buildCommandEnvelope(
  shellKind: ShellProfile['kind'],
  command: string,
  nonce: string,
): CommandEnvelope {
  const [first, second] = splitNonce(nonce);
  if (shellKind === 'powershell') {
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
    const encodedDisplay = Buffer
      .from(`$ ${escapeTerminalControls(command)}`, 'utf16le')
      .toString('base64');
    const startMarker = `\x1eAI:${nonce}:START\x1f`;
    const endPrefix = `\x1eAI:${nonce}:END:`;
    const input = [
      `$__ait_a='${first}'`,
      `$__ait_b='${second}'`,
      `$__ait_cmd=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedCommand}'))`,
      `$__ait_display=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedDisplay}'))`,
      '[Console]::WriteLine($__ait_display)',
      "[Console]::WriteLine(([char]30)+'AI:'+$__ait_a+$__ait_b+':START'+[char]31)",
      '$global:LASTEXITCODE=0',
      '$__ait_ok=$true',
      'try { . ([ScriptBlock]::Create($__ait_cmd)); $__ait_ok=$? } catch { Write-Error $_; $__ait_ok=$false }',
      '$__ait_ec=if($__ait_ok){[int]$LASTEXITCODE}elseif($LASTEXITCODE -ne 0){[int]$LASTEXITCODE}else{1}',
      "[Console]::WriteLine(([char]30)+'AI:'+$__ait_a+$__ait_b+':END:'+$__ait_ec+[char]31)",
    ].join(';');
    return { input: `${input}\r`, startMarker, endPrefix, endSuffix: '\x1f' };
  }

  if (shellKind === 'cmd') {
    const startMarker = `__AI_TERMINAL_${nonce}_START__`;
    const endPrefix = `__AI_TERMINAL_${nonce}_END_`;
    const input = [
      `set "__ait_a=${first}"`,
      `set "__ait_b=${second}"`,
      'echo __AI_TERMINAL_%__ait_a%%__ait_b%_START__',
      command,
      'set "__ait_ec=%ERRORLEVEL%"',
      'echo __AI_TERMINAL_%__ait_a%%__ait_b%_END_%__ait_ec%__',
    ].join('\r');
    return { input: `${input}\r`, startMarker, endPrefix, endSuffix: '__' };
  }

  const startMarker = `\x1eAI:${nonce}:START\x1f`;
  const endPrefix = `\x1eAI:${nonce}:END:`;
  const input = [
    `__ait_a=${posixQuote(first)}`,
    `__ait_b=${posixQuote(second)}`,
    "printf '\\036AI:%s%s:START\\037\\n' \"$__ait_a\" \"$__ait_b\"",
    `__ait_cmd=${posixQuote(command)}`,
    'eval "$__ait_cmd"',
    '__ait_ec=$?',
    "printf '\\036AI:%s%s:END:%s\\037\\n' \"$__ait_a\" \"$__ait_b\" \"$__ait_ec\"",
  ].join(';');
  return { input: `${input}\r`, startMarker, endPrefix, endSuffix: '\x1f' };
}

export class SentinelCapture {
  private buffer = '';
  private started = false;
  private completed = false;

  constructor(private readonly envelope: CommandEnvelope) {}

  push(data: string): CaptureUpdate {
    if (this.completed) return { output: [], observed: '', completed: true };
    this.buffer += data;
    const output: string[] = [];
    let observed = this.started ? data : '';

    if (!this.started) {
      const startIndex = this.buffer.indexOf(this.envelope.startMarker);
      if (startIndex < 0) {
        const reserve = Math.max(0, this.envelope.startMarker.length - 1);
        if (this.buffer.length > reserve) this.buffer = this.buffer.slice(-reserve);
        return { output, observed: '', completed: false };
      }
      this.started = true;
      this.buffer = this.buffer.slice(startIndex + this.envelope.startMarker.length);
      observed = this.buffer;
    }

    const endIndex = this.buffer.indexOf(this.envelope.endPrefix);
    if (endIndex >= 0) {
      const codeStart = endIndex + this.envelope.endPrefix.length;
      const suffixIndex = this.buffer.indexOf(this.envelope.endSuffix, codeStart);
      if (suffixIndex >= 0) {
        const captured = this.buffer.slice(0, endIndex);
        if (captured) output.push(captured);
        const rawCode = this.buffer.slice(codeStart, suffixIndex).trim();
        const parsedCode = Number.parseInt(rawCode, 10);
        this.completed = true;
        this.buffer = this.buffer.slice(suffixIndex + this.envelope.endSuffix.length);
        return {
          output,
          observed,
          exitCode: Number.isFinite(parsedCode) ? parsedCode : 1,
          completed: true,
        };
      }
      const captured = this.buffer.slice(0, endIndex);
      if (captured) output.push(captured);
      this.buffer = this.buffer.slice(endIndex);
      return { output, observed, completed: false };
    }

    const reserve = Math.max(0, this.envelope.endPrefix.length - 1);
    if (this.buffer.length > reserve) {
      const flushLength = this.buffer.length - reserve;
      output.push(this.buffer.slice(0, flushLength));
      this.buffer = this.buffer.slice(flushLength);
    }
    return { output, observed, completed: false };
  }
}

function displayPrompt(shellKind: ShellProfile['kind']): string {
  if (shellKind === 'powershell') return 'PS ';
  if (shellKind === 'cmd') return '> ';
  return '$ ';
}

/**
 * Produces the human-visible stream for a structured command execution: the
 * envelope echo and START/END sentinels are stripped, the clean command is
 * re-presented with a shell prompt, and everything after the END sentinel
 * (the next shell prompt) is passed through unchanged.
 *
 * This only affects what is rendered to the user; the SentinelCapture still
 * consumes the raw stream for exit-code detection, and the journal still
 * records the raw bytes for audit/replay.
 */
export class CommandDisplayFilter {
  private readonly prompt: string;
  private readonly displayCommand: string;
  private buffer = '';
  private started = false;
  private completed = false;

  constructor(
    private readonly envelope: CommandEnvelope,
    displayCommand: string,
    shellKind: ShellProfile['kind'],
  ) {
    this.prompt = displayPrompt(shellKind);
    this.displayCommand = displayCommand;
  }

  push(data: string): string {
    if (this.completed) return data;
    this.buffer += data;

    if (!this.started) {
      const startIndex = this.buffer.indexOf(this.envelope.startMarker);
      if (startIndex < 0) {
        const reserve = Math.max(0, this.envelope.startMarker.length - 1);
        if (this.buffer.length > reserve) this.buffer = this.buffer.slice(-reserve);
        return '';
      }
      this.started = true;
      this.buffer = this.buffer.slice(startIndex + this.envelope.startMarker.length);
      return `${this.prompt}${this.displayCommand}\r\n${this.consumeUntilEnd()}`;
    }

    return this.consumeUntilEnd();
  }

  private consumeUntilEnd(): string {
    const endIndex = this.buffer.indexOf(this.envelope.endPrefix);
    if (endIndex >= 0) {
      const codeStart = endIndex + this.envelope.endPrefix.length;
      const suffixIndex = this.buffer.indexOf(this.envelope.endSuffix, codeStart);
      if (suffixIndex >= 0) {
        const before = this.buffer.slice(0, endIndex);
        const after = this.buffer.slice(suffixIndex + this.envelope.endSuffix.length);
        this.completed = true;
        this.buffer = '';
        return before + after;
      }
      const before = this.buffer.slice(0, endIndex);
      this.buffer = this.buffer.slice(endIndex);
      return before;
    }
    const reserve = Math.max(0, this.envelope.endPrefix.length - 1);
    if (this.buffer.length > reserve) {
      const out = this.buffer.slice(0, this.buffer.length - reserve);
      this.buffer = this.buffer.slice(this.buffer.length - reserve);
      return out;
    }
    return '';
  }
}
