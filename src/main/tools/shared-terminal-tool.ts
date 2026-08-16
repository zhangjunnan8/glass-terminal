import type { WebContents } from 'electron';
import type { SessionRecord } from '../../shared/session';
import type { TerminalDescriptor } from '../../shared/terminal';
import type {
  SessionToolContext,
  TerminalCommandResult,
  TerminalTool,
  TerminalToolState,
} from '../../shared/tools';
import type { SessionManager } from '../sessions/session-manager';
import type { TerminalService } from '../terminal/terminal-service';

const DEFAULT_VISIBLE_CHARACTERS = 8_000;
const MAX_VISIBLE_CHARACTERS = 30_000;
const DEFAULT_HISTORY_CHARACTERS = 120_000;
const MAX_HISTORY_CHARACTERS = 120_000;

export interface SharedTerminalToolOptions {
  context: SessionToolContext;
  owner: WebContents;
  terminals: TerminalService;
  sessions: SessionManager;
  /**
   * The owning Agent runtime supplies approval, takeover, and structured-command
   * orchestration. This is deliberately the only execution path exposed here.
   */
  execute(command: string, reason?: string): Promise<TerminalCommandResult>;
  sendInput?(input: string): Promise<void> | void;
  interrupt?(commandId?: string): Promise<void> | void;
}

interface CurrentBinding {
  descriptor: TerminalDescriptor;
  session: SessionRecord;
}

function boundedCharacterLimit(
  requested: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (requested === undefined) return fallback;
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error('Terminal read maxChars must be a positive finite number.');
  }
  return Math.min(Math.floor(requested), maximum);
}

export class SharedTerminalTool implements TerminalTool {
  constructor(private readonly options: SharedTerminalToolOptions) {}

  async execute(command: string, reason?: string): Promise<TerminalCommandResult> {
    this.assertCurrentBinding();
    this.assertPermission('execute');
    if (!command.trim()) throw new Error('Terminal command cannot be empty.');
    return this.options.execute(command, reason);
  }

  async sendInput(input: string): Promise<void> {
    this.assertCurrentBinding();
    this.assertPermission('sendInput');
    if (!this.options.sendInput) {
      throw new Error('terminal.sendInput is disabled by default.');
    }
    await this.options.sendInput(input);
  }

  async interrupt(commandId?: string): Promise<void> {
    this.assertCurrentBinding();
    this.assertPermission('interrupt');
    if (!this.options.interrupt) {
      throw new Error('terminal.interrupt is disabled unless an interrupt callback is provided.');
    }
    await this.options.interrupt(commandId);
  }

  async readVisible(options: { maxChars?: number } = {}): Promise<string> {
    const { session } = this.assertCurrentBinding();
    this.assertPermission('read');
    const maxChars = boundedCharacterLimit(
      options.maxChars,
      DEFAULT_VISIBLE_CHARACTERS,
      MAX_VISIBLE_CHARACTERS,
    );
    return this.options.sessions.readTerminalHistory(session.id).slice(-maxChars);
  }

  async readHistory(options: { maxChars?: number } = {}): Promise<string> {
    const { session } = this.assertCurrentBinding();
    this.assertPermission('read');
    const maxChars = boundedCharacterLimit(
      options.maxChars,
      DEFAULT_HISTORY_CHARACTERS,
      MAX_HISTORY_CHARACTERS,
    );
    return this.options.sessions.readTerminalHistory(session.id).slice(-maxChars);
  }

  async getState(): Promise<TerminalToolState> {
    const { session } = this.assertCurrentBinding();
    this.assertPermission('read');
    return {
      ...this.options.terminals.state(
        this.options.owner,
        this.options.context.terminal.terminalId,
      ),
      cwd: session.cwd,
      effectiveUser: session.effectiveUser,
    } as TerminalToolState;
  }

  private assertPermission(permission: keyof SessionToolContext['permissions']['terminal']): void {
    if (!this.options.context.permissions.terminal[permission]) {
      throw new Error(`terminal.${permission} is disabled by Session permissions.`);
    }
  }

  private assertCurrentBinding(): CurrentBinding {
    const { context, owner, terminals, sessions } = this.options;
    const terminalId = context.terminal.terminalId;
    const descriptor = terminals.descriptor(owner, terminalId);
    const session = sessions.sessionForTerminal(owner, terminalId);

    if (!session) {
      throw new Error('Shared terminal binding is stale: no formal Session is currently bound.');
    }
    if (
      descriptor.id !== terminalId
      || descriptor.sessionId !== context.sessionId
      || session.id !== context.sessionId
      || session.runtimeTerminalId !== terminalId
    ) {
      throw new Error('Shared terminal binding is stale or belongs to another Session.');
    }
    if (
      descriptor.transport !== context.terminal.type
      || session.transport !== context.terminal.type
      || descriptor.hostId !== context.terminal.hostId
      || session.hostId !== context.terminal.hostId
    ) {
      throw new Error('Shared terminal binding transport or Host no longer matches the Session.');
    }
    return { descriptor, session };
  }
}
