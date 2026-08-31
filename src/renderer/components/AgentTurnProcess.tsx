import type { ReactNode } from 'react';
import type { AgentToolActivity } from '../../shared/agent';
import { ToolActivityList } from './ToolActivityList';

interface AgentTurnProcessProps {
  completed: boolean;
  stageCount: number;
  activities: readonly AgentToolActivity[];
  children: ReactNode;
}

/**
 * Keeps the current turn readable while it is running, then collapses the
 * process once the final summary has actually arrived. The native disclosure
 * remains user-toggleable after that automatic transition.
 */
export function AgentTurnProcess({
  completed,
  stageCount,
  activities,
  children,
}: AgentTurnProcessProps) {
  return (
    <details
      className="agent-turn-process"
      data-completed={completed ? 'true' : 'false'}
      open={!completed}
    >
      <summary>执行过程 · {stageCount} 个阶段 · {activities.length} 项工具活动</summary>
      <div className="agent-turn-process-body">
        {children}
        <ToolActivityList activities={activities} compact defaultExpanded />
      </div>
    </details>
  );
}
