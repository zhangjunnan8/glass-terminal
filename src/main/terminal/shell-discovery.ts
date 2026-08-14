import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ShellProfile } from '../../shared/terminal';

function firstExisting(paths: Array<string | undefined>): string | undefined {
  return paths.find((path): path is string => Boolean(path && existsSync(path)));
}

function findOnPath(executable: string): string | undefined {
  const pathMatch = (process.env.PATH ?? '')
    .split(delimiter)
    .map((entry) => join(entry.replace(/^"|"$/g, ''), executable))
    .find(existsSync);
  if (pathMatch) return pathMatch;

  if (process.platform !== 'win32') return undefined;
  try {
    return execFileSync('where.exe', [executable], {
      encoding: 'utf8',
      timeout: 1_500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).find(Boolean);
  } catch {
    return undefined;
  }
}

function discoverWslProfiles(): ShellProfile[] {
  const wsl = firstExisting([
    process.env.SystemRoot && join(process.env.SystemRoot, 'System32', 'wsl.exe'),
    findOnPath('wsl.exe'),
  ]);
  if (!wsl) return [];

  let distributions: string[] = [];
  try {
    const output = execFileSync(wsl, ['--list', '--quiet'], {
      encoding: 'buffer',
      timeout: 2_000,
      windowsHide: true,
    });
    const decoded = output.includes(0)
      ? output.toString('utf16le')
      : output.toString('utf8');
    distributions = decoded
      .replaceAll('\0', '')
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
  } catch {
    // WSL is optional and may be installed without a configured distribution.
  }

  if (distributions.length === 0) {
    return [{
      id: 'wsl-default',
      label: 'WSL',
      command: wsl,
      args: [],
      kind: 'wsl',
      detail: 'Default WSL distribution',
    }];
  }

  return distributions.map((distribution, index) => ({
    id: `wsl-${index}`,
    label: `WSL ${distribution}`,
    command: wsl,
    args: ['--distribution', distribution],
    kind: 'wsl' as const,
    detail: distribution,
  }));
}

export function discoverShells(): ShellProfile[] {
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL ?? '/bin/bash';
    return [{
      id: 'posix-default',
      label: 'Shell',
      command: shell,
      args: [],
      kind: 'posix',
      detail: shell,
    }];
  }

  const profiles: ShellProfile[] = [];
  const pwsh = findOnPath('pwsh.exe');
  if (pwsh) {
    profiles.push({
      id: 'powershell-core',
      label: 'PowerShell',
      command: pwsh,
      args: ['-NoLogo'],
      kind: 'powershell',
      detail: 'PowerShell 7+',
    });
  }

  const windowsPowerShell = firstExisting([
    process.env.SystemRoot && join(
      process.env.SystemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    findOnPath('powershell.exe'),
  ]);
  if (windowsPowerShell) {
    profiles.push({
      id: 'windows-powershell',
      label: 'Windows PowerShell',
      command: windowsPowerShell,
      args: ['-NoLogo'],
      kind: 'powershell',
      detail: 'Windows PowerShell 5.1',
    });
  }

  const commandPrompt = firstExisting([
    process.env.ComSpec,
    process.env.SystemRoot && join(process.env.SystemRoot, 'System32', 'cmd.exe'),
  ]);
  if (commandPrompt) {
    profiles.push({
      id: 'command-prompt',
      label: 'Command Prompt',
      command: commandPrompt,
      args: [],
      kind: 'cmd',
      detail: 'cmd.exe',
    });
  }

  profiles.push(...discoverWslProfiles());

  const gitBash = firstExisting([
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    findOnPath('bash.exe'),
  ]);
  if (gitBash) {
    profiles.push({
      id: 'git-bash',
      label: 'Git Bash',
      command: gitBash,
      args: ['--login', '-i'],
      kind: 'git-bash',
      detail: 'Git for Windows',
    });
  }

  return profiles;
}
