import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../shared/session';
import {
  buildSshRestoreInput,
  inferShellContext,
  ShellContextTracker,
} from './session-context';

function sshSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schemaVersion: 1,
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Ubuntu task',
    nameSource: 'automatic',
    transport: 'ssh',
    hostId: 'host',
    shellProfileId: 'ssh:host',
    shellKind: 'posix',
    targetSnapshot: { label: 'Ubuntu', username: 'tester' },
    connectionState: 'disconnected',
    status: 'disconnected',
    runtimeTerminalId: 'old-terminal',
    cwd: '/srv/project',
    effectiveUser: 'root',
    pinned: false,
    preludeTruncated: false,
    droppedPreludeBytes: 0,
    startedAt: new Date(0).toISOString(),
    promotedAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastConnectedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('Session shell context', () => {
  it('extracts the effective user and cwd from a coloured POSIX prompt', () => {
    expect(inferShellContext(
      '\x1b[32mroot@ubuntu\x1b[0m:\x1b[34m/usr/local/src\x1b[0m# ',
      'posix',
    )).toEqual({ effectiveUser: 'root', cwd: '/usr/local/src' });
  });

  it('tracks a prompt split across terminal output chunks', () => {
    const tracker = new ShellContextTracker('posix');
    expect(tracker.push('build finished\r\ntester@ubu')).toBeUndefined();
    expect(tracker.push('ntu:~/workspace$ ')).toEqual({
      effectiveUser: 'tester',
      cwd: '~/workspace',
    });
  });

  it('extracts PowerShell and Command Prompt directories without guessing normal output', () => {
    expect(inferShellContext('PS C:\\Users\\tester\\repo> ', 'powershell')).toEqual({
      cwd: 'C:\\Users\\tester\\repo',
    });
    expect(inferShellContext('C:\\work\\repo> ', 'cmd')).toEqual({ cwd: 'C:\\work\\repo' });
    expect(inferShellContext('documentation says user@host:/tmp$ then continues', 'posix'))
      .toBeUndefined();
  });

  it('restores a switched user and cwd with one sudo input line', () => {
    expect(buildSshRestoreInput(sshSession())).toBe(
      "sudo -iu 'root' -- sh -c 'cd -- '\"'\"'/srv/project'\"'\"' && exec \"${SHELL:-/bin/sh}\" -i'\r",
    );
  });

  it('restores a login-user home-relative cwd without sudo', () => {
    expect(buildSshRestoreInput(sshSession({ effectiveUser: 'tester', cwd: '~/repo' })))
      .toBe('cd -- "$HOME"/\'repo\'\r');
  });

  it('does not turn untrusted user metadata into a restore command', () => {
    expect(buildSshRestoreInput(sshSession({
      effectiveUser: 'root; touch /tmp/pwned',
      cwd: undefined,
    }))).toBeUndefined();
  });
});
