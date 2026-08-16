import type {
  SessionToolContext,
  TerminalTool,
  ToolGateway,
  WorkspaceTool,
} from '../../shared/tools';

export class SessionToolGateway implements ToolGateway {
  readonly context: SessionToolContext;
  readonly terminal: TerminalTool;
  readonly workspace?: WorkspaceTool;

  constructor(
    context: SessionToolContext,
    terminal: TerminalTool,
    workspace?: WorkspaceTool,
  ) {
    if (context.permissions.workspace.enabled && !workspace) {
      throw new Error('An enabled Session workspace requires a WorkspaceTool.');
    }
    this.context = context;
    this.terminal = terminal;
    // Disabled workspace permissions mean the Harness must not receive file tools,
    // even if a backend happens to have been constructed by a compatibility layer.
    this.workspace = context.permissions.workspace.enabled ? workspace : undefined;
  }
}
