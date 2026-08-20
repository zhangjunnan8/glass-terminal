import type { AgentMessage } from './agent-backend';
import {
  containsObviousAgentSecret,
  redactObviousAgentSecrets,
} from '../../shared/agent-memory';

export const STRUCTURED_SUMMARY_PREFIX = '[Glass Terminal automatic context summary]\n';

export const STRUCTURED_SUMMARY_FIELDS = [
  'constraints',
  'decisions',
  'completed',
  'artifacts',
  'failures',
  'pending',
  'nextSteps',
] as const;

type StructuredSummaryListField = typeof STRUCTURED_SUMMARY_FIELDS[number];

export interface StructuredContextSummary {
  version: 1;
  goal: string;
  constraints: string[];
  decisions: string[];
  completed: string[];
  artifacts: string[];
  failures: string[];
  pending: string[];
  nextSteps: string[];
}

const MAX_GOAL_CHARS = 600;
const MAX_ITEM_CHARS = 300;
const MAX_ITEMS_PER_FIELD = 12;
const MAX_TOTAL_CHARS = 3_000;

function boundedText(value: string, maximum: number): string {
  return redactObviousAgentSecrets(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function emptySummary(): StructuredContextSummary {
  return {
    version: 1,
    goal: '',
    constraints: [],
    decisions: [],
    completed: [],
    artifacts: [],
    failures: [],
    pending: [],
    nextSteps: [],
  };
}

function extractJsonObject(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Structured context summary is not a JSON object.');
  return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
}

export function parseStructuredContextSummary(value: string): StructuredContextSummary {
  const parsed = extractJsonObject(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Structured context summary must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = new Set(['version', 'goal', ...STRUCTURED_SUMMARY_FIELDS]);
  if (
    record.version !== 1
    || typeof record.goal !== 'string'
    || Object.keys(record).some((key) => !expectedKeys.has(key))
  ) throw new Error('Structured context summary has an invalid schema.');
  if (!record.goal || record.goal.length > MAX_GOAL_CHARS) {
    throw new Error(`Structured context summary goal must contain 1-${MAX_GOAL_CHARS} characters.`);
  }
  const result = emptySummary();
  result.goal = record.goal.trim();
  for (const field of STRUCTURED_SUMMARY_FIELDS) {
    const items = record[field];
    if (
      !Array.isArray(items)
      || items.length > MAX_ITEMS_PER_FIELD
      || items.some((item) => (
        typeof item !== 'string'
        || !item.trim()
        || item.length > MAX_ITEM_CHARS
      ))
    ) throw new Error(`Structured context summary field ${field} is invalid or too large.`);
    result[field] = items.map((item) => item.trim());
  }
  const serialized = JSON.stringify(result);
  if (serialized.length > MAX_TOTAL_CHARS) {
    throw new Error('Structured context summary exceeds its total character budget.');
  }
  if (containsObviousAgentSecret(serialized)) {
    throw new Error('Structured context summary contains an apparent credential.');
  }
  return result;
}

function mergeItems(
  required: readonly string[],
  incoming: readonly string[],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...required, ...incoming]) {
    const item = boundedText(raw, MAX_ITEM_CHARS);
    const key = item.toLocaleLowerCase('en-US');
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= MAX_ITEMS_PER_FIELD) break;
  }
  return result;
}

/**
 * Durable fields from earlier summaries are always placed first. They cannot
 * disappear merely because a later free-form model summary omitted them.
 */
