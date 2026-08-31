import type { ChangeEvent } from 'react';
import type { AgentReviewMode } from '../../shared/agent';

interface AgentReviewModePickerProps {
  value: AgentReviewMode;
  disabled?: boolean;
  onSelect(mode: AgentReviewMode): void;
}

export function AgentReviewModePicker({
  value,
  disabled = false,
  onSelect,
}: AgentReviewModePickerProps) {
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    onSelect(event.currentTarget.value as AgentReviewMode);
  };

  return (
    <label className={`agent-review-picker ${value === 'complete' ? 'complete-access' : ''}`}>
      <span>审核模式</span>
      <select
        aria-label="智能体操作审核模式"
        data-testid="agent-review-mode-picker"
        value={value}
        disabled={disabled}
        onChange={handleChange}
      >
        <option value="all">全部审核</option>
        <option value="risky">风险审核</option>
        <option value="complete">完全访问</option>
      </select>
    </label>
  );
}
