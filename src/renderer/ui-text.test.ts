import { describe, expect, it } from 'vitest';
import {
  agentStateLabel,
  authMethodLabel,
  codexNativeAgentAvailabilityLabel,
  executionStatusLabel,
  providerStatusLabel,
  codexAppServerOperationLabel,
  codexAppServerPhaseLabel,
  codexPlanTypeLabel,
  codexReasoningEffortLabel,
  formatClock,
  formatDuration,
  roleLabel,
  sessionStatusLabel,
  transferStatusLabel,
} from './ui-text';

describe('Chinese UI labels', () => {
  it('localizes control, provider, and session states', () => {
    expect(agentStateLabel('WAITING_AUTH')).toBe('等待安全认证');
    expect(providerStatusLabel('not-tested')).toBe('未测试');
    expect(codexAppServerPhaseLabel('detecting')).toBe('正在检测 Codex CLI');
    expect(codexAppServerOperationLabel('logging-in')).toBe('正在准备登录');
    expect(codexNativeAgentAvailabilityLabel(true)).toBe('原生模式可用');
    expect(codexNativeAgentAvailabilityLabel(false)).toBe('原生模式不可用');
    expect(codexReasoningEffortLabel('xhigh')).toBe('极高');
    expect(codexPlanTypeLabel('plus')).toBe('Plus 版');
    expect(sessionStatusLabel('disconnected')).toBe('已断开');
  });

  it('localizes execution, transfer, authentication, and message roles', () => {
    expect(executionStatusLabel('cancelled')).toBe('已取消');
    expect(transferStatusLabel('running')).toBe('传输中');
    expect(authMethodLabel('private-key')).toBe('私钥');
    expect(roleLabel('user')).toBe('用户');
  });

  it('formats wall-clock time and turn durations', () => {
    expect(formatClock('2026-08-15T14:02:31.000Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(formatClock('not-a-date')).toBe('');
    expect(formatDuration(250)).toBe('250 毫秒');
    expect(formatDuration(12_400)).toBe('12.4 秒');
    expect(formatDuration(75_000)).toBe('1 分 15 秒');
    expect(formatDuration(-1)).toBe('');
  });
});
