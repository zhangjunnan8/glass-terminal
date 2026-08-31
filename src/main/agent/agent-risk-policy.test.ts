import { describe, expect, it } from 'vitest';
import {
  classifyFileOperation,
  classifyTerminalCommand,
  isSensitiveFilePath,
} from './agent-risk-policy';

describe('Beta.4 atomic Agent risk policy', () => {
  it('reviews every operation in All Review and none in Complete Access', () => {
    expect(classifyTerminalCommand('all', 'echo ok').approvalRequired).toBe(true);
    expect(classifyTerminalCommand('complete', 'rm -rf /tmp/demo').approvalRequired).toBe(false);
    expect(classifyFileOperation('all', {
      toolName: 'file_stat', operation: 'stat', target: '/tmp/demo',
    }).approvalRequired).toBe(true);
    expect(classifyFileOperation('complete', {
      toolName: 'file_delete', operation: 'delete', target: '/tmp/demo', recursive: true,
    }).approvalRequired).toBe(false);
  });

  it('lets software remain the final arbiter while the Agent can only raise risk', () => {
    expect(classifyTerminalCommand('risky', 'git status', 'normal').approvalRequired).toBe(false);
    expect(classifyTerminalCommand('risky', 'git status', 'elevated').approvalRequired).toBe(true);
    expect(classifyTerminalCommand('risky', 'Remove-Item C:\\data -Recurse', 'normal'))
      .toMatchObject({ approvalRequired: true, level: 'dangerous' });
    expect(classifyTerminalCommand('risky', 'ri C:\\data -r', 'normal'))
      .toMatchObject({ approvalRequired: true, level: 'dangerous' });
    expect(classifyTerminalCommand('risky', 'del /s C:\\data\\*', 'normal'))
      .toMatchObject({ approvalRequired: true, level: 'dangerous' });
    expect(classifyTerminalCommand('risky', '$x = Read-Host; & $x', 'normal'))
      .toMatchObject({ approvalRequired: true, level: 'unknown' });
    expect(classifyTerminalCommand('risky', 'echo $(whoami)', 'normal'))
      .toMatchObject({ approvalRequired: true, level: 'unknown' });
    expect(classifyTerminalCommand('risky', 'Write-Output $env:USERPROFILE', 'normal'))
      .toMatchObject({ approvalRequired: true, level: 'unknown' });
  });

  it('auto-runs single deletes but reviews recursive deletes in Risk Review', () => {
    expect(classifyFileOperation('risky', {
      toolName: 'file_delete', operation: 'delete', target: 'one.txt', recursive: false,
    }).approvalRequired).toBe(false);
    expect(classifyFileOperation('risky', {
      toolName: 'file_delete', operation: 'delete', target: 'build', recursive: true,
    })).toMatchObject({ approvalRequired: true, level: 'dangerous' });
  });

  it('reviews sensitive content reads and warns that content is sent to the Provider', () => {
    expect(isSensitiveFilePath('C:\\Users\\tester\\.ssh\\id_ed25519')).toBe(true);
    expect(isSensitiveFilePath('/home/tester/.npmrc')).toBe(true);
    expect(classifyFileOperation('risky', {
      toolName: 'file_read', operation: 'read', target: '/home/tester/.ssh/config',
    })).toMatchObject({ approvalRequired: true, sensitive: true });
    expect(classifyFileOperation('risky', {
      toolName: 'file_search', operation: 'search', target: '/home/tester/.ssh',
    })).toMatchObject({ approvalRequired: true, sensitive: true });
    expect(classifyFileOperation('risky', {
      toolName: 'file_stat', operation: 'stat', target: '/home/tester/.ssh/config',
    })).toMatchObject({ approvalRequired: false, sensitive: false });
  });
});
