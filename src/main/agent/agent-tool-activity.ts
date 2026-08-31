import { createHash } from 'node:crypto';
import type {
  AgentBackendEvent,
  AgentToolCall,
} from './agent-backend';
import type {
  AgentToolActivity,
  AgentToolActivityKind,
  AgentToolActivityStatus,
} from '../../shared/agent';

export const MAX_AGENT_TOOL_ACTIVITIES = 24;
export const MAX_AGENT_TOOL_ACTIVITY_LABEL_CHARS = 160;
export const MAX_AGENT_TOOL_ACTIVITY_SUMMARY_CHARS = 240;

const MAX_IDENTIFIER_CHARS = 128;
const MAX_TOOL_NAME_CHARS = 96;
const MAX_STRUCTURED_PATH_CHARS = 120;
const MAX_JSON_PARSE_CHARS = 64 * 1024;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

type StructuredRecord = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function truncateCodePoints(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let result = '';
  let count = 0;
  for (const character of value) {
    if (count >= maxChars - 1) break;
    result += character;
    count += 1;
  }
  return `${result}…`;
}

function sanitizedText(value: unknown, maxChars: number): string {
  const raw = asString(value);
  if (!raw) return '';
  // Bound work before applying Unicode regular expressions to hostile input.
  const sample = raw.slice(0, Math.min(raw.length, maxChars * 4 + 16));
  const cleaned = sample
    .replace(CONTROL_OR_FORMAT, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return truncateCodePoints(cleaned, maxChars);
}

function safeIdentifier(call: AgentToolCall): string {
  const raw = asString(call.id);
  const cleaned = sanitizedText(raw, MAX_IDENTIFIER_CHARS);
  if (raw && raw.length <= MAX_IDENTIFIER_CHARS && cleaned === raw) return raw;
  const argumentsText = asString(call.arguments);
  const boundedFingerprint = raw
    ? `${raw.slice(0, 512)}\0${raw.slice(-512)}\0${raw.length}`
    : `${asString(call.name).slice(0, 256)}\0${argumentsText.slice(0, 512)}\0${argumentsText.slice(-512)}\0${argumentsText.length}`;
  const digest = createHash('sha256')
    .update(boundedFingerprint)
    .digest('hex')
    .slice(0, 24);
  return `tool-${digest}`;
}

function safeToolName(call: AgentToolCall): string {
  return sanitizedText(call.name, MAX_TOOL_NAME_CHARS) || 'unknown_tool';
}

function parseBoundedRecord(value: unknown): StructuredRecord | undefined {
  const raw = asString(value);
  if (!raw || raw.length > MAX_JSON_PARSE_CHARS) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as StructuredRecord
      : undefined;
  } catch {
    return undefined;
  }
}

function activityKind(toolName: string): AgentToolActivityKind {
  if (toolName.startsWith('terminal_')) return 'terminal';
  if (toolName.startsWith('workspace_') || toolName.startsWith('file_')) return 'workspace';
  return 'other';
}

function structuredPath(record: StructuredRecord | undefined, key = 'path'): string {
  return sanitizedText(record?.[key], MAX_STRUCTURED_PATH_CHARS);
}

function withPath(verb: string, path: string): string {
  return sanitizedText(path ? `${verb} ${path}` : verb, MAX_AGENT_TOOL_ACTIVITY_LABEL_CHARS);
}

