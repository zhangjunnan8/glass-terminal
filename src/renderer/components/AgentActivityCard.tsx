interface AgentActivityCardProps {
  phase: string;
  backend: string;
  context: string;
  interruptLabel: string;
  interruptDisabled: boolean;
  onInterrupt: () => void;
}

export function AgentActivityCard({
  phase,
  backend,
  context,
  interruptLabel,
  interruptDisabled,
  onInterrupt,
}: AgentActivityCardProps) {
  return (
    <div
      className="agent-activity-card"
      data-testid="agent-activity-card"
      role="group"
      aria-label="AI 运行状态"
    >
      <div className="agent-activity-main">
        <span className="agent-activity-dots" aria-hidden="true" data-testid="agent-activity-dots">
          <span />
          <span />
          <span />
        </span>
        <div className="agent-activity-copy">
          <strong role="status" aria-live="polite" aria-atomic="true">{phase}</strong>
          <small title={`${backend} · ${context}`}>{backend} · {context}</small>
        </div>
      </div>
      <button
        type="button"
        className="interrupt"
        data-action="interrupt-agent-message"
        disabled={interruptDisabled}
        title="停止当前轮次；已发生的终端操作不会回滚"
        onClick={onInterrupt}
      >{interruptLabel}</button>
    </div>
  );
}
