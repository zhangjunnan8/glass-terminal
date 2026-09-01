import type { ShellProfile } from '../../shared/terminal';

export interface CommandEnvelope {
  shellKind: Exclude<ShellProfile['kind'], 'powershell'>;
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

function possibleMarkerSuffixLength(value: string, marker: string): number {
  const maxLength = Math.min(value.length, Math.max(0, marker.length - 1));
  for (let length = maxLength; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

export function buildCommandEnvelope(
  shellKind: ShellProfile['kind'],
  command: string,
  nonce: string,
): CommandEnvelope {
  const [first, second] = splitNonce(nonce);
  if (shellKind === 'powershell') {
    throw new Error('PowerShell commands require session shell integration.');
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
    return { shellKind, input: `${input}\r`, startMarker, endPrefix, endSuffix: '__' };
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
  return { shellKind, input: `${input}\r`, startMarker, endPrefix, endSuffix: '\x1f' };
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

    const reserve = this.envelope.shellKind === 'posix'
      ? possibleMarkerSuffixLength(this.buffer, this.envelope.endPrefix)
      : Math.max(0, this.envelope.endPrefix.length - 1);
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
    const reserve = this.envelope.shellKind === 'posix'
      ? possibleMarkerSuffixLength(this.buffer, this.envelope.endPrefix)
      : Math.max(0, this.envelope.endPrefix.length - 1);
    if (this.buffer.length > reserve) {
      const out = this.buffer.slice(0, this.buffer.length - reserve);
      this.buffer = reserve > 0 ? this.buffer.slice(-reserve) : '';
      return out;
    }
    return '';
  }
}

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const TERMINAL_LAYOUT_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))|\r|\n/g;
const TERMINAL_REFLOW_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))|[\r\n\t ]/g;
const MIN_WRAPPED_ENVELOPE_CHARS = 24;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

/**
 * Lines of one command envelope input, ANSI-stripped, used to recognise the
 * echo of that envelope when a terminal redraws its full screen buffer later
 * (e.g. after a window resize). Remote conhost keeps the raw injected input in
 * its scroll buffer, so the redraw can resurface lines that the per-execution
 * CommandDisplayFilter already consumed and dropped.
 */
export function envelopeInputLines(input: string): Set<string> {
  const lines = new Set<string>();
  for (const raw of input.split(/\r\n|\r|\n/)) {
    const stripped = stripAnsi(raw);
    if (stripped) lines.add(stripped);
  }
  return lines;
}

interface NormalizedTerminalText {
  text: string;
  rawIndices: number[];
}

function normalizedTerminalText(
  value: string,
  ignoreHorizontalWhitespace = false,
): NormalizedTerminalText {
  let text = '';
  const rawIndices: number[] = [];
  let cursor = 0;
  const layoutPattern = ignoreHorizontalWhitespace
    ? TERMINAL_REFLOW_PATTERN
    : TERMINAL_LAYOUT_PATTERN;
  for (const match of value.matchAll(layoutPattern)) {
    const matchIndex = match.index;
    for (let index = cursor; index < matchIndex; index += 1) {
      text += value[index];
      rawIndices.push(index);
    }
    cursor = matchIndex + match[0].length;
  }
  for (let index = cursor; index < value.length; index += 1) {
    text += value[index];
    rawIndices.push(index);
  }
  return { text, rawIndices };
}

function wrappedEnvelopeNeedles(
  recentEnvelopes: ReadonlyArray<ReadonlySet<string>>,
): string[] {
  const needles = new Set<string>();
  for (const envelope of recentEnvelopes) {
    for (const line of envelope) {
      if (
        line.length >= MIN_WRAPPED_ENVELOPE_CHARS
        && (line.includes('__ait_') || line.includes('__AI_TERMINAL_'))
      ) needles.add(line);
    }
  }
  return [...needles].sort((left, right) => right.length - left.length);
}

