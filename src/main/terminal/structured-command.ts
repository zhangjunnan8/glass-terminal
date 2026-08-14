import type { ShellProfile } from '../../shared/terminal';

export interface CommandEnvelope {
  input: string;
  startMarker: string;
  endPrefix: string;
  endSuffix: string;
}

export interface CaptureUpdate {
  output: string[];
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

export function buildCommandEnvelope(
  shellKind: ShellProfile['kind'],
  command: string,
  nonce: string,
): CommandEnvelope {
  const [first, second] = splitNonce(nonce);
  if (shellKind === 'powershell') {
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
    const startMarker = `\x1eAI:${nonce}:START\x1f`;
    const endPrefix = `\x1eAI:${nonce}:END:`;
    const input = [
      `$__ait_a='${first}'`,
      `$__ait_b='${second}'`,
      "[Console]::WriteLine(([char]30)+'AI:'+$__ait_a+$__ait_b+':START'+[char]31)",
      '$global:LASTEXITCODE=0',
      '$__ait_ok=$true',
      `try { . ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedCommand}')))); $__ait_ok=$? } catch { Write-Error $_; $__ait_ok=$false }`,
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
    if (this.completed) return { output: [], completed: true };
    this.buffer += data;
    const output: string[] = [];

    if (!this.started) {
      const startIndex = this.buffer.indexOf(this.envelope.startMarker);
      if (startIndex < 0) {
        const reserve = Math.max(0, this.envelope.startMarker.length - 1);
        if (this.buffer.length > reserve) this.buffer = this.buffer.slice(-reserve);
        return { output, completed: false };
      }
      this.started = true;
      this.buffer = this.buffer.slice(startIndex + this.envelope.startMarker.length);
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
          exitCode: Number.isFinite(parsedCode) ? parsedCode : 1,
          completed: true,
        };
      }
    }

    const reserve = this.envelope.endPrefix.length + this.envelope.endSuffix.length + 32;
    if (this.buffer.length > 64 * 1024 + reserve) {
      const flushLength = this.buffer.length - reserve;
      output.push(this.buffer.slice(0, flushLength));
      this.buffer = this.buffer.slice(flushLength);
    }
    return { output, completed: false };
  }
}
