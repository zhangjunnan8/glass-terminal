export type TerminalInteraction =
  | { kind: 'authentication' }
  | { kind: 'confirmation'; answer: 'y' | 'n' };

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const AUTH_PROMPT = /(?:^|[\r\n])[^\r\n]{0,160}(?:\bpassword(?:\s+for\s+[^:\r\n]+)?|\bpassphrase(?:\s+for\s+[^:\r\n]+)?|\botp|\bone[- ]time(?:\s+(?:password|code))?|\bverification\s+code|\b2fa(?:\s+code)?|\btwo[- ]factor(?:\s+(?:authentication\s+)?code)?)\s*[:：]\s*$/i;
const CONFIRM_PROMPT = /(?:^|[\r\n])[^\r\n]{0,240}[\[(]([yYnN])\/([yYnN])[\])][ \t]*$/;

function cleanTerminalText(value: string): string {
  return value
    .replace(ANSI_PATTERN, '')
    .replace(/\x1b./g, '')
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u0080-\uffff]/g, '');
}

export class TerminalInteractionDetector {
  private buffer = '';
  private armed = true;

  push(data: string): TerminalInteraction | null {
    if (!data) return null;
    this.buffer = (this.buffer + cleanTerminalText(data)).slice(-1_024);
    if (!this.armed) return null;
    if (AUTH_PROMPT.test(this.buffer)) {
      this.armed = false;
      return { kind: 'authentication' };
    }
    const confirmation = this.buffer.match(CONFIRM_PROMPT);
    if (confirmation) {
      const displayedDefaults = [confirmation[1], confirmation[2]].filter(
        (choice) => choice === choice.toUpperCase(),
      );
      if (displayedDefaults.length !== 1) return null;
      this.armed = false;
      return {
        kind: 'confirmation',
        answer: displayedDefaults[0].toLowerCase() as 'y' | 'n',
      };
    }
    return null;
  }

  rearm(): void {
    this.buffer = '';
    this.armed = true;
  }
}
