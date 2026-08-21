const PROTOCOL_VERSION = 1;
const OSC_PREFIX = `\x1b]633;GlassTerminal;${PROTOCOL_VERSION};`;
const MAX_CONTROL_SEQUENCE_LENGTH = 128 * 1024;
const MAX_ENCODED_VALUE_LENGTH = 96 * 1024;

export type PowerShellShellIntegrationEvent =
  | { kind: 'ready'; rich: boolean; powerShellVersion?: string }
  | { kind: 'command'; commandId: number; command: string }
  | { kind: 'start'; commandId: number }
  | { kind: 'end'; commandId: number; exitCode: number }
  | { kind: 'cwd'; cwd: string };

export type PowerShellShellIntegrationPart =
  | { kind: 'data'; data: string }
  | { kind: 'event'; event: PowerShellShellIntegrationEvent };

function decodeBase64(value: string): string | undefined {
  if (
    value.length > MAX_ENCODED_VALUE_LENGTH
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(value)
  ) return undefined;
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function positiveCommandId(value: string): number | undefined {
  if (!/^\d{1,15}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function exitCode(value: string): number | undefined {
  if (!/^-?\d{1,10}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseEvent(
  body: string,
  expectedNonce: string,
): PowerShellShellIntegrationEvent | undefined {
  const fields = body.split(';');
  const kind = fields[0];
  if (fields[1] !== expectedNonce) return undefined;
  if (kind === 'R' && fields.length === 4 && (fields[2] === '0' || fields[2] === '1')) {
    const powerShellVersion = decodeBase64(fields[3]);
    if (powerShellVersion === undefined) return undefined;
    return {
      kind: 'ready',
      rich: fields[2] === '1',
      ...(powerShellVersion ? { powerShellVersion } : {}),
    };
  }
  if (kind === 'E' && fields.length === 4) {
    const commandId = positiveCommandId(fields[2]);
    const command = decodeBase64(fields[3]);
    if (commandId === undefined || command === undefined) return undefined;
    return { kind: 'command', commandId, command };
  }
  if (kind === 'C' && fields.length === 3) {
    const commandId = positiveCommandId(fields[2]);
    return commandId === undefined ? undefined : { kind: 'start', commandId };
  }
  if (kind === 'D' && fields.length === 4) {
    const commandId = positiveCommandId(fields[2]);
    const parsedExitCode = exitCode(fields[3]);
    if (commandId === undefined || parsedExitCode === undefined) return undefined;
    return { kind: 'end', commandId, exitCode: parsedExitCode };
  }
  if (kind === 'P' && fields.length === 3) {
    const cwd = decodeBase64(fields[2]);
    return cwd === undefined ? undefined : { kind: 'cwd', cwd };
  }
  return undefined;
}

function partialPrefixLength(value: string): number {
  const maxLength = Math.min(value.length, OSC_PREFIX.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (OSC_PREFIX.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

/**
 * Extracts only authenticated Glass Terminal OSC lifecycle messages. Ordinary
 * terminal bytes, including unrelated OSC/CSI sequences, remain byte-for-byte
 * unchanged. The small pending suffix handles SSH chunks split inside an OSC.
 */
export class PowerShellShellIntegrationParser {
  private pending = '';

  constructor(private readonly nonce: string) {}

  push(data: string): PowerShellShellIntegrationPart[] {
    let source = this.pending + data;
    this.pending = '';
    const parts: PowerShellShellIntegrationPart[] = [];
    const appendData = (value: string) => {
      if (!value) return;
      const previous = parts.at(-1);
      if (previous?.kind === 'data') previous.data += value;
      else parts.push({ kind: 'data', data: value });
    };

    while (source) {
      const start = source.indexOf(OSC_PREFIX);
      if (start < 0) {
        const reserve = partialPrefixLength(source);
        appendData(reserve > 0 ? source.slice(0, -reserve) : source);
        if (reserve > 0) this.pending = source.slice(-reserve);
        break;
      }
      appendData(source.slice(0, start));
      const bodyStart = start + OSC_PREFIX.length;
      const bellEnd = source.indexOf('\x07', bodyStart);
      const stringEnd = source.indexOf('\x1b\\', bodyStart);
      const useBell = bellEnd >= 0 && (stringEnd < 0 || bellEnd < stringEnd);
      const end = useBell ? bellEnd : stringEnd;
      if (end < 0) {
        if (source.length - start <= MAX_CONTROL_SEQUENCE_LENGTH) {
          this.pending = source.slice(start);
          break;
        }
        appendData(source.slice(start, start + 1));
        source = source.slice(start + 1);
        continue;
      }
      const terminatorLength = useBell ? 1 : 2;
      const raw = source.slice(start, end + terminatorLength);
      const event = parseEvent(source.slice(bodyStart, end), this.nonce);
      if (event) parts.push({ kind: 'event', event });
      else appendData(raw);
      source = source.slice(end + terminatorLength);
    }
    return parts;
  }

  clear(): void {
    this.pending = '';
  }
}

function powerShellIntegrationScript(nonce: string): string {
  return [
    "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {",
    `  $v=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PSVersionTable.PSVersion.ToString()));[Console]::Write("$([char]27)]633;GlassTerminal;1;R;${nonce};0;$v$([char]7)");return`,
    '}',
    '$Global:__GlassTerminalState=@{',
    `  Nonce='${nonce}';OriginalPrompt=$function:Prompt;OriginalReadLine=$null;InExecution=$false;CommandId=[int64]0;ActiveCommandId=[int64]0`,
    '}',
    'function Global:__GlassTerminalEncode([string]$Value) {',
    "  if ($null -eq $Value) { $Value='' };[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))",
    '}',
    'function Global:__GlassTerminalSequence([string]$Kind,[string]$Fields) {',
    '  $suffix=if([string]::IsNullOrEmpty($Fields)){\'\'}else{\';\'+$Fields}',
    '  "$([char]27)]633;GlassTerminal;1;$Kind;$($Global:__GlassTerminalState.Nonce)$suffix$([char]7)"',
    '}',
    'function Global:Prompt {',
    '  $lastSuccess=$global:?;$lastNative=$global:LASTEXITCODE;$state=$Global:__GlassTerminalState;$result=\'\'',
    '  if ($state.InExecution) {',
    '    $code=if($lastSuccess){0}elseif($null -ne $lastNative -and [int]$lastNative -ne 0){[int]$lastNative}else{1}',
    '    $result+=__GlassTerminalSequence \'D\' "$($state.ActiveCommandId);$code";$state.InExecution=$false',
    '  }',
    "  if ($pwd.Provider.Name -eq 'FileSystem') { $result+=__GlassTerminalSequence 'P' (__GlassTerminalEncode $pwd.ProviderPath) }",
    "  if (-not $lastSuccess) { Write-Error 'restore failure state' -ErrorAction Ignore }",
    '  $result+=$state.OriginalPrompt.Invoke();return $result',
    '}',
    '$hasReadLine=$false',
    'if (Get-Module -Name PSReadLine) {',
    '  $hasReadLine=$true;$Global:__GlassTerminalState.OriginalReadLine=$function:PSConsoleHostReadLine',
    '  function Global:PSConsoleHostReadLine {',
    '    $line=[string]$Global:__GlassTerminalState.OriginalReadLine.Invoke();$state=$Global:__GlassTerminalState',
    '    $state.CommandId=[int64]$state.CommandId+1;$state.ActiveCommandId=$state.CommandId;$state.InExecution=$true',
    "    [Console]::Write((__GlassTerminalSequence 'E' \"$($state.CommandId);$(__GlassTerminalEncode $line)\"))",
    "    [Console]::Write((__GlassTerminalSequence 'C' ([string]$state.CommandId)));return $line",
    '  }',
    '}',
    '$version=__GlassTerminalEncode $PSVersionTable.PSVersion.ToString();$rich=if($hasReadLine){\'1\'}else{\'0\'}',
    "[Console]::Write((__GlassTerminalSequence 'R' \"$rich;$version\"))",
  ].join('\n');
}

export function powerShellShellIntegrationEncodedCommand(nonce: string): string {
  if (!/^[a-f\d]{32}$/u.test(nonce)) throw new Error('Invalid PowerShell integration nonce.');
  return Buffer.from(powerShellIntegrationScript(nonce), 'utf16le').toString('base64');
}

export function powerShellShellIntegrationArgs(
  existingArgs: readonly string[],
  nonce: string,
): string[] {
  return [
    ...existingArgs,
    '-NoExit',
    '-EncodedCommand',
    powerShellShellIntegrationEncodedCommand(nonce),
  ];
}

/** Launches the same PowerShell edition as the Windows OpenSSH default shell. */
export function remotePowerShellShellIntegrationCommand(nonce: string): string {
  const encoded = powerShellShellIntegrationEncodedCommand(nonce);
  return `& (Get-Process -Id $PID).Path -NoLogo -NoExit -EncodedCommand ${encoded}`;
}

/** Test/support helper for producing one authenticated lifecycle sequence. */
export function powerShellShellIntegrationSequence(
  nonce: string,
  kind: 'R' | 'E' | 'C' | 'D' | 'P',
  ...fields: string[]
): string {
  return `${OSC_PREFIX}${kind};${nonce}${fields.length ? `;${fields.join(';')}` : ''}\x07`;
}

export function encodePowerShellShellIntegrationValue(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}
