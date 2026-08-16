import { describe, expect, it, vi } from 'vitest';
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

    expect(gateway.context).not.toBe(boundContext);
    expect(gateway.context).toEqual(boundContext);
    expect(gateway.terminal).toBe(terminal);
    expect(gateway.workspace).not.toBe(workspace);
    expect(gateway.workspace).toBeDefined();
  });

  it('does not expose a workspace backend when Session permissions disable it', () => {
    const gateway = new SessionToolGateway(
      context(false),
      {} as TerminalTool,
      {} as WorkspaceTool,
    );
    expect(gateway.workspace).toBeUndefined();
  });

  it('does not expose a workspace backend when mode is off even if enabled is forged', () => {
    const forged = context(true);
    forged.permissions.workspace.mode = 'off';
    forged.permissions.workspace.enabled = true;
    forged.permissions.workspace.read = true;
    const gateway = new SessionToolGateway(
      forged,
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

  it('deep-freezes a permission snapshot and cannot be widened by Harness mutation', async () => {
    const original = context(true);
    original.permissions.workspace.read = false;
    original.permissions.workspace.readablePaths = [];
    const readFile = vi.fn(async () => ({
      path: 'C:\\project\\secret.txt',
      content: 'secret',
      bytes: 6,
      sha256: 'a'.repeat(64),
    }));
    const gateway = new SessionToolGateway(
      original,
      {} as TerminalTool,
      { readFile } as unknown as WorkspaceTool,
    );

    original.permissions.workspace.read = true;
    original.permissions.workspace.readablePaths.push('C:\\');
    expect(gateway.context.permissions.workspace.read).toBe(false);
    expect(gateway.context.permissions.workspace.readablePaths).toEqual([]);
    expect(Object.isFrozen(gateway.context)).toBe(true);
    expect(Object.isFrozen(gateway.context.permissions.workspace)).toBe(true);
    expect(Object.isFrozen(gateway.context.permissions.workspace.readablePaths)).toBe(true);

    try {
      (gateway.context.permissions.workspace as { read: boolean }).read = true;
    } catch {
      // Strict-mode assignment to the frozen Harness-facing snapshot is expected.
    }
    try {
      (gateway.context.permissions.workspace.readablePaths as string[]).push('C:\\');
    } catch {
      // Frozen arrays prevent another mutation route.
    }

    await expect(gateway.workspace!.readFile('secret.txt')).rejects.toThrow(/capability/i);
    expect(readFile).not.toHaveBeenCalled();
  });
});
