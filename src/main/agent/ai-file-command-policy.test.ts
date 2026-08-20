import { describe, expect, it } from 'vitest';
import type { WorkspaceToolPermissions } from '../../shared/tools';
import { classifyAiFileCommand } from './ai-file-command-policy';

function workspace(overrides: Partial<WorkspaceToolPermissions> = {}): WorkspaceToolPermissions {
  return {
    enabled: true,
    mode: 'read-only',
    read: true,
    write: false,
    create: false,
    delete: false,
    readablePaths: ['C:\\work'],
    writablePaths: [],
    fullAccess: false,
    ...overrides,
  };
}

describe('classifyAiFileCommand', () => {
  it.each([
    ['Get-Content README.md', 'read', 'workspace_read_file'],
    ['GC README.md', 'read', 'workspace_read_file'],
    ['cat README.md', 'read', 'workspace_read_file'],
    ['TYPE README.md', 'read', 'workspace_read_file'],
    ['Select-String needle README.md', 'search', 'workspace_search'],
    ['sls needle README.md', 'search', 'workspace_search'],
    ['Get-ChildItem .', 'list', 'workspace_list'],
    ['GCI .', 'list', 'workspace_list'],
    ['dir .', 'list', 'workspace_list'],
    ['ls .', 'list', 'workspace_list'],
    ['Get-Item README.md', 'stat', 'workspace_stat'],
    ['Test-Path README.md', 'stat', 'workspace_stat'],
  ])('routes PowerShell command %s to a Workspace tool', (command, category, tool) => {
    const result = classifyAiFileCommand({ command, shellKind: 'powershell', workspace: workspace() });
    expect(result).toMatchObject({
      disposition: 'workspace-tool-required',
      categories: [category],
    });
    expect(result.suggestedTools).toContain(tool);
  });

  it('recognizes pipelines, semicolons, case-insensitive aliases, and one wrapper layer', () => {
    expect(classifyAiFileCommand({
      command: 'gEt-CoNtEnT README.md | SLS needle',
      shellKind: 'powershell',
      workspace: workspace(),
    })).toMatchObject({
      disposition: 'workspace-tool-required',
      categories: ['read', 'search'],
    });
    expect(classifyAiFileCommand({
      command: 'Get-Content a.txt; Get-ChildItem .',
      shellKind: 'powershell',
      workspace: workspace(),
    }).disposition).toBe('workspace-tool-required');
    expect(classifyAiFileCommand({
      command: 'powershell.exe -NoProfile -Command "Get-Content README.md"',
      shellKind: 'cmd',
      workspace: workspace(),
    }).disposition).toBe('workspace-tool-required');
    expect(classifyAiFileCommand({
      command: 'cmd /c "type README.md"',
      shellKind: 'powershell',
      workspace: workspace(),
    }).disposition).toBe('workspace-tool-required');
  });

  it.each([
    ['Write-Output "Get-Content README.md"', 'powershell' as const],
    ['# Get-Content README.md', 'powershell' as const],
    ['echo "cat README.md"', 'posix' as const],
    ['# cat README.md', 'posix' as const],
    ['npm run build', 'powershell' as const],
    ['git status --short', 'powershell' as const],
  ])('does not match strings, comments, or ordinary commands: %s', (command, shellKind) => {
    expect(classifyAiFileCommand({ command, shellKind, workspace: workspace() }).disposition)
      .toBe('allow');
  });

  it.each([
    ['type README.md', 'cmd' as const, 'read'],
    ['findstr needle README.md', 'cmd' as const, 'search'],
    ['dir /b', 'cmd' as const, 'list'],
    ['cat README.md', 'posix' as const, 'read'],
    ['grep needle README.md', 'wsl' as const, 'search'],
    ['ls .', 'git-bash' as const, 'list'],
    ['stat README.md', 'posix' as const, 'stat'],
  ])('covers CMD and POSIX command positions: %s', (command, shellKind, category) => {
    expect(classifyAiFileCommand({
      command,
      shellKind,
      workspace: workspace({ readablePaths: shellKind === 'cmd' ? ['C:\\work'] : ['/work'] }),
    })).toMatchObject({ disposition: 'workspace-tool-required', categories: [category] });
  });

  it('requires an exact exception approval when tools are unavailable or scope is insufficient', () => {
    expect(classifyAiFileCommand({
      command: 'Get-Content README.md',
      shellKind: 'powershell',
      workspace: workspace({ enabled: false, read: false, readablePaths: [] }),
    })).toMatchObject({
      disposition: 'exception-approval',
      reasonCode: 'WORKSPACE_TOOLS_UNAVAILABLE',
    });
    expect(classifyAiFileCommand({
      command: 'Get-Content C:\\outside\\secret.txt',
      shellKind: 'powershell',
      workspace: workspace(),
    })).toMatchObject({
      disposition: 'exception-approval',
      reasonCode: 'WORKSPACE_SCOPE_INSUFFICIENT',
    });
  });

  it.each([
    ['Get-Content app.log -Wait', 'powershell' as const],
    ['tail -f app.log', 'posix' as const],
    ['Get-Content a.txt | Measure-Object', 'powershell' as const],
    ['Get-Content a.txt > copy.txt', 'powershell' as const],
  ])('requires an exception for non-equivalent terminal semantics: %s', (command, shellKind) => {
    expect(classifyAiFileCommand({
      command,
      shellKind,
      workspace: workspace({ readablePaths: shellKind === 'powershell' ? ['C:\\work'] : ['/work'] }),
    })).toMatchObject({
      disposition: 'exception-approval',
      reasonCode: 'NON_EQUIVALENT_TERMINAL_SEMANTICS',
    });
  });
});

