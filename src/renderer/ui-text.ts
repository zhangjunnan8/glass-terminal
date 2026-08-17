import type {
  AgentChatItem,
  AgentRuntimeState,
  CommandExecutionStatus,
} from '../shared/agent';
import type { SshAuthMethod } from '../shared/host';
import type { ProviderStatus } from '../shared/provider';
import type {
  CodexAppServerOperation,
  CodexAppServerPhase,
} from '../shared/codex-app-server';
import type { SessionStatus } from '../shared/session';
import type { TransferStatus } from '../shared/sftp';

const agentStateLabels: Record<AgentRuntimeState, string> = {
  USER_CONTROL: '用户控制',
  THINKING: 'AI 正在思考',
  WAITING_APPROVAL: '等待命令审批',
  AI_CONTROL: 'AI 正在控制',
  RUNNING: '命令执行中',
  WAITING_OUTPUT: '等待命令输出',
  WAITING_AUTH: '等待安全认证',
  TAKEOVER_PENDING: '正在交还控制权',
  PAUSED: 'AI 已暂停',
  COMPLETED: '任务已完成',
  FAILED: '任务失败',
};

const providerStatusLabels: Record<ProviderStatus, string> = {
  'not-tested': '未测试',
  ready: '可用',
  error: '连接失败',
};

const codexAppServerPhaseLabels: Record<CodexAppServerPhase, string> = {
  stopped: '尚未启动',
  detecting: '正在检测 Codex CLI',
  starting: '正在启动并握手',
  ready: '服务已就绪',
  error: '服务不可用',
};

const codexAppServerOperationLabels: Record<CodexAppServerOperation, string> = {
  idle: '空闲',
  starting: '正在启动服务',
  restarting: '正在重启服务',
  refreshing: '正在刷新账号与模型',
  'logging-in': '正在准备登录',
  'logging-out': '正在退出登录',
  saving: '正在保存首选模型',
};

const codexReasoningEffortLabels: Record<string, string> = {
  none: '无',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: '超高',
};

const codexPlanTypeLabels: Record<string, string> = {
  free: '免费版',
  go: 'Go 版',
  plus: 'Plus 版',
  pro: 'Pro 版',
  team: '团队版',
  business: '商业版',
  enterprise: '企业版',
  edu: '教育版',
};

const sessionStatusLabels: Record<SessionStatus, string> = {
  active: '活动中',
  disconnected: '已断开',
  interrupted: '已中断',
};

const executionStatusLabels: Record<CommandExecutionStatus, string> = {
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const transferStatusLabels: Record<TransferStatus, string> = {
  queued: '排队中',
  running: '传输中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const authMethodLabels: Record<SshAuthMethod, string> = {
  password: '用户名和密码',
  'keyboard-interactive': '键盘交互认证',
  'private-key': '私钥',
  agent: 'Windows OpenSSH / Pageant 代理',
};

const roleLabels: Record<AgentChatItem['role'], string> = {
  assistant: 'AI',
  user: '用户',
  system: '系统',
};

export const agentStateLabel = (state: AgentRuntimeState) => agentStateLabels[state];
export const providerStatusLabel = (status: ProviderStatus) => providerStatusLabels[status];
export const codexAppServerPhaseLabel = (phase: CodexAppServerPhase) => (
  codexAppServerPhaseLabels[phase]
);
export const codexAppServerOperationLabel = (operation: CodexAppServerOperation) => (
  codexAppServerOperationLabels[operation]
);
export const codexNativeAgentAvailabilityLabel = (available: boolean) => (
  available ? '原生模式可用' : '原生模式不可用'
);
export const codexReasoningEffortLabel = (effort: string) => (
  codexReasoningEffortLabels[effort.toLowerCase()] ?? effort
);
export const codexPlanTypeLabel = (planType: string) => (
  codexPlanTypeLabels[planType.toLowerCase()] ?? planType
);
export const sessionStatusLabel = (status: SessionStatus) => sessionStatusLabels[status];
export const executionStatusLabel = (status: CommandExecutionStatus) => executionStatusLabels[status];
export const transferStatusLabel = (status: TransferStatus) => transferStatusLabels[status];
export const authMethodLabel = (method: SshAuthMethod) => authMethodLabels[method];
export const roleLabel = (role: AgentChatItem['role']) => roleLabels[role];

/** Locale-independent wall-clock time, e.g. "14:02:31". */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Compact duration label for a single turn or command, e.g. "12.4 秒". */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}
