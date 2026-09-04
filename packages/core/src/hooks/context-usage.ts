import type { ContextUsageData } from './types.js';

export function buildContextUsage(
  contextWindowSize: number | undefined,
  inputTokens: number,
): ContextUsageData | undefined {
  if (
    !contextWindowSize ||
    !Number.isFinite(contextWindowSize) ||
    contextWindowSize <= 0 ||
    !Number.isFinite(inputTokens) ||
    inputTokens <= 0
  ) {
    return undefined;
  }
  return {
    context_usage: inputTokens / contextWindowSize,
    context_limit: contextWindowSize,
    input_tokens: inputTokens,
  };
}