function stripWrappedEnvelope(value: string, needle: string): string {
  let output = value;
  const normalizedNeedle = normalizedTerminalText(needle, true).text;
  while (output) {
    const normalized = normalizedTerminalText(output, true);
    const matchIndex = normalized.text.indexOf(normalizedNeedle);
    if (matchIndex < 0) return output;
    const rawStart = normalized.rawIndices[matchIndex];
    const rawEndIndex = normalized.rawIndices[matchIndex + normalizedNeedle.length - 1];
    if (rawStart === undefined || rawEndIndex === undefined) return output;
    output = output.slice(0, rawStart) + output.slice(rawEndIndex + 1);
  }
  return output;
}

/**
 * Line-level fallback filter: drops whole lines whose ANSI-stripped content
 * exactly matches a line we injected as part of a recent command envelope.
 * Applied to the renderer-visible stream regardless of whether an execution is
 * still live, so post-execution terminal redraws cannot leak the envelope echo.
 */
export function stripEnvelopeEcho(
  data: string,
  recentEnvelopes: ReadonlyArray<ReadonlySet<string>>,
): string {
  if (!data || recentEnvelopes.length === 0) return data;
  let output = data.replace(/[^\n]*\n|[^\n]*$/g, (line) => {
    const stripped = stripAnsi(line.replace(/\r?\n$/, '')).replace(/\r+$/, '');
    for (const envelope of recentEnvelopes) {
      if (envelope.has(stripped)) return '';
    }
    return line;
  });
  for (const needle of wrappedEnvelopeNeedles(recentEnvelopes)) {
    output = stripWrappedEnvelope(output, needle);
  }
  return output;
}

/**
 * Stateful renderer-only suppressor for Windows full-screen redraws. ConPTY may
 * split one echoed PowerShell envelope both at the new column width and across
 * multiple data events. Normal terminal output is forwarded immediately; only
 * a suffix that matches the start of a recent private envelope is held until it
 * either completes (and is removed) or diverges (and is released unchanged).
 */
export class EnvelopeEchoFilter {
  private readonly recentEnvelopes: Set<string>[] = [];
  private pending = '';

  remember(input: string): void {
    this.recentEnvelopes.push(envelopeInputLines(input));
    if (this.recentEnvelopes.length > 4) this.recentEnvelopes.shift();
  }

  push(data: string): string {
    if (!data && !this.pending) return '';
    const combined = this.pending + data;
    this.pending = '';
    const filtered = stripEnvelopeEcho(combined, this.recentEnvelopes);
    const pendingStart = this.partialEnvelopeStart(filtered);
    if (pendingStart === undefined) return filtered;
    this.pending = filtered.slice(pendingStart);
    return filtered.slice(0, pendingStart);
  }

  clear(): void {
    this.recentEnvelopes.length = 0;
    this.pending = '';
  }

  private partialEnvelopeStart(value: string): number | undefined {
    if (!value) return undefined;
    const normalized = normalizedTerminalText(value, true);
    const needles = wrappedEnvelopeNeedles(this.recentEnvelopes)
      .map((needle) => normalizedTerminalText(needle, true).text);
    for (const needle of needles) {
      const prefix = needle.slice(0, MIN_WRAPPED_ENVELOPE_CHARS);
      let searchFrom = 0;
      while (searchFrom < normalized.text.length) {
        const matchIndex = normalized.text.indexOf(prefix, searchFrom);
        if (matchIndex < 0) break;
        const remainder = normalized.text.slice(matchIndex);
        if (remainder.length < needle.length && needle.startsWith(remainder)) {
          return normalized.rawIndices[matchIndex];
        }
        searchFrom = matchIndex + 1;
      }

      const maxSuffix = Math.min(prefix.length - 1, normalized.text.length);
      for (let length = maxSuffix; length >= 8; length -= 1) {
        const suffix = normalized.text.slice(-length);
        if (needle.startsWith(suffix)) {
          return normalized.rawIndices[normalized.text.length - length];
        }
      }
    }
    return undefined;
  }
}
