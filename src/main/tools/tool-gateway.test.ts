import { describe, expect, it } from 'vitest';
import type {
  SessionToolContext,
  TerminalTool,
  WorkspaceTool,
} from '../../shared/tools';
import { SessionToolGateway } from './tool-gateway';

function context(workspaceEnabled: boolean): SessionToolContext {
  return {
    sessionId: 'session-1',
    terminal: { type: 'local', terminalId: 'terminal-1' },
    ...(workspaceEnabled
      ? { workspace: { backend: 'local' as const, root: 'C:\\project' } }
      : {}),
    permissions: {
      terminal: { read: true, execute: true, sendInput: false, interrupt: true },
      workspace: {
        enabled: workspaceEnabled,
        mode: workspaceEnabled ? 'read-only' : 'off',
        read: workspaceEnabled,
        write: false,
        create: false,
        delete: false,
        readablePaths: workspaceEnabled ? ['C:\\project'] : [],
        writablePaths: [],
        fullAccess: false,
      },
    },
  };
}

describe('SessionToolGateway', () => {
  it('implements the shared gateway boundary for an enabled workspace', () => {
    const boundContext = context(true);
    const terminal = {} as TerminalTool;
    const workspace = {} as WorkspaceTool;
    const gateway = new SessionToolGateway(boundContext, terminal, workspace);

    expect(gateway.context).toBe(boundContext);
    expect(gateway.terminal).toBe(terminal);
    expect(gateway.workspace).toBe(workspace);
  });

  it('does not expose a workspace backend when Session permissions disable it', () => {
    const gateway = new SessionToolGateway(
      context(false),
      {} as TerminalTool,
      {} as WorkspaceTool,
    );
    expect(gateway.workspace).toBeUndefined();
  });

  it('fails closed when workspace permissions are enabled without a WorkspaceTool', () => {
    expect(() => new SessionToolGateway(context(true), {} as TerminalTool)).toThrow(
      /requires a WorkspaceTool/i,
    );
  });
});
