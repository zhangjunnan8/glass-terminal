import type { AgentToolActivity } from '../../shared/agent';

const MAX_VISIBLE_ACTIVITIES = 8;

const STATUS_LABELS: Record<AgentToolActivity['status'], string> = {
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

interface ToolActivityListProps {
  activities: readonly AgentToolActivity[];
}

export function ToolActivityList({ activities }: ToolActivityListProps) {
  const recentActivities = activities.slice(-MAX_VISIBLE_ACTIVITIES);
  if (!recentActivities.length) return null;

  return (
    <section
      className="tool-activity-list"
      data-testid="tool-activity-list"
      aria-label="工具活动"
    >
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
