import type { AgentContextUsage } from '../../shared/agent';
import {
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
  const normalizedWindow = normalizedContextWindowTokens(
    usage?.contextWindowTokens ?? contextWindowTokens,
  );
  const threshold = usage?.compressionThresholdTokens
    ?? contextCompressionThreshold(normalizedWindow);
  const estimatedTokens = usage?.estimatedTokens ?? 0;
  const percentage = Math.max(0, Math.min(100, usage?.percentage ?? 0));
  const compressing = usage?.status === 'compressing';
  const title = [
    `当前估算 ${estimatedTokens.toLocaleString('zh-CN')} tokens`,
    `自动压缩阈值 ${threshold.toLocaleString('zh-CN')} tokens`,
    `模型窗口 ${normalizedWindow.toLocaleString('zh-CN')} tokens`,
    usage?.lastCompressedAt
      ? `上次压缩 ${new Date(usage.lastCompressedAt).toLocaleTimeString('zh-CN')}`
      : '尚未触发自动压缩',
  ].join('\n');

  return (
    <div
      className={`agent-context-meter ${compressing ? 'compressing' : percentage >= 80 ? 'warning' : ''}`}
      data-testid="agent-context-meter"
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
        <small>{compactTokens(estimatedTokens)} / {compactTokens(threshold)}</small>
      </span>
    </div>
  );
}
