/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Default allowlist for outbound correlation headers
 * (`X-Qwen-Code-Session-Id`). Limited to Alibaba/DashScope endpoints where
 * the LLM provider, the upstream telemetry backend (ARMS Tracing), and
 * the qwen-code distribution are the same legal entity — so the session
 * id stays a first-party, in-vendor correlation handle.
 *
 * Why a default scope (rather than broadcasting to every LLM provider):
 * PR #4390 review (LaZzyMan) pointed out that an open-source CLI sending
 * a stable cross-request identifier to arbitrary third-party providers
 * (OpenAI, Anthropic, OpenRouter, ...) is a cross-vendor fingerprinting
 * surface those providers don't need for the API call itself. Restricting
 * the default to in-vendor destinations mirrors the claude-code pattern
 * (first-party client → first-party backend), preserves the real product
 * value (ARMS server-side trace stitching against DashScope), and makes
 * the third-party-broadcast failure mode opt-in rather than default.
 *
 * Mirrors `DashScopeOpenAICompatibleProvider.isDashScopeProvider` so the
 * two layers stay aligned. If you add a hostname there, add it here too.
 *
 * Pattern syntax (matches `matchesTrustedHost` below):
 * - bare hostname → exact match (case-insensitive)
 * - `*.suffix`    → matches `suffix` itself AND any sub-domain of it
 *                   (e.g. `*.alibaba-inc.com` matches `alibaba-inc.com`
 *                   and `gw.alibaba-inc.com`)
 */
export const DEFAULT_SESSION_ID_HEADER_HOSTS: readonly string[] = [
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
  '*.dashscope.aliyuncs.com',
  '*.dashscope-intl.aliyuncs.com',
  '*.alibaba-inc.com',
  '*.aliyun-inc.com',
];

/**
 * Check whether `hostname` matches any pattern in `patterns`.
 * Case-insensitive. Empty `hostname` always returns false.
 *
 * `*.suffix` patterns match:
 *   - the suffix domain itself (`alibaba-inc.com` matches `*.alibaba-inc.com`)
 *   - any sub-domain (`gw.alibaba-inc.com` matches `*.alibaba-inc.com`)
 *
 * This is intentionally a tiny pure helper, not a generic glob. Anything
 * more elaborate (regex, port-aware, scheme-aware) should be added at the
 * call site, not here, so the allowlist semantics stay obvious from the
 * pattern strings users put in settings.
 */
export function matchesTrustedHost(
  hostname: string,
  patterns: readonly string[],
): boolean {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  for (const raw of patterns) {
    const p = raw.toLowerCase();
    if (p.startsWith('*.')) {
      const bare = p.slice(2);
      if (h === bare || h.endsWith('.' + bare)) return true;
    } else if (h === p) {
      return true;
    }
  }
  return false;
}

/**
 * Extract the destination hostname from a fetch input. Returns `undefined`
 * if the URL can't be parsed — caller should treat that as "not on the
 * allowlist" (fail closed).
 */
export function extractRequestHost(
  input: string | URL | Request,
): string | undefined {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input instanceof Request) return new URL(input.url).hostname;
  } catch {
    return undefined;
  }
  return undefined;
}
