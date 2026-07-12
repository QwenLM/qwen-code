type Model = string;
type TokenCount = number;

/**
 * Token limit types for different use cases.
 * - 'input': Maximum input context window size
 * - 'output': Maximum output tokens that can be generated in a single response
 */
export type TokenLimitType = 'input' | 'output';

export const DEFAULT_TOKEN_LIMIT: TokenCount = 200_000; // 200K tokens
export const DEFAULT_OUTPUT_TOKEN_LIMIT: TokenCount = 32_000; // 32K tokens

export const ESCALATED_MAX_TOKENS: TokenCount = 64_000;

/**
 * Ceiling on the auto (non-user-configured) output request. Models
 * advertising output limits above this are clipped down; users who
 * genuinely need more set max_tokens explicitly (respected up to the
 * model's real limit). Same value as the MAX_TOKENS escalation target —
 * escalation-on-truncation raises the request up to this ceiling, never
 * past it.
 */
export const OUTPUT_TOKEN_CEILING: TokenCount = ESCALATED_MAX_TOKENS;

/**
 * Floor applied to the window ROOM when clamping an output request: when the
 * prompt has (nearly) filled the window, still ask for at least this much
 * rather than max_tokens <= 0 — compaction/hard-rescue owns that regime. An
 * explicit user ceiling below this floor is still respected (the floor
 * bounds the room, not the ceiling). Must stay below ~5K so that
 * `margin + MIN_CLAMPED_OUTPUT_TOKENS` fits inside the headroom compaction
 * leaves free (15% of a 100K window); see the window-clamp design doc.
 */
export const MIN_CLAMPED_OUTPUT_TOKENS: TokenCount = 4_000;

/**
 * Safety headroom subtracted from the window before sizing the output
 * request: absorbs prompt-estimation error plus system/tool/schema overhead
 * not captured by the API-reported prompt count. Deliberately conservative —
 * a generous margin only trims output in the final approach to compaction,
 * while an under-sized one reintroduces the #5950 400s.
 */
export function outputClampMargin(contextWindowSize: number): TokenCount {
  return Math.max(10_000, Math.round(0.05 * contextWindowSize));
}

/**
 * Size an output request to the room actually left in the context window:
 * `min(ceiling, window − prompt − margin)`, floored at
 * MIN_CLAMPED_OUTPUT_TOKENS. Makes `prompt + max_tokens ≤ window` an
 * invariant on every main-turn request (issue #5950 becomes structurally
 * impossible), which is what lets compaction thresholds run against the
 * full window with no output reservation.
 *
 * @param outputCeiling - Upper bound on the request: the user's explicit
 *   max_tokens when set, else `min(tokenLimit(model,'output'),
 *   OUTPUT_TOKEN_CEILING)`.
 * @param contextWindowSize - The configured context window.
 * @param promptTokens - Estimated prompt size; use the API-authoritative
 *   count where available (a fresh chars/4 estimate under-counts CJK and
 *   tool-heavy prompts, which is the one way a residual 400 could return).
 */
export function clampOutputTokensToWindow(
  outputCeiling: number,
  contextWindowSize: number,
  promptTokens: number,
): TokenCount {
  const room =
    contextWindowSize - promptTokens - outputClampMargin(contextWindowSize);
  // Floor the ROOM, then cap by the ceiling — never the other way around: an
  // explicit ceiling below MIN_CLAMPED_OUTPUT_TOKENS (e.g.
  // QWEN_CODE_MAX_OUTPUT_TOKENS=2000 on a capacity-constrained backend) must
  // be respected, not inflated to the floor.
  return Math.min(outputCeiling, Math.max(MIN_CLAMPED_OUTPUT_TOKENS, room));
}

export function parsePositiveIntegerEnvValue(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;

  return parsed;
}

/**
 * Accurate numeric limits:
 * - power-of-two approximations (128K -> 131072, 256K -> 262144, etc.)
 * - vendor-declared exact values (e.g., 200k -> 200000, 1m -> 1000000) are
 *   used as stated in docs.
 */
