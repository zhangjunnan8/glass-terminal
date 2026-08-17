import { useState } from 'react';
import type { AgentToolActivity } from '../../shared/agent';

const MAX_VISIBLE_ACTIVITIES = 8;
const MAX_SUMMARY_ITEMS = 3;

const STATUS_LABELS: Record<AgentToolActivity['status'], string> = {
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

interface ToolActivityListProps {
  activities: readonly AgentToolActivity[];
}

/**
 * Bounded, collapsed-by-default summary of recent tool use. The full list stays
 * in the DOM (visually hidden) so it remains accessible to tests and screen
 * readers, while the default view keeps the last assistant message adjacent to
 * the composer instead of being pushed away by an always-expanded activity list.
 */
export function ToolActivityList({ activities }: ToolActivityListProps) {
  const [expanded, setExpanded] = useState(false);
  const recentActivities = activities.slice(-MAX_VISIBLE_ACTIVITIES);
  if (!recentActivities.length) return null;

  const runningCount = recentActivities.filter((activity) => activity.status === 'running').length;
  const summary = recentActivities
    .slice(0, MAX_SUMMARY_ITEMS)
    .map((activity) => activity.label)
    .join(' · ');
  const truncated = recentActivities.length > MAX_SUMMARY_ITEMS;

  return (
    <section
      className={`tool-activity-list ${expanded ? 'expanded' : 'collapsed'}`}
      data-testid="tool-activity-list"
      data-expanded={expanded ? 'true' : 'false'}
      aria-label="工具活动"
    >
      <button
        type="button"
        className="tool-activity-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="tool-activity-toggle-count">
          工具操作 {recentActivities.length} 项
          {runningCount > 0 ? ` · ${runningCount} 项运行中` : ''}
        </span>
        {!expanded && (
          <small className="tool-activity-toggle-summary">
            {summary}{truncated ? '…' : ''}
          </small>
        )}
        <span className="tool-activity-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      <ol>
        {recentActivities.map((activity) => (
          <li
            key={activity.id}
            className="tool-activity-item"
            data-kind={activity.kind}
            data-status={activity.status}
          >
            <span className="tool-activity-dot" aria-hidden="true" />
            <div className="tool-activity-copy">
              <strong>{activity.label}</strong>
              {activity.summary && <small>{activity.summary}</small>}
            </div>
            <span className="tool-activity-status-text">
              状态：{STATUS_LABELS[activity.status]}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
