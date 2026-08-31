import type {
  SessionToolContext,
  TerminalTool,
  ToolGateway,
  WorkspaceTool,
  FileToolReviewRequest,
} from '../../shared/tools';
import { PolicyWorkspaceTool } from './policy-workspace-tool';

function immutableContextSnapshot(context: SessionToolContext): SessionToolContext {
  const snapshot: SessionToolContext = {
    sessionId: context.sessionId,
    terminal: { ...context.terminal },
    ...(context.workspace ? { workspace: { ...context.workspace } } : {}),
    permissions: {
      terminal: { ...context.permissions.terminal },
      workspace: {
        ...context.permissions.workspace,
        readablePaths: [...context.permissions.workspace.readablePaths],
        writablePaths: [...context.permissions.workspace.writablePaths],
      },
    },
  };
  Object.freeze(snapshot.permissions.workspace.readablePaths);
  Object.freeze(snapshot.permissions.workspace.writablePaths);
  Object.freeze(snapshot.permissions.workspace);
  Object.freeze(snapshot.permissions.terminal);
  Object.freeze(snapshot.permissions);
  Object.freeze(snapshot.terminal);
  if (snapshot.workspace) Object.freeze(snapshot.workspace);
  return Object.freeze(snapshot);
}

export class SessionToolGateway implements ToolGateway {
  readonly context: SessionToolContext;
  readonly terminal: TerminalTool;
  readonly workspace?: WorkspaceTool;

  requestFileOperation(request: FileToolReviewRequest): Promise<boolean> {
    return this.reviewFileOperation ? this.reviewFileOperation(request) : Promise.resolve(true);
  }

  constructor(
    context: SessionToolContext,
    terminal: TerminalTool,
    workspace?: WorkspaceTool,
    private readonly reviewFileOperation?: (request: FileToolReviewRequest) => Promise<boolean>,
  ) {
    this.context = immutableContextSnapshot(context);
    const workspaceEnabled = this.context.permissions.workspace.enabled
      && this.context.permissions.workspace.mode !== 'off';
    if (workspaceEnabled && !workspace) {
      throw new Error('An enabled Session workspace requires a WorkspaceTool.');
    }
    if (workspaceEnabled && !this.context.workspace) {
      throw new Error('An enabled Session workspace requires a Workspace Root.');
    }
    this.terminal = terminal;
    // Disabled workspace permissions mean the Harness must not receive file tools,
    // even if a backend happens to have been constructed by a compatibility layer.
    this.workspace = workspaceEnabled && workspace
      ? new PolicyWorkspaceTool(
        workspace,
        this.context.workspace!,
        this.context.permissions.workspace,
      )
      : undefined;
  }
}
