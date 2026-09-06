/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser-safe subset of @qwen-code/qwen-code-core tokenLimits.
 *
 * The webview bundle (IIFE, platform: browser) cannot `require` Node.js
 * packages. This module replicates the constants and logic the webview
 * actually uses so that the core package never needs to be pulled into the
 * browser bundle.
 *
 * NOTE: the companion's LIVE context-limit path does NOT go through this
 * module — acpModelInfo.ts runs in the extension host (Node) and imports
 * `knownTokenLimit` from @qwen-code/qwen-code-core directly, so companion
 * limits already track core. This mirror exists only as a browser-safe
 * fallback for a future webview consumer; nothing imports it today. Keep it
 * in sync with packages/core/src/core/tokenLimits.ts so that consumer, when
 * it lands, sees the same numbers core reports.
 */

type TokenCount = number;

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Default input context window size: 200 K tokens. */
export const DEFAULT_TOKEN_LIMIT: TokenCount = 200_000;

// ---------------------------------------------------------------------------
// Token limit types
// ---------------------------------------------------------------------------

export type TokenLimitType = 'input' | 'output';

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const LIMITS = {
  '32k': 32_768,
  '64k': 65_536,
  '128k': 131_072,
  '192k': 196_608,
  '200k': 200_000,
  '256k': 262_144,
  '272k': 272_000,
  '384k': 384_000,
  '400k': 400_000,
  '512k': 524_288,
  '1m': 1_000_000,
  '4k': 4_096,
  '8k': 8_192,
  '16k': 16_384,
} as const;

const DEFAULT_OUTPUT_TOKEN_LIMIT: TokenCount = 32_000;

// ---------------------------------------------------------------------------
// Model name normaliser
// ---------------------------------------------------------------------------

/**
 * Robust normaliser: strips provider prefixes, pipes/colons, date/version
 * suffixes, quantisation markers, etc.
 * @param model - Raw model identifier string
 * @returns Normalised lowercase model name
 */