export function mergeStructuredContextSummaries(
  incoming: StructuredContextSummary,
  previous: readonly StructuredContextSummary[],
): StructuredContextSummary {
  const merged = emptySummary();
  const priorGoal = previous.map((summary) => summary.goal).find(Boolean) ?? '';
  merged.goal = boundedText(incoming.goal || priorGoal, MAX_GOAL_CHARS)
    || 'Continue the current Glass Terminal task using the preserved conversation state.';
  const durable = new Set<StructuredSummaryListField>([
    'constraints',
    'decisions',
    'pending',
  ]);
  for (const field of STRUCTURED_SUMMARY_FIELDS) {
    const priorItems = previous.flatMap((summary) => summary[field]);
    merged[field] = durable.has(field)
      ? mergeItems(priorItems, incoming[field])
      : mergeItems(incoming[field], priorItems);
  }
  const latestPrevious = previous.at(-1);
  const requiredCounts = {
    constraints: latestPrevious?.constraints.length ?? 0,
    decisions: latestPrevious?.decisions.length ?? 0,
    pending: latestPrevious?.pending.length ?? 0,
  };
  const removalOrder: StructuredSummaryListField[] = [
    'completed',
    'artifacts',
    'failures',
    'nextSteps',
    'constraints',
    'decisions',
    'pending',
  ];
  while (JSON.stringify(merged).length > MAX_TOTAL_CHARS) {
    const field = removalOrder.find((candidate) => {
      const required = candidate === 'constraints'
        || candidate === 'decisions'
        || candidate === 'pending'
        ? requiredCounts[candidate]
        : 0;
      return merged[candidate].length > required;
    });
    if (!field) break;
    merged[field].pop();
  }
  if (JSON.stringify(merged).length > MAX_TOTAL_CHARS) {
    merged.goal = boundedText(merged.goal, 120);
  }
  return parseStructuredContextSummary(JSON.stringify(merged));
}

export function serializeStructuredContextSummary(summary: StructuredContextSummary): string {
  return JSON.stringify(summary);
}

export function structuredSummariesFromMessages(
  messages: readonly AgentMessage[],
): StructuredContextSummary[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant' || !message.contextSummary || !message.content) return [];
    try {
      return [parseStructuredContextSummary(message.content)];
    } catch {
      return [];
    }
  });
}

function snippets(
  messages: readonly AgentMessage[],
  role: 'user' | 'assistant',
): string[] {
  return messages.flatMap((message) => {
    if (
      message.role !== role
      || !message.content
      || (message.role === 'assistant' && message.contextSummary)
    ) return [];
    const content = boundedText(message.content, MAX_ITEM_CHARS);
    return content ? [content] : [];
  });
}

/** Fixed-schema, secret-redacting fallback used when both Provider attempts fail. */
export function deterministicStructuredContextSummary(
  messages: readonly AgentMessage[],
): StructuredContextSummary {
  const previous = structuredSummariesFromMessages(messages);
  const user = snippets(messages, 'user');
  const assistant = snippets(messages, 'assistant');
  const latestUser = user.at(-1) ?? previous.at(-1)?.goal
    ?? 'Continue the current Glass Terminal task from local history.';
  const constraints = user.filter((item) => (
    /\b(?:must|never|only|do not|don't|required)\b|必须|不得|不要|只能|仅/u.test(item)
  ));
  const failures = messages.flatMap((message) => {
    if (message.role !== 'tool') return [];
    try {
      const value = JSON.parse(message.content) as Record<string, unknown>;
      if (value.ok !== false && typeof value.error !== 'string') return [];
      return [boundedText(String(value.error ?? 'A tool operation failed.'), MAX_ITEM_CHARS)];
    } catch {
      return [];
    }
  }).filter(Boolean);
  const artifacts = messages.flatMap((message) => {
    if (message.role !== 'tool') return [];
    try {
      const value = JSON.parse(message.content) as Record<string, unknown>;
      return typeof value.path === 'string'
        ? [boundedText(value.path, MAX_ITEM_CHARS)]
        : [];
    } catch {
      return [];
    }
  }).filter(Boolean);
  const fallback: StructuredContextSummary = {
    version: 1,
    goal: boundedText(latestUser, MAX_GOAL_CHARS),
    constraints: mergeItems([], constraints),
    decisions: [],
    completed: mergeItems([], assistant.slice(-6)),
    artifacts: mergeItems([], artifacts),
    failures: mergeItems([], failures),
    pending: mergeItems([], [latestUser]),
    nextSteps: mergeItems([], [latestUser]),
  };
  return mergeStructuredContextSummaries(fallback, previous);
}

export const STRUCTURED_SUMMARY_JSON_INSTRUCTION = `Return exactly one JSON object with this schema and no markdown:
{"version":1,"goal":"non-empty string","constraints":["..."],"decisions":["..."],"completed":["..."],"artifacts":["..."],"failures":["..."],"pending":["..."],"nextSteps":["..."]}
Every array contains short standalone strings. Never include passwords, API keys, passphrases, tokens, OTPs, private keys, or other credentials.`;
