import type { SessionRecord } from '../../shared/session';
import type { TerminalDescriptor } from '../../shared/terminal';

export interface ShellContextSnapshot {
  cwd?: string;
  effectiveUser?: string;
}

const MAX_CONTEXT_TAIL = 16 * 1024;
const MAX_CWD_LENGTH = 4 * 1024;
const POSIX_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

function stripTerminalControls(value: string): string {
  return value
    // OSC sequences end in BEL or ST. They can otherwise resemble a shell prompt.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function safeCwd(value: string | undefined): string | undefined {
  const cwd = value?.trim();
  if (!cwd || cwd.length > MAX_CWD_LENGTH || /[\0\r\n]/.test(cwd)) return undefined;
  return cwd;
}

function safePosixUser(value: string | undefined): string | undefined {
  const user = value?.trim();
  return user && POSIX_USER.test(user) ? user : undefined;
}

/**
 * Extracts the last conventional shell prompt from terminal output. Prompt parsing is
 * deliberately conservative: an unrecognised/custom prompt leaves the last durable
 * context untouched instead of guessing a command or output line is a directory.
 */
export function inferShellContext(
  value: string,
  shellKind: TerminalDescriptor['shellKind'],
): ShellContextSnapshot | undefined {
  const lines = stripTerminalControls(value).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trimEnd();
    if (!line) continue;

    if (shellKind === 'posix') {
      const match = /(?:^|\s)([A-Za-z_][A-Za-z0-9_.-]{0,63})@[^:\s]+:(.+)[#$]\s*$/.exec(line);
      const effectiveUser = safePosixUser(match?.[1]);
      const cwd = safeCwd(match?.[2]);
      if (effectiveUser && cwd) return { effectiveUser, cwd };
      continue;
    }

    if (shellKind === 'powershell') {
      const match = /^PS\s+(.+)>\s*$/.exec(line);
      const cwd = safeCwd(match?.[1]);
      if (cwd) return { cwd };
      continue;
    }

    if (shellKind === 'cmd') {
      const match = /^((?:[A-Za-z]:\\|\\\\).*)>\s*$/.exec(line);
      const cwd = safeCwd(match?.[1]);
      if (cwd) return { cwd };
    }
  }
  return undefined;
}

export class ShellContextTracker {
  private tail = '';

  constructor(private readonly shellKind: TerminalDescriptor['shellKind']) {}

  push(data: string): ShellContextSnapshot | undefined {
    this.tail = `${this.tail}${data}`.slice(-MAX_CONTEXT_TAIL);
    return inferShellContext(this.tail, this.shellKind);
  }
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function posixCwdExpression(cwd: string): string {
  if (cwd === '~') return '"$HOME"';
  if (cwd.startsWith('~/')) return `"$HOME"/${quotePosix(cwd.slice(2))}`;
  return quotePosix(cwd);
}

/**
 * Creates one input line so a sudo password prompt cannot consume a separately queued
 * `cd` command. It restores only the documented cwd/effective-user subset; processes,
 * environment variables and virtual environments are intentionally not reconstructed.
 */
export function buildSshRestoreInput(session: SessionRecord): string | undefined {
  if (session.transport !== 'ssh' || session.shellKind !== 'posix') return undefined;

  const cwd = safeCwd(session.cwd);
  const loginUser = safePosixUser(session.targetSnapshot.username);
  const effectiveUser = safePosixUser(session.effectiveUser);
  const switchUser = Boolean(effectiveUser && loginUser && effectiveUser !== loginUser);
  if (!cwd && !switchUser) return undefined;

  if (!switchUser) {
    return cwd ? `cd -- ${posixCwdExpression(cwd)}\r` : undefined;
  }

  const targetUser = effectiveUser!;
  if (!cwd) return `sudo -iu ${quotePosix(targetUser)}\r`;

  const targetCommand = [
    `cd -- ${posixCwdExpression(cwd)}`,
    'exec "${SHELL:-/bin/sh}" -i',
  ].join(' && ');
  return `sudo -iu ${quotePosix(targetUser)} -- sh -c ${quotePosix(targetCommand)}\r`;
}
