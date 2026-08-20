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
  /** Selects neutral Codex semantics even before the first provider event arrives. */
  providerManaged?: boolean;
}

function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  const value = tokens / 1_000;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}k`;
}

function knownProviderUsage(usage: AgentContextUsage | undefined): usage is Extract<
  AgentContextUsage,
  { source: 'provider-reported' }
> & Required<Pick<Extract<AgentContextUsage, { source: 'provider-reported' }>,
  'currentTokens' | 'contextWindowTokens' | 'percentage'
>> {
  return usage?.source === 'provider-reported'
    && Number.isSafeInteger(usage.currentTokens)
    && usage.currentTokens! >= 0
    && Number.isSafeInteger(usage.contextWindowTokens)
    && usage.contextWindowTokens! > 0
    && Number.isFinite(usage.percentage);
}

export function AgentContextMeter({
  usage,
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
  providerManaged = false,
}: AgentContextMeterProps) {
  const codexManaged = providerManaged || usage?.source === 'provider-reported';
  const providerKnown = codexManaged && knownProviderUsage(usage);
  const compressing = usage?.status === 'compressing';

  if (codexManaged) {
    const percentage = providerKnown
      ? Math.max(0, Math.min(100, usage.percentage))
      : 0;
    const title = providerKnown
      ? [
        `Codex 实际上下文 ${usage.currentTokens.toLocaleString('zh-CN')} tokens`,
        `模型窗口 ${usage.contextWindowTokens.toLocaleString('zh-CN')} tokens`,
        '由 Codex 管理；Glass Terminal 不会主动触发压缩',
        usage.lastCompressedAt
          ? `上次压缩 ${new Date(usage.lastCompressedAt).toLocaleTimeString('zh-CN')}`
          : '尚未收到压缩完成事件',
      ].join('\n')
      : [
        '由 Codex 管理，等待用量数据',
        'Glass Terminal 不会主动触发压缩',
        ...(usage?.lastCompressedAt
          ? [`上次压缩 ${new Date(usage.lastCompressedAt).toLocaleTimeString('zh-CN')}`]
          : []),
      ].join('\n');
    const ariaLabel = compressing
      ? 'Codex 正在压缩上下文'
      : providerKnown ? 'Codex 实际上下文用量' : 'Codex 上下文用量未知';

    return (
      <div
        className={`agent-context-meter ${compressing ? 'compressing' : providerKnown && percentage >= 80 ? 'warning' : ''} ${providerKnown ? '' : 'unknown'}`}
        data-testid="agent-context-meter"
        data-context-source="provider-reported"
        data-context-known={providerKnown ? 'true' : 'false'}
        data-context-status={compressing ? 'compressing' : 'ready'}
        title={title}
      >
        <div
          className="agent-context-ring"
          role="progressbar"
          aria-label={ariaLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(providerKnown ? { 'aria-valuenow': percentage } : {})}
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
          <strong>{compressing ? '…' : providerKnown ? `${percentage}%` : '—'}</strong>
        </div>
        <span className="agent-context-copy">
          <b>{compressing ? 'Codex 正在压缩上下文' : 'Codex 实际用量'}</b>
          <small>{providerKnown
            ? `${compactTokens(usage.currentTokens)} / ${compactTokens(usage.contextWindowTokens)} · 由 Codex 管理`
            : '由 Codex 管理，等待用量数据'}</small>
        </span>
      </div>
    );
  }

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