function activityLabel(call: AgentToolCall, toolName: string): string {
  const args = parseBoundedRecord(call.arguments);
  const path = structuredPath(args);
  switch (toolName) {
    case 'terminal_read': return 'Read terminal output';
    case 'terminal_state': return 'Inspect terminal state';
    case 'terminal_execute': return 'Run terminal command';
    case 'workspace_list':
    case 'file_list': return withPath('List', path || '.');
    case 'workspace_read_file':
    case 'file_read': return withPath('Read', path);
    case 'workspace_stat':
    case 'file_stat': return withPath('Stat', path);
    case 'workspace_search': return withPath('Search workspace', path);
    case 'file_search': return withPath('Search files', path);
    case 'workspace_glob': return withPath('Glob workspace', path);
    case 'file_glob': return withPath('Glob files', path);
    case 'workspace_apply_patch':
    case 'file_patch': return withPath('Patch', path);
    case 'workspace_write_file':
    case 'file_write': return withPath('Write', path);
    case 'workspace_mkdir':
    case 'file_mkdir': return withPath('Create directory', path);
    case 'workspace_delete':
    case 'file_delete': return withPath('Delete', path);
    case 'workspace_rename':
    case 'file_rename': {
      const source = structuredPath(args, 'source');
      const destination = structuredPath(args, 'destination');
      return sanitizedText(
        source || destination
          ? `Rename ${source || '?'} → ${destination || '?'}`
          : 'Rename workspace path',
        MAX_AGENT_TOOL_ACTIVITY_LABEL_CHARS,
      );
    }
    default:
      return sanitizedText(`Use ${toolName}`, MAX_AGENT_TOOL_ACTIVITY_LABEL_CHARS);
  }
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function safeExitCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function arrayCount(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function completedStatus(rawResult: unknown, result: StructuredRecord | undefined): 'succeeded' | 'failed' {
  if (result?.ok === false) return 'failed';
  if (result?.ok === true) return 'succeeded';
  const prefix = asString(rawResult).slice(0, 512);
  const hint = /^\s*\{\s*"ok"\s*:\s*(true|false)\b/u.exec(prefix)?.[1];
  return hint === 'true' ? 'succeeded' : 'failed';
}

function completedSummary(
  toolName: string,
  kind: AgentToolActivityKind,
  result: StructuredRecord | undefined,
  status: 'succeeded' | 'failed',
): string | undefined {
  if (!result || status === 'failed') return undefined;
  const parts: string[] = [];
  const exitCode = safeExitCode(result.exitCode);
  if (kind === 'terminal' && exitCode !== undefined) parts.push(`Exit code ${exitCode}`);

  if (kind === 'workspace') {
    const additions = safeCount(result.additions);
    const deletions = safeCount(result.deletions);
    if (additions !== undefined || deletions !== undefined) {
      parts.push(`+${additions ?? 0}/-${deletions ?? 0}`);
    } else if (toolName === 'workspace_search' || toolName === 'file_search') {
      const matches = arrayCount(result.matches);
      const files = safeCount(result.filesScanned);
      if (matches !== undefined) parts.push(`${matches} matches`);
      if (files !== undefined) parts.push(`${files} files`);
    } else if (toolName === 'workspace_glob' || toolName === 'file_glob') {
      const paths = arrayCount(result.paths);
      if (paths !== undefined) parts.push(`${paths} paths`);
    } else if (toolName === 'workspace_list' || toolName === 'file_list') {
      const entries = arrayCount(result.entries);
      if (entries !== undefined) parts.push(`${entries} entries`);
    } else {
      const count = safeCount(result.count);
      if (count !== undefined) parts.push(`${count} items`);
    }
  } else if (kind === 'other') {
    const count = safeCount(result.count);
    if (count !== undefined) parts.push(`${count} items`);
    if (exitCode !== undefined) parts.push(`Exit code ${exitCode}`);
  }

  const summary = sanitizedText(parts.join(' · '), MAX_AGENT_TOOL_ACTIVITY_SUMMARY_CHARS);
  return summary || undefined;
}

function startedActivity(call: AgentToolCall, timestamp: string, turnId?: string): AgentToolActivity {
  const toolName = safeToolName(call);
  return {
    id: safeIdentifier(call),
    toolName,
    kind: activityKind(toolName),
    label: activityLabel(call, toolName),
    status: 'running',
    startedAt: timestamp,
    ...(turnId ? { turnId } : {}),
  };
}

export function limitAgentToolActivities(
  activities: readonly AgentToolActivity[],
  maxActivities = MAX_AGENT_TOOL_ACTIVITIES,
): AgentToolActivity[] {
  const limit = Number.isSafeInteger(maxActivities)
    ? Math.max(0, maxActivities)
    : MAX_AGENT_TOOL_ACTIVITIES;
  return limit === 0 ? [] : activities.slice(-limit);
}

export function reduceAgentToolActivities(
  activities: readonly AgentToolActivity[],
  event: AgentBackendEvent,
  timestamp: string,
  turnId?: string,
): AgentToolActivity[] {
  if (
    (event.type !== 'tool_started' && event.type !== 'tool_completed')
    || !event.toolCall
  ) return limitAgentToolActivities(activities);

  const id = safeIdentifier(event.toolCall);
  if (event.type === 'tool_started') {
    return limitAgentToolActivities([
      ...activities.filter((activity) => activity.id !== id),
      startedActivity(event.toolCall, timestamp, turnId),
    ]);
  }

  const existing = activities.find((activity) => activity.id === id)
    ?? startedActivity(event.toolCall, timestamp, turnId);
  const result = parseBoundedRecord(event.result);
  const status = completedStatus(event.result, result);
  const summary = completedSummary(existing.toolName, existing.kind, result, status);
  const completed: AgentToolActivity = {
    ...existing,
    status,
    finishedAt: timestamp,
    ...(summary ? { summary } : {}),
  };
  const replaced = activities.some((activity) => activity.id === id)
    ? activities.map((activity) => activity.id === id ? completed : activity)
    : [...activities, completed];
  return limitAgentToolActivities(replaced);
}

/** Singular alias retained for call sites that treat one loop event as one reduction. */
export const reduceAgentToolActivity = reduceAgentToolActivities;

export function settleRunningToolActivities(
  activities: readonly AgentToolActivity[],
  status: Extract<AgentToolActivityStatus, 'failed' | 'cancelled'>,
  timestamp: string,
): AgentToolActivity[] {
  return limitAgentToolActivities(activities.map((activity) => (
    activity.status === 'running'
      ? { ...activity, status, finishedAt: timestamp }
      : activity
  )));
}
