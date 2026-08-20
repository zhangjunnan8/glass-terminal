export const AGENT_MEMORY_CATEGORIES = [
  'constraint',
  'decision',
  'artifact',
  'failure',
  'pending',
] as const;

export type AgentMemoryCategory = typeof AGENT_MEMORY_CATEGORIES[number];
export type AgentMemoryPinSource = 'user-message' | 'user-created';

export const MAX_AGENT_MEMORY_CARDS = 32;
export const MAX_AGENT_MEMORY_CONTENT_CHARS = 800;
export const MAX_AGENT_MEMORY_SOURCE_MESSAGES = 16;
export const MAX_AGENT_MEMORY_CONTEXT_TOKENS = 4_096;

export interface AgentMemoryCard {
  id: string;
  category: AgentMemoryCategory;
  content: string;
  sourceMessageIds: string[];
  pinSource: AgentMemoryPinSource;
  createdAt: string;
  updatedAt: string;
}

export interface SaveAgentMemoryRequest {
  terminalId: string;
  memoryId?: string;
  category: AgentMemoryCategory;
  content: string;
  sourceMessageIds?: string[];
  /** Cards merged into the saved card are removed atomically. */
  mergeMemoryIds?: string[];
}

export interface RemoveAgentMemoryRequest {
  terminalId: string;
  memoryId: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/iu,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/iu,
  /\b(?:ghp|github_pat|glpat)-[A-Za-z0-9_-]{12,}\b/iu,
  /\b(?:password|passwd|passphrase|api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|otp)\b\s*[:=]\s*["']?[^\s"']{4,}/iu,
];

export function containsObviousAgentSecret(value: string): boolean {
  const withoutRedactionMarkers = value.replace(
    /\[REDACTED(?: PRIVATE KEY| KEY| TOKEN)?\]/giu,
    '',
  );
  return SECRET_PATTERNS.some((pattern) => pattern.test(withoutRedactionMarkers));
}

export function redactObviousAgentSecrets(value: string): string {
  let redacted = value.replace(
    /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/giu,
    '[REDACTED PRIVATE KEY]',
  );
  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/giu, '[REDACTED KEY]')
    .replace(/\b(?:ghp|github_pat|glpat)-[A-Za-z0-9_-]{12,}\b/giu, '[REDACTED TOKEN]')
    .replace(
      /\b(password|passwd|passphrase|api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|otp)\b\s*[:=]\s*["']?[^\s"']{4,}/giu,
      '$1=[REDACTED]',
    );
  return redacted;
}
