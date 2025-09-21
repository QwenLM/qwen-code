type Model = string;
type TokenCount = number;

export const DEFAULT_TOKEN_LIMIT: TokenCount = 131_072; // 128K (power-of-two)

/**
 * Accurate numeric limits:
 * - power-of-two approximations (128K -> 131072, 256K -> 262144, etc.)
 * - vendor-declared exact values (e.g., 200k -> 200000) are used as stated in docs.
 */
const LIMITS = {
  '32k': 32_768,
  '64k': 65_536,
  '128k': 131_072,
  '200k': 200_000, // vendor-declared decimal (OpenAI / Anthropic use 200k)
  '256k': 262_144,
  '512k': 524_288,
  '1m': 1_048_576,
  '2m': 2_097_152,
  '10m': 10_485_760, // 10 million tokens
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
  // Special handling for Qwen model names that include "-latest" as part of the model name
  if (!s.match(/^qwen-(?:plus|flash)-latest$/)) {
    // \d{6,} - Match 6 or more digits (dates) like -20250219 (6+ digit dates)
    // \d+x\d+b - Match patterns like 4x8b, -7b, -70b
    // v\d+(?:\.\d+)* - Match version patterns starting with 'v' like -v1, -v1.2, -v2.1.3
    // -\d+(?:\.\d+)+ - Match version numbers with dots (that are preceded by a dash),
    //   like -1.1, -2.0.1 but only when they're suffixes, Example: model-test-1.1 → model-test;
    //   Note: this does NOT match 4.1 in gpt-4.1 because there's no dash before 4.1 in that context.
    // latest - Match the literal string "latest"
    s = s.replace(
      /-(?:\d{6,}|\d+x\d+b|v\d+(?:\.\d+)*|-\d+(?:\.\d+)+|latest)$/g,
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
  [/^gemini-1\.5-pro$/, LIMITS['2m']],
  [/^gemini-1\.5-flash$/, LIMITS['1m']],
  [/^gemini-2\.5-pro.*$/, LIMITS['1m']],
  [/^gemini-2\.5-flash.*$/, LIMITS['1m']],
  [/^gemini-2\.0-flash-image-generation$/, LIMITS['32k']],
  [/^gemini-2\.0-flash.*$/, LIMITS['1m']],

  // -------------------
  // OpenAI (o3 / o4-mini / gpt-4.1 / gpt-4o family)
  // o3 and o4-mini document a 200,000-token context window (decimal).
  // Note: GPT-4.1 models typically report 1_048_576 (1M) context in OpenAI announcements.
  [/^o3(?:-mini|$).*$/, LIMITS['200k']],
  [/^o3.*$/, LIMITS['200k']],
  [/^o4-mini.*$/, LIMITS['200k']],
  [/^gpt-4\.1-mini.*$/, LIMITS['1m']],
  [/^gpt-4\.1.*$/, LIMITS['1m']],
  [/^gpt-4o-mini.*$/, LIMITS['128k']],
  [/^gpt-4o.*$/, LIMITS['128k']],
  [/^gpt-4.*$/, LIMITS['128k']],

  // -------------------
  // Anthropic Claude
  // - Claude Sonnet / Sonnet 3.5 and related Sonnet variants: 200,000 tokens documented.
  // - Some Sonnet/Opus models offer 1M in beta/enterprise tiers (handled separately if needed).
  [/^claude-3\.5-sonnet.*$/, LIMITS['200k']],
  [/^claude-3\.7-sonnet.*$/, LIMITS['1m']], // some Sonnet 3.7/Opus variants advertise 1M beta in docs
  [/^claude-sonnet-4.*$/, LIMITS['1m']],
  [/^claude-opus-4.*$/, LIMITS['1m']],

  // -------------------
  // Alibaba / Qwen
  // -------------------
  // Commercial Qwen3-Coder-Plus: 1M token context
  [/^qwen3-coder-plus(-.*)?$/, LIMITS['1m']], // catches "qwen3-coder-plus" and date variants

  // Commercial Qwen3-Coder-Flash: 1M token context
  [/^qwen3-coder-flash(-.*)?$/, LIMITS['1m']], // catches "qwen3-coder-flash" and date variants

  // Open-source Qwen3-Coder variants: 256K native
  [/^qwen3-coder-.*$/, LIMITS['256k']],
  // Open-source Qwen3 2507 variants: 256K native
  [/^qwen3-.*-2507-.*$/, LIMITS['256k']],

  // Open-source long-context Qwen2.5-1M
  [/^qwen2\.5-1m.*$/, LIMITS['1m']],

  // Standard Qwen2.5: 128K
  [/^qwen2\.5.*$/, LIMITS['128k']],

  // Studio commercial Qwen-Plus / Qwen-Flash / Qwen-Turbo
  [/^qwen-plus-latest$/, LIMITS['1m']], // Commercial latest: 1M
  [/^qwen-plus.*$/, LIMITS['128k']], // Standard: 128K
  [/^qwen-flash-latest$/, LIMITS['1m']],
  [/^qwen-turbo.*$/, LIMITS['128k']],

  // Qwen Vision Models
  [/^qwen-vl-max.*$/, LIMITS['128k']],

  // -------------------
  // ByteDance Seed-OSS (512K)
  // -------------------
  [/^seed-oss.*$/, LIMITS['512k']],

  // -------------------
  // Zhipu GLM
  // -------------------
  [/^glm-4\.5v.*$/, LIMITS['64k']],
  [/^glm-4\.5-air.*$/, LIMITS['128k']],
  [/^glm-4\.5.*$/, LIMITS['128k']],

  // -------------------
  // DeepSeek / GPT-OSS / Kimi / Llama & Mistral examples
  // -------------------
  [/^deepseek-r1.*$/, LIMITS['128k']],
  [/^deepseek-v3(?:\.1)?.*$/, LIMITS['128k']],
  [/^kimi-k2-instruct.*$/, LIMITS['128k']],
  [/^gpt-oss.*$/, LIMITS['128k']],
  [/^llama-4-scout.*$/, LIMITS['10m'] as unknown as TokenCount], // ultra-long variants - handle carefully
  [/^mistral-large-2.*$/, LIMITS['128k']],
];

/** Return the token limit for a model string (uses normalize + ordered regex list). */
export function tokenLimit(model: Model): TokenCount {
  const norm = normalize(model);

  for (const [regex, limit] of PATTERNS) {
    if (regex.test(norm)) {
      return limit;
    }
  }

  // final fallback: DEFAULT_TOKEN_LIMIT (power-of-two 128K)
  return DEFAULT_TOKEN_LIMIT;
}
