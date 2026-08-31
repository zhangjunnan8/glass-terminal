import type { AgentReviewMode } from '../../shared/agent';
import type { FileToolReviewRequest } from '../../shared/tools';

export interface RiskDecision {
  approvalRequired: boolean;
  level: 'safe' | 'dangerous' | 'unknown';
  reason?: string;
}

const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|[\\/])\.ssh(?:[\\/]|$)/iu,
  /(?:^|[\\/])\.aws(?:[\\/]|$)/iu,
  /(?:^|[\\/])\.gnupg(?:[\\/]|$)/iu,
  /(?:^|[\\/])\.kube(?:[\\/]|$)/iu,
  /(?:^|[\\/])\.docker(?:[\\/]|$)/iu,
  /(?:^|[\\/])\.(?:azure|config[\\/](?:gcloud|gh|op))(?:[\\/]|$)/iu,
  /(?:^|[\\/])\.env(?:\.[^\\/]*)?$/iu,
  /(?:^|[\\/])(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/iu,
  /(?:^|[\\/])(?:credentials|secrets?|tokens?|id_rsa|id_ed25519)(?:\.[^\\/]*)?$/iu,
  /(?:^|[\\/])AppData[\\/]Roaming[\\/](?:Microsoft[\\/]Credentials|gcloud)(?:[\\/]|$)/iu,
  /(?:^|[\\/])AppData[\\/]Local[\\/](?:Google[\\/]Chrome|Microsoft[\\/]Edge)[\\/]User Data(?:[\\/]|$)/iu,
  /(?:^|[\\/])Library[\\/]Keychains(?:[\\/]|$)/iu,
  /^\/(?:etc\/(?:shadow|sudoers)|root)(?:[\\/]|$)/iu,
];

const RECURSIVE_DELETE_PATTERNS: readonly RegExp[] = [
  /(?:^|[;&|]\s*)rm\s+(?:-[a-z]*r[a-z]*f?|-f[a-z]*r[a-z]*)\b/iu,
  /\b(?:Remove-Item|ri|del|erase|rmdir|rd)\b[^\r\n;|]*(?:-Recurse|-r\b)/iu,
  /(?:^|[;&|]\s*)(?:rmdir|rd)\s+\/s\b/iu,
  /(?:^|[;&|]\s*)(?:del|erase)\s+\/s\b/iu,
  /\b(?:find|forfiles)\b[^\r\n]*(?:-delete|\/c\s+["']?del\b)/iu,
];

const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  ...RECURSIVE_DELETE_PATTERNS,
  /\b(?:format|diskpart|mkfs(?:\.[a-z0-9]+)?|fdisk|parted|bcdedit)\b/iu,
  /\b(?:shutdown|reboot|Restart-Computer|Stop-Computer)\b/iu,
  /\b(?:net\s+user|useradd|userdel|passwd|visudo|chmod\s+777|chown\s+-R)\b/iu,
  /\b(?:sc\.exe|systemctl|service)\b[^\r\n]*(?:delete|disable|stop|mask)/iu,
  /\b(?:Invoke-Expression|iex|eval|exec)\b/iu,
  /\b(?:EncodedCommand|-enc\b|FromBase64String)\b/iu,
  /(?:curl|wget|Invoke-WebRequest|iwr)\b[^\r\n]*(?:\||;|&&)\s*(?:sh|bash|zsh|pwsh|powershell|cmd)\b/iu,
  /\b(?:reg\s+(?:delete|add)|Set-ExecutionPolicy)\b/iu,
];

const SAFE_COMMAND_PATTERNS: readonly RegExp[] = [
  /^\s*(?:pwd|whoami|hostname|date|Get-Date|Get-Location|gl|Write-Output|echo)(?:\s+[^;&|<>]*)?\s*$/iu,
  /^\s*(?:git\s+(?:status|diff|log|show|branch)|npm\s+(?:test|run\s+(?:test|build|lint|typecheck)))(?:\s+[^;&|<>]*)?\s*$/iu,
  /^\s*(?:node|python|python3|pytest|vitest|tsc)\s+(?:--version|-V|--help)\s*$/iu,
];

// Even a command whose outer verb is allowlisted becomes dynamic when the
// shell expands variables/subcommands. Risk Review fails such syntax closed.
const DYNAMIC_COMMAND_SYNTAX = /[`$()]|%[^%\r\n]+%|![^!\r\n]+!|[\r\n]/u;

export function isSensitiveFilePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path.trim()));
}

export function classifyTerminalCommand(
  mode: AgentReviewMode,
  command: string,
  agentRisk: 'normal' | 'elevated' = 'normal',
): RiskDecision {
  if (mode === 'complete') return { approvalRequired: false, level: 'safe' };
  if (mode === 'all') {
    return { approvalRequired: true, level: 'unknown', reason: '“全部审核”会逐条审核所有终端命令。' };
  }
  if (agentRisk === 'elevated') {
    return { approvalRequired: true, level: 'dangerous', reason: '智能体主动将此命令标记为高风险。' };
  }
  if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    return { approvalRequired: true, level: 'dangerous', reason: '软件检测到危险、破坏性或难以恢复的命令。' };
  }
  if (
    !DYNAMIC_COMMAND_SYNTAX.test(command)
    && SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
  ) {
    return { approvalRequired: false, level: 'safe' };
  }
  return {
    approvalRequired: true,
    level: 'unknown',
    reason: '命令不在严格安全白名单中；风险审核对未知、组合或动态命令默认请求确认。',
  };
}

export function classifyFileOperation(
  mode: AgentReviewMode,
  request: FileToolReviewRequest,
): RiskDecision & { sensitive: boolean } {
  // file_search reads and returns matching content previews, so it has the same
  // Provider-exposure boundary as file_read. list/glob/stat only expose names or metadata.
  const sensitive = (request.operation === 'read' || request.operation === 'search')
    && isSensitiveFilePath(request.target);
  if (mode === 'complete') return { approvalRequired: false, level: 'safe', sensitive };
  if (mode === 'all') {
    return {
      approvalRequired: true,
      level: request.recursive ? 'dangerous' : 'unknown',
      reason: request.recursive
        ? '递归删除会影响目录树，批准只对本次精确操作生效。'
        : '“全部审核”会审核所有文件工具操作。',
      sensitive,
    };
  }
  if (request.agentRisk === 'elevated') {
    return {
      approvalRequired: true,
      level: 'dangerous',
      reason: request.riskReason || '智能体主动将此文件操作标记为高风险。',
      sensitive,
    };
  }
  if (request.operation === 'delete' && request.recursive) {
    return {
      approvalRequired: true,
      level: 'dangerous',
      reason: '风险审核仅对递归删除强制进行精确的一次性确认；单文件和空目录删除可自动执行。',
      sensitive,
    };
  }
  if (sensitive) {
    return {
      approvalRequired: true,
      level: 'dangerous',
      reason: '将读取已知敏感路径；批准后文件内容会发送给当前 AI Provider。',
      sensitive,
    };
  }
  return { approvalRequired: false, level: 'safe', sensitive };
}
