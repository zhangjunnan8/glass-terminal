import type {
  AgentFileAccessMode,
  AgentFileAccessPolicy,
} from '../../shared/agent';
import type { SessionRecord } from '../../shared/session';
import type { TerminalDescriptor } from '../../shared/terminal';
import type {
  SessionToolContext,
  TerminalToolPermissions,
  WorkspaceBinding,
  WorkspaceToolPermissions,
} from '../../shared/tools';

export const DEFAULT_TERMINAL_TOOL_PERMISSIONS: TerminalToolPermissions = {
  read: true,
  execute: true,
  sendInput: false,
  interrupt: true,
};

export function workspacePermissions(
  mode: AgentFileAccessMode,
  binding?: WorkspaceBinding,
  policy?: AgentFileAccessPolicy,
): WorkspaceToolPermissions {
  const enabled = mode !== 'off' && Boolean(binding);
  const modeCanWrite = mode === 'read-write' || mode === 'full-access';
  const read = enabled && (policy?.read ?? true);
  const write = enabled && modeCanWrite && (policy?.write ?? true);
  const create = enabled && modeCanWrite && (policy?.create ?? true);
  const deletePath = enabled && modeCanWrite && (policy?.delete ?? true);
  const readablePaths = policy?.readablePaths ?? (binding ? [binding.root] : []);
  const writablePaths = policy?.writablePaths ?? (binding ? [binding.root] : []);
  return {
    enabled,
    mode,
    read,
    write,
    create,
    delete: deletePath,
    readablePaths: read ? [...readablePaths] : [],
    writablePaths: (write || create || deletePath) ? [...writablePaths] : [],
    fullAccess: enabled
      && mode === 'full-access'
      && (policy?.fullAccess ?? true),
  };
}

export interface SessionToolContextOptions {
  terminalPermissions?: Partial<TerminalToolPermissions>;
  workspacePermissions?: WorkspaceToolPermissions;
}

export function buildSessionToolContext(
  session: SessionRecord,
  terminal: TerminalDescriptor,
  options: SessionToolContextOptions = {},
): SessionToolContext {
  if (terminal.id !== session.runtimeTerminalId) {
    throw new Error('Session tool context requires the currently bound terminal.');
  }
  if (terminal.sessionId && terminal.sessionId !== session.id) {
    throw new Error('Terminal is bound to a different Session.');
  }
  if (terminal.transport !== session.transport || terminal.hostId !== session.hostId) {
    throw new Error('Session terminal target does not match the live terminal.');
  }

  const workspace = session.workspace ? { ...session.workspace } : undefined;
  if (workspace) {
    const expectedBackend = terminal.transport === 'ssh' ? 'sftp' : 'local';
    if (workspace.backend !== expectedBackend) {
      throw new Error('Workspace backend does not match the terminal transport.');
    }
    if (workspace.backend === 'sftp') {
      if (!workspace.hostId || workspace.hostId !== terminal.hostId) {
        throw new Error('SSH terminal and SFTP workspace must belong to the same Host.');
      }
    } else if (workspace.hostId) {
      throw new Error('A local workspace cannot be bound to a remote Host.');
    }
  }

  const terminalPermissions = {
    ...DEFAULT_TERMINAL_TOOL_PERMISSIONS,
    ...options.terminalPermissions,
  };
  const workspacePolicy = options.workspacePermissions
    ?? workspacePermissions('off', workspace);
  if (workspacePolicy.enabled && !workspace) {
    throw new Error('Workspace permissions cannot be enabled without a Workspace Root.');
  }

  return {
    sessionId: session.id,
    terminal: {
      type: terminal.transport,
      terminalId: terminal.id,
      ...(terminal.hostId ? { hostId: terminal.hostId } : {}),
    },
    ...(workspace ? { workspace } : {}),
    permissions: {
      terminal: terminalPermissions,
      workspace: {
        ...workspacePolicy,
        readablePaths: [...workspacePolicy.readablePaths],
        writablePaths: [...workspacePolicy.writablePaths],
      },
    },
  };
}
