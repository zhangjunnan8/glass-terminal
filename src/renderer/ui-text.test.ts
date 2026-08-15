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
});