function normalize(model: string): string {
  let s = (model ?? '').toLowerCase().trim();

  s = s.replace(/^.*\//, '');
  s = s.split('|').pop() ?? s;
  s = s.split(':').pop() ?? s;

  s = s.replace(/\s+/g, '-');

  // Mirror core: rewrite dotted-minor Claude aliases (LiteLLM/Vertex/Bedrock
  // convention, e.g. `claude-opus-4.8`) to the canonical hyphenated form
  // BEFORE the trailing-suffix strip eats them. Runs after the whitespace
  // collapse so space-separated display names are covered, matches the family
  // as `[a-z]+`, and folds an optional hyphenated minor plus any further
  // dotted components. See packages/core/src/core/tokenLimits.ts::normalize
  // for the full rationale.
  s = s.replace(/^(claude-[a-z]+-\d+(?:-\d+)?)\.(\d+)(?:\.\d+)*/, '$1-$2');

  s = s.replace(/-preview/g, '');

  if (
    !s.match(/^qwen-(?:plus|flash|vl-max)-latest$/) &&
    !s.match(/^kimi-k2-\d{4}$/)
  ) {
    s = s.replace(
      /-(?:\d{4,}|\d+x\d+b|v\d+(?:\.\d+)*|(?<=-[^-]+-)\d+(?:\.\d+)+|latest|exp)$/g,
      '',
    );
  }

  s = s.replace(/-(?:\d?bit|int[48]|bf16|fp16|q[45]|quantized)$/g, '');
  return s;
}

// ---------------------------------------------------------------------------
// Input context-window patterns (most specific → most general)
// ---------------------------------------------------------------------------

// Mirror of core's CLAUDE_OPUS_EXTENDED: Opus tiers with the 1M input / 128K
// output window (Opus 4.6-4.8 and every 5.x). Shared across both pattern
// tables here so a tier bump touches one site, not two.
const CLAUDE_OPUS_EXTENDED = /^claude-opus-(?:4-(?:6|7|8)|5)/;

const INPUT_PATTERNS: Array<[RegExp, TokenCount]> = [
  // Google Gemini
  [/^gemini-3/, LIMITS['1m']],
  [/^gemini-/, LIMITS['1m']],

  // OpenAI
  [/^gpt-5/, LIMITS['272k']],
  [/^gpt-/, LIMITS['128k']],
  [/^o\d/, LIMITS['200k']],

  // Anthropic Claude
  [CLAUDE_OPUS_EXTENDED, LIMITS['1m']],
  [/^claude-/, LIMITS['200k']],

  // Alibaba / Qwen
  [/^qwen3-coder-plus/, LIMITS['1m']],
  [/^qwen3-coder-flash/, LIMITS['1m']],
  [/^qwen3\.\d/, LIMITS['1m']],
  [/^qwen-plus-latest$/, LIMITS['1m']],
  [/^qwen-flash-latest$/, LIMITS['1m']],
  [/^coder-model$/, LIMITS['1m']],
  [/^qwen3-max/, LIMITS['256k']],
  [/^qwen3-coder-/, LIMITS['256k']],
  [/^qwen/, LIMITS['256k']],

  // DeepSeek
  [/^deepseek-v4/, LIMITS['1m']],
  [/^deepseek/, LIMITS['128k']],

  // Zhipu GLM
  [/^glm-5(\.[01])?(-|$)/, 202_752 as TokenCount],
  [/^glm-(?:[5-9]|\d{2,})/, LIMITS['1m']],
  [/^glm-/, 202_752 as TokenCount],

  // MiniMax
  [/^minimax-m3/i, LIMITS['1m']],
  [/^minimax-m2\.5/i, LIMITS['192k']],
  [/^minimax-/i, LIMITS['200k']],

  // Moonshot / Kimi
  [/^kimi-k3/, LIMITS['1m']],
  [/^kimi-/, LIMITS['256k']],

  // ByteDance Seed-OSS
  [/^seed-oss/, LIMITS['512k']],
];

// ---------------------------------------------------------------------------
// Output token-limit patterns
// ---------------------------------------------------------------------------

const OUTPUT_PATTERNS: Array<[RegExp, TokenCount]> = [
  [/^gemini-3/, LIMITS['64k']],
  [/^gemini-/, LIMITS['8k']],

  [/^gpt-5/, LIMITS['128k']],
  [/^gpt-/, LIMITS['16k']],
  [/^o\d/, LIMITS['128k']],

  // 128_000 (vendor-declared), not LIMITS['128k'] (131_072) — matches core's
  // authoritative value so the two files can't diverge by 3072 tokens.
  [CLAUDE_OPUS_EXTENDED, 128_000 as TokenCount],
  [/^claude-sonnet-4-6/, LIMITS['64k']],
  [/^claude-/, LIMITS['64k']],

  [/^qwen3\.\d/, LIMITS['64k']],
  [/^coder-model$/, LIMITS['64k']],
  [/^qwen/, LIMITS['32k']],

  [/^deepseek-v4/, LIMITS['384k']],
  [/^deepseek-reasoner/, LIMITS['64k']],
  [/^deepseek-r1/, LIMITS['64k']],
  [/^deepseek-chat/, LIMITS['8k']],

  [/^glm-5(?:\.\d+)?(?:-|$)/, LIMITS['128k']],
  [/^glm-4\.7/, LIMITS['16k']],

  [/^minimax-m2\.5/i, LIMITS['64k']],

  [/^kimi-k3/, LIMITS['128k']],
  [/^kimi-k2\.5/, LIMITS['32k']],
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the token limit for a given model name.
 *
 * This is a browser-safe mirror of `tokenLimit()` in
 * `@qwen-code/qwen-code-core`. The webview only calls this as a fallback
 * when `modelInfo._meta.contextLimit` is unavailable.
 *
 * @param model - The model identifier string
 * @param type  - 'input' for context window, 'output' for generation limit
 * @returns Maximum token count for the model and type
 */
export function tokenLimit(
  model: string,
  type: TokenLimitType = 'input',
): TokenCount {
  const norm = normalize(model);
  const patterns = type === 'output' ? OUTPUT_PATTERNS : INPUT_PATTERNS;

  for (const [regex, limit] of patterns) {
    if (regex.test(norm)) {
      return limit;
    }
  }

  return type === 'output' ? DEFAULT_OUTPUT_TOKEN_LIMIT : DEFAULT_TOKEN_LIMIT;
}
