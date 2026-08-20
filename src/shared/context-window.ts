export const DEFAULT_CONTEXT_WINDOW_TOKENS = 64_000;
export const MIN_CONTEXT_WINDOW_TOKENS = 8_192;
export const MAX_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** Leave output/tool-call headroom instead of waiting for a provider overflow. */
export const CONTEXT_COMPRESSION_TRIGGER_FRACTION = 0.85;

/** Recent context preserved verbatim after an automatic summary. */
export const CONTEXT_RECENT_KEEP_FRACTION = 0.1;

export function normalizedContextWindowTokens(value: unknown): number {
  return Number.isSafeInteger(value)
    && Number(value) >= MIN_CONTEXT_WINDOW_TOKENS
    && Number(value) <= MAX_CONTEXT_WINDOW_TOKENS
    ? Number(value)
    : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function contextCompressionThreshold(contextWindowTokens: number): number {
  return Math.max(1, Math.floor(
    normalizedContextWindowTokens(contextWindowTokens)
      * CONTEXT_COMPRESSION_TRIGGER_FRACTION,
  ));
}
