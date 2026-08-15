import type {
  AgentChatItem,
  AgentRuntimeState,
  CommandExecutionStatus,
} from '../shared/agent';
import type { SshAuthMethod } from '../shared/host';
import type { ProviderStatus } from '../shared/provider';
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
export const sessionStatusLabel = (status: SessionStatus) => sessionStatusLabels[status];
export const executionStatusLabel = (status: CommandExecutionStatus) => executionStatusLabels[status];
export const transferStatusLabel = (status: TransferStatus) => transferStatusLabels[status];
export const authMethodLabel = (method: SshAuthMethod) => authMethodLabels[method];
export const roleLabel = (role: AgentChatItem['role']) => roleLabels[role];