const LIMITS = {
  '32k': 32_768,
  '64k': 65_536,
  '128k': 131_072,
  '192k': 196_608, // MiniMax-M2.5 context window
  '200k': 200_000, // vendor-declared decimal, used by OpenAI, Anthropic, etc.
  '256k': 262_144,
  '272k': 272_000, // vendor-declared decimal, GPT-5.x input (400K total - 128K output)
  '384k': 384_000, // vendor-declared decimal, DeepSeek V4 max output
  '400k': 400_000, // vendor-declared decimal, used by OpenAI GPT-5.x
  '512k': 524_288,
  '1m': 1_000_000,
  // Output token limits (typically much smaller than input limits)
  '4k': 4_096,
  '8k': 8_192,
  '16k': 16_384,
} as const;

/** Robust normalizer: strips provider prefixes, pipes/colons, date/version suffixes, etc. */
export function normalize(model: string): string {
  let s = (model ?? '').toLowerCase().trim();

  // keep final path segment (strip provider prefixes), handle pipe/colon
  s = s.replace(/^.*\//, '');
  s = s.split('|').pop() ?? s;
  s = s.split(':').pop() ?? s;

  // collapse whitespace to single hyphen
  s = s.replace(/\s+/g, '-');

  // remove trailing build / date / revision suffixes:
  // - dates (e.g., -20250219), -v1, version numbers, 'latest', 'preview' etc.
  s = s.replace(/-preview/g, '');
  // Special handling for model names that include date/version as part of the model identifier
  // - Qwen models: qwen-plus-latest, qwen-flash-latest, qwen-vl-max-latest
  // - Kimi models: kimi-k2-0905, kimi-k2-0711, etc. (keep date for version distinction)
  if (
    !s.match(/^qwen-(?:plus|flash|vl-max)-latest$/) &&
    !s.match(/^kimi-k2-\d{4}$/)
  ) {
    // Regex breakdown:
    // -(?:...)$ - Non-capturing group for suffixes at the end of the string
    // The following patterns are matched within the group:
    //   \d{4,} - Match 4 or more digits (dates) like -20250219 -0528 (4+ digit dates)
    //   \d+x\d+b - Match patterns like 4x8b, -7b, -70b
    //   v\d+(?:\.\d+)* - Match version patterns starting with 'v' like -v1, -v1.2, -v2.1.3
    //   (?<=-[^-]+-)\d+(?:\.\d+)+ - Match version numbers with dots that are preceded by another dash,
    //     like -1.1, -2.0.1 but only when they are preceded by another dash, Example: model-test-1.1 → model-test;
    //     Note: this does NOT match 4.1 in gpt-4.1 because there's no dash before -4.1 in that context.
    //   latest|exp - Match the literal string "latest" or "exp"
    s = s.replace(
      /-(?:\d{4,}|\d+x\d+b|v\d+(?:\.\d+)*|(?<=-[^-]+-)\d+(?:\.\d+)+|latest|exp)$/g,
      '',
    );
  }

  // remove quantization / numeric / precision suffixes common in local/community models
  s = s.replace(/-(?:\d?bit|int[48]|bf16|fp16|q[45]|quantized)$/g, '');

  return s;
}

/** Ordered regex patterns: most specific -> most general (first match wins). */
const PATTERNS: Array<[RegExp, TokenCount]> = [
  // -------------------
  // Google Gemini
  // -------------------
  [/^gemini-3/, LIMITS['1m']], // Gemini 3.x (Pro, Flash, 3.1, etc.): 1M
  [/^gemini-/, LIMITS['1m']], // Gemini fallback (1.5, 2.x): 1M

  // -------------------
  // OpenAI
  // -------------------
  [/^gpt-5/, LIMITS['272k']], // GPT-5.x: 272K input (400K total - 128K output)
  [/^gpt-/, LIMITS['128k']], // GPT fallback (4o, 4.1, etc.): 128K
  [/^o\d/, LIMITS['200k']], // o-series (o3, o4-mini, etc.): 200K

  // -------------------
  // Anthropic Claude
  // -------------------
  [/^claude-opus-4-(?:6|7|8)/, LIMITS['1m']], // Opus 4.6-4.8: 1M
  [/^claude-/, LIMITS['200k']], // All Claude models: 200K

  // -------------------
  // Alibaba / Qwen
  // -------------------
  // Commercial API models (1,000,000 context)
  [/^qwen3-coder-plus/, LIMITS['1m']],
  [/^qwen3-coder-flash/, LIMITS['1m']],
  [/^qwen3\.\d/, LIMITS['1m']],
  [/^qwen-plus-latest$/, LIMITS['1m']],
  [/^qwen-flash-latest$/, LIMITS['1m']],
  [/^coder-model$/, LIMITS['1m']],
  // Commercial API models (256K context)
  [/^qwen3-max/, LIMITS['256k']],
  // Open-source Qwen3 variants: 256K native
  [/^qwen3-coder-/, LIMITS['256k']],
  // Qwen fallback (VL, turbo, plus, 2.5, etc.): 256K
  [/^qwen/, LIMITS['256k']],

  // -------------------
  // DeepSeek
  // -------------------
  [/^deepseek-v4/, LIMITS['1m']], // DeepSeek V4 (flash, pro): 1M
  [/^deepseek/, LIMITS['128k']],

  // -------------------
  // Zhipu GLM
  // -------------------
  // 1M context is the forward default for new GLM releases (GLM-5.2+, GLM-6.x,
  // and beyond) so they need no future code change. Confirmed 200K families
  // (GLM-5 / 5.0 / 5.1, GLM-4.x and older) are pinned explicitly first.
  [/^glm-5(\.[01])?(-|$)/, 202_752 as TokenCount], // GLM-5 / 5.0 / 5.1: 200K
  [/^glm-(?:[5-9]|\d{2,})/, LIMITS['1m']], // GLM-5.2+, 6.x..9.x, 10.x+: 1M
  [/^glm-/, 202_752 as TokenCount], // GLM <=4.x / non-numeric fallback: 200K

  // -------------------
  // MiniMax
  // -------------------
  [/^minimax-m3/i, LIMITS['1m']], // MiniMax-M3: 1,000,000
  [/^minimax-m2\.5/i, LIMITS['192k']], // MiniMax-M2.5: 196,608
  [/^minimax-/i, LIMITS['200k']], // MiniMax fallback: 200K

  // -------------------
  // Moonshot / Kimi
  // -------------------
  [/^kimi-/, LIMITS['256k']], // Kimi fallback: 256K

  // -------------------
  // ByteDance Seed-OSS (512K)
  // -------------------
  [/^seed-oss/, LIMITS['512k']],
];

/**
 * Output token limit patterns for specific model families.
 * These patterns define the maximum number of tokens that can be generated
 * in a single response for specific models.
 */
const OUTPUT_PATTERNS: Array<[RegExp, TokenCount]> = [
  // Google Gemini
  [/^gemini-3/, LIMITS['64k']], // Gemini 3.x: 64K
  [/^gemini-/, LIMITS['8k']], // Gemini fallback: 8K

  // OpenAI
  [/^gpt-5/, LIMITS['128k']], // GPT-5.x: 128K
  [/^gpt-/, LIMITS['16k']], // GPT fallback: 16K
  [/^o\d/, LIMITS['128k']], // o-series: 128K

  // Anthropic Claude
  [/^claude-opus-4-(?:6|7|8)/, 128_000 as TokenCount], // Opus 4.6-4.8: 128K
  [/^claude-sonnet-4-6/, LIMITS['64k']], // Sonnet 4.6: 64K
  [/^claude-/, LIMITS['64k']], // Claude fallback: 64K

  // Alibaba / Qwen
  [/^qwen3\.\d/, LIMITS['64k']],
  [/^coder-model$/, LIMITS['64k']],
  [/^qwen/, LIMITS['32k']], // Qwen fallback (VL, turbo, plus, etc.): 32K

  // DeepSeek
  [/^deepseek-v4/, LIMITS['384k']], // DeepSeek V4 (flash, pro): 384K
  [/^deepseek-reasoner/, LIMITS['64k']],
  [/^deepseek-r1/, LIMITS['64k']],
  [/^deepseek-chat/, LIMITS['8k']],

  // Zhipu GLM
  [/^glm-5(?:\.\d+)?(?:-|$)/, LIMITS['128k']],
  [/^glm-4\.7/, LIMITS['16k']],

  // MiniMax
  [/^minimax-m2\.5/i, LIMITS['64k']],

  // Kimi
  [/^kimi-k2\.5/, LIMITS['32k']],
];

function findTokenLimit(
  model: Model,
  type: TokenLimitType = 'input',
): TokenCount | undefined {
  const norm = normalize(model);
  const patterns = type === 'output' ? OUTPUT_PATTERNS : PATTERNS;

  for (const [regex, limit] of patterns) {
    if (regex.test(norm)) {
      return limit;
    }
  }

  return undefined;
}

/**
 * Check if a model has an explicitly defined output token limit.
 * This distinguishes between models with known limits in OUTPUT_PATTERNS
 * and unknown models that would fallback to DEFAULT_OUTPUT_TOKEN_LIMIT.
 *
 * @param model - The model name to check
 * @returns true if the model has an explicit output limit definition, false if it uses the default fallback
 */
export function hasExplicitOutputLimit(model: Model): boolean {
  const norm = normalize(model);
  return OUTPUT_PATTERNS.some(([regex]) => regex.test(norm));
}

export function knownTokenLimit(
  model: Model,
  type: TokenLimitType = 'input',
): TokenCount | undefined {
  return findTokenLimit(model, type);
}

/**
 * Return the token limit for a model string based on the specified type.
 *
 * This function determines the maximum number of tokens for either input context
 * or output generation based on the model and token type. It uses the same
 * normalization logic for consistency across both input and output limits.
 *
 * This function is primarily used during config initialization to auto-detect
 * token limits. After initialization, code should use contentGeneratorConfig.contextWindowSize
 * or contentGeneratorConfig.maxOutputTokens directly.
 *
 * @param model - The model name to get the token limit for
 * @param type - The type of token limit ('input' for context window, 'output' for generation)
 * @returns The maximum number of tokens allowed for this model and type
 */
export function tokenLimit(
  model: Model,
  type: TokenLimitType = 'input',
): TokenCount {
  return (
    knownTokenLimit(model, type) ??
    (type === 'output' ? DEFAULT_OUTPUT_TOKEN_LIMIT : DEFAULT_TOKEN_LIMIT)
  );
}

/**
 * The default (non-user-configured) output request for a model: its
 * advertised output limit, clipped to OUTPUT_TOKEN_CEILING. This is the one
 * place that policy lives — the send path and both provider layers call it
 * so a model advertising >64K output is clamped consistently everywhere.
 */
export function defaultOutputCeiling(model: Model): TokenCount {
  const outputLimit = tokenLimit(model, 'output');
  if (/^claude-opus-4-(?:6|7|8)/.test(normalize(model))) {
    return outputLimit;
  }
  return Math.min(outputLimit, OUTPUT_TOKEN_CEILING);
}

/**
 * Reconcile a user-configured `max_tokens` (from samplingParams) with the
 * send path's window-clamped request value: the smaller wins, so a user's
 * explicit ceiling is honored while never overriding the window clamp
 * upward. Returns undefined when the two can't be reconciled (either side
 * absent), leaving each provider to apply its own fallback — the shared
 * invariant ("user max_tokens is a ceiling, not an escape hatch") stays in
 * one place so a new provider can't silently reopen it.
 */
export function reconcileMaxTokens(
  configMaxTokens: number | null | undefined,
  requestMaxTokens: number | null | undefined,
): number | undefined {
  if (
    typeof configMaxTokens === 'number' &&
    typeof requestMaxTokens === 'number'
  ) {
    return Math.min(configMaxTokens, requestMaxTokens);
  }
  return undefined;
}
