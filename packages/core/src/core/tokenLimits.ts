type Model = string;
type TokenCount = number;

/**
 * Token limit types for different use cases.
 * - 'input': Maximum input context window size
 * - 'output': Maximum output tokens that can be generated in a single response
 */
export type TokenLimitType = 'input' | 'output';

export const DEFAULT_TOKEN_LIMIT: TokenCount = 131_072; // 128K (power-of-two)
export const DEFAULT_OUTPUT_TOKEN_LIMIT: TokenCount = 8_192; // 8K tokens

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
  '200k': 200_000, // vendor-declared decimal, used by OpenAI, Anthropic, etc.
  '256k': 262_144,
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
  [/^gpt-5/, LIMITS['400k']], // GPT-5.x: 400K
  [/^gpt-/, LIMITS['128k']], // GPT fallback (4o, 4.1, etc.): 128K
  [/^o\d/, LIMITS['200k']], // o-series (o3, o4-mini, etc.): 200K

  // -------------------
  // Anthropic Claude
  // -------------------
  [/^claude-/, LIMITS['200k']], // All Claude models: 200K

  // -------------------
  // Alibaba / Qwen
  // -------------------
  // Commercial API models (1,000,000 context)
  [/^qwen3-coder-plus/, LIMITS['1m']],
  [/^qwen3-coder-flash/, LIMITS['1m']],
  [/^qwen3\.5-plus/, LIMITS['1m']],
  [/^qwen-plus-latest$/, LIMITS['1m']],
  [/^qwen-flash-latest$/, LIMITS['1m']],
  [/^coder-model$/, LIMITS['1m']],
  // Commercial API models (256K context)
  [/^qwen3-max/, LIMITS['256k']],
  // Open-source Qwen3 variants: 256K native
  [/^qwen3-coder-/, LIMITS['256k']],
  // Qwen fallback (VL, turbo, plus, 2.5, etc.): 128K
  [/^qwen/, LIMITS['256k']],

  // -------------------
  // DeepSeek
  // -------------------
  [/^deepseek/, LIMITS['128k']],

  // -------------------
  // Zhipu GLM
  // -------------------
  [/^glm-5/, 202_752 as TokenCount], // GLM-5: exact vendor limit
  [/^glm-/, 202_752 as TokenCount], // GLM fallback: 128K

  // -------------------
  // MiniMax
  // -------------------
  [/^minimax-m2\.5/i, LIMITS['1m']], // MiniMax-M2.5: 1,000,000
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
  [/^claude-opus-4-6/, LIMITS['128k']], // Opus 4.6: 128K
  [/^claude-sonnet-4-6/, LIMITS['64k']], // Sonnet 4.6: 64K
  [/^claude-/, LIMITS['64k']], // Claude fallback: 64K

  // Alibaba / Qwen
  [/^qwen3\.5/, LIMITS['64k']],
  [/^coder-model$/, LIMITS['64k']],
  [/^qwen3-max/, LIMITS['64k']],

  // DeepSeek
  [/^deepseek-reasoner/, LIMITS['64k']],
  [/^deepseek-chat/, LIMITS['8k']],

  // Zhipu GLM
  [/^glm-5/, LIMITS['16k']],
  [/^glm-4\.7/, LIMITS['16k']],

  // MiniMax
  [/^minimax-m2\.5/i, LIMITS['64k']],

  // Kimi
  [/^kimi-k2\.5/, LIMITS['32k']],
];

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
  const norm = normalize(model);

  // Choose the appropriate patterns based on token type
  const patterns = type === 'output' ? OUTPUT_PATTERNS : PATTERNS;

  for (const [regex, limit] of patterns) {
    if (regex.test(norm)) {
      return limit;
    }
  }

  // Return appropriate default based on token type
  return type === 'output' ? DEFAULT_OUTPUT_TOKEN_LIMIT : DEFAULT_TOKEN_LIMIT;
}
