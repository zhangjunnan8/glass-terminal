import type { AgentContextUsage } from '../../shared/agent';
import {
  DEFAULT_CONTEXT_ESTIMATE_SAFETY_FACTOR,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  contextCompressionThreshold,
  normalizedContextWindowTokens,
} from '../../shared/context-window';

interface AgentContextMeterProps {
  usage?: AgentContextUsage;
  contextWindowTokens?: number;
}

function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  const value = tokens / 1_000;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}k`;
}

export function AgentContextMeter({
  usage,
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
}: AgentContextMeterProps) {
  const compressing = usage?.status === 'compressing';

  const estimatedUsage = usage?.source === 'estimated' ? usage : undefined;
  const normalizedWindow = normalizedContextWindowTokens(
    estimatedUsage?.contextWindowTokens ?? contextWindowTokens,
  );
  const threshold = estimatedUsage?.compressionThresholdTokens
    ?? contextCompressionThreshold(normalizedWindow);
  const estimatedTokens = estimatedUsage?.estimatedTokens ?? 0;
  const messageEstimatedTokens = estimatedUsage?.messageEstimatedTokens ?? estimatedTokens;
  const toolSchemaEstimatedTokens = estimatedUsage?.toolSchemaEstimatedTokens ?? 0;
  const fixedOverheadTokens = estimatedUsage?.fixedOverheadTokens ?? 0;
  const safetyFactor = estimatedUsage?.safetyFactor ?? DEFAULT_CONTEXT_ESTIMATE_SAFETY_FACTOR;
  const boundToolCount = estimatedUsage?.boundToolCount ?? 0;
  const percentage = Math.max(0, Math.min(100, estimatedUsage?.percentage ?? 0));
  const title = [
    `上下文估算值 ${estimatedTokens.toLocaleString('zh-CN')} tokens（已含安全余量）`,
    `消息估算 ${messageEstimatedTokens.toLocaleString('zh-CN')} tokens`,
    `工具 Schema 估算 ${toolSchemaEstimatedTokens.toLocaleString('zh-CN')} tokens（${boundToolCount} 个工具）`,
    `固定包装预留 ${fixedOverheadTokens.toLocaleString('zh-CN')} tokens`,
    `估算安全系数 ×${safetyFactor.toFixed(2)}`,
    `安全阈值 ${threshold.toLocaleString('zh-CN')} tokens（达到时自动压缩）`,
    `模型窗口 ${normalizedWindow.toLocaleString('zh-CN')} tokens`,
    ...(estimatedUsage?.providerReportedInputTokens !== undefined
      ? [`Provider 上次报告输入 ${estimatedUsage.providerReportedInputTokens.toLocaleString('zh-CN')} tokens（仅诊断）`]
      : []),
    estimatedUsage?.lastCompressedAt
      ? `上次压缩 ${new Date(estimatedUsage.lastCompressedAt).toLocaleTimeString('zh-CN')}`
      : '尚未触发自动压缩',
  ].join('\n');

  return (
    <div
      className={`agent-context-meter ${compressing ? 'compressing' : percentage >= 80 ? 'warning' : ''}`}
      data-testid="agent-context-meter"
      data-context-source="estimated"
      data-context-known="true"
      data-context-status={compressing ? 'compressing' : 'ready'}
      title={title}
    >
      <div
        className="agent-context-ring"
        role="progressbar"
        aria-label={compressing ? '正在压缩上下文' : '上下文用量'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
      >
        <svg viewBox="0 0 44 44" aria-hidden="true">
          <circle className="agent-context-ring-track" cx="22" cy="22" r="18" />
          <circle
            className="agent-context-ring-value"
            cx="22"
            cy="22"
            r="18"
            pathLength="100"
            strokeDasharray={`${percentage} 100`}
          />
        </svg>
        <strong>{compressing ? '…' : `${percentage}%`}</strong>
      </div>
      <span className="agent-context-copy">
        <b>{compressing ? '正在压缩上下文' : '上下文'}</b>
        <small>估算 {compactTokens(estimatedTokens)} / {compactTokens(threshold)}</small>
      </span>
    </div>
  );
}
