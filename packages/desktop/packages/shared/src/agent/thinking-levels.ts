/**
 * Thinking Level Configuration
 *
 * Six-tier thinking system for extended reasoning:
 * - OFF: No extended thinking (disabled)
 * - Low: Light reasoning, faster responses
 * - Medium: Balanced speed and reasoning (default)
 * - High: Deep reasoning for complex tasks
 * - XHigh: Extra-high reasoning for agentic/coding work
 * - Max: Maximum effort reasoning
 *
 * Session-level setting with workspace defaults.
 *
 * Qwen receives these values as provider reasoning effort where supported.
 */

/**
 * Ordered list of valid thinking level IDs. Single source of truth — the
 * `ThinkingLevel` type, `THINKING_LEVELS` metadata, the Zod schema in
 * `validators.ts`, and runtime validation/error messages all derive from this.
 *
 * Order is significant: it determines UI ordering (low → max).
 */
export const THINKING_LEVEL_IDS = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ThinkingLevel = (typeof THINKING_LEVEL_IDS)[number];

export interface ThinkingLevelDefinition {
  id: ThinkingLevel;
  /** Translation key for the display name (resolve with t() at render site) */
  nameKey: string;
  /** Translation key for the description (resolve with t() at render site) */
  descriptionKey: string;
}

/**
 * Available thinking levels with display metadata.
 * Used in UI dropdowns and for validation.
 *
 * Labels use translation keys — resolve with t(level.nameKey) in components.
 */
export const THINKING_LEVELS: readonly ThinkingLevelDefinition[] = [
  { id: 'off', nameKey: 'thinking.off', descriptionKey: 'thinking.offDesc' },
  { id: 'low', nameKey: 'thinking.low', descriptionKey: 'thinking.lowDesc' },
  { id: 'medium', nameKey: 'thinking.medium', descriptionKey: 'thinking.mediumDesc' },
  { id: 'high', nameKey: 'thinking.high', descriptionKey: 'thinking.highDesc' },
  { id: 'xhigh', nameKey: 'thinking.xhigh', descriptionKey: 'thinking.xhighDesc' },
  { id: 'max', nameKey: 'thinking.max', descriptionKey: 'thinking.maxDesc' },
] as const;

/** Default thinking level for new sessions when workspace has no default */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

/**
 * Map ThinkingLevel to backend effort parameter.
 * Returns null for 'off' (thinking should be disabled entirely).
 */
export const THINKING_TO_EFFORT: Record<ThinkingLevel, 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null> = {
  off: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/**
 * Token budgets per model family.
 * Used as fallback for models that don't report thinking support.
 */
const TOKEN_BUDGETS = {
  haiku: {
    off: 0,
    low: 2_000,
    medium: 4_000,
    high: 6_000,
    xhigh: 7_000,
    max: 8_000,
  },
  default: {
    off: 0,
    low: 4_000,
    medium: 10_000,
    high: 20_000,
    xhigh: 26_000,
    max: 32_000,
  },
} as const;

/**
 * Get the thinking token budget for a given level and model.
 * Used as fallback for models that don't support adaptive thinking.
 *
 * @param level - The thinking level
 * @param modelId - The model ID (e.g., 'qwen3-coder-flash')
 * @returns Number of thinking tokens to allocate
 */
export function getThinkingTokens(level: ThinkingLevel, modelId: string): number {
  const isHaiku = modelId.toLowerCase().includes('haiku');
  const budgets = isHaiku ? TOKEN_BUDGETS.haiku : TOKEN_BUDGETS.default;
  return budgets[level];
}

/**
 * Get the translation key for a thinking level's display name.
 * Resolve with t() or i18n.t() at the call site.
 */
export function getThinkingLevelNameKey(level: ThinkingLevel): string {
  const def = THINKING_LEVELS.find((l) => l.id === level);
  return def?.nameKey ?? `thinking.${level}`;
}

/**
 * Validate that a value is a valid ThinkingLevel.
 */
export function isValidThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVEL_IDS as readonly string[]).includes(value);
}

/**
 * Normalize a persisted thinking level value, handling legacy values.
 * Maps the old 'think' value to 'medium' for backward compatibility.
 *
 * TODO: Remove the legacy 'think' compatibility path after old persisted session
 * and workspace data has realistically aged out across upgrades.
 *
 * @returns The normalized ThinkingLevel, or undefined if the value is invalid
 */
export function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === 'think') return 'medium';
  if (isValidThinkingLevel(value)) return value;
  return undefined;
}
