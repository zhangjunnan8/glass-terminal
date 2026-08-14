export interface ShellProfile {
  id: string;
  label: string;
  command: string;
  args: string[];
  kind: 'powershell' | 'cmd' | 'wsl' | 'git-bash' | 'posix';
  detail: string;
}

export interface CreateTerminalRequest {
  profileId: string;
  cols?: number;
  rows?: number;
}

export interface TerminalDescriptor {
  id: string;
  title: string;
  profileId: string;
  shellKind: ShellProfile['kind'];
}

export interface TerminalDataEvent {
  terminalId: string;
  data: string;
}

export interface TerminalExitEvent {
  terminalId: string;
  exitCode: number;
  signal?: number;
}

export const TERMINAL_CHANNELS = {
  listShells: 'terminal:list-shells',
  create: 'terminal:create',
  write: 'terminal:write',
  resize: 'terminal:resize',
  close: 'terminal:close',
  data: 'terminal:data',
  exit: 'terminal:exit',
} as const;
