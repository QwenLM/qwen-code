/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Patterns that match secret/credential values in strings.
 * Each entry: [regex, replacement placeholder].
 */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // API keys: sk-ant-*, sk-*, key-*
  [/\b(sk-ant-[a-zA-Z0-9]{6})[a-zA-Z0-9-]+/g, '$1***REDACTED***'],
  [/\b(sk-[a-zA-Z0-9]{4})[a-zA-Z0-9-]+/g, '$1***REDACTED***'],
  [/\b(key-[a-zA-Z0-9]{4})[a-zA-Z0-9-]+/g, '$1***REDACTED***'],
  // Bearer tokens in header-like strings
  [/(Bearer\s+)[a-zA-Z0-9_\-.~+/]+=*/gi, '$1***REDACTED***'],
  // Authorization header values (Basic, token, etc.)
  [/(Authorization:\s*)\S+/gi, '$1***REDACTED***'],
  // password= or passwd= or secret= in query strings or configs
  [
    /((?:password|passwd|secret|token|api_key|apikey|access_token|refresh_token)[\s]*[=:]\s*)[^\s&"',;]+/gi,
    '$1***REDACTED***',
  ],
  // AWS-style keys
  [/\b(AKIA[A-Z0-9]{12})[A-Z0-9]+/g, '$1***REDACTED***'],
  // Private key blocks
  [
    /(-----BEGIN\s+[A-Z\s]*PRIVATE KEY-----).+?(-----END\s+[A-Z\s]*PRIVATE KEY-----)/gs,
    '$1 ***REDACTED*** $2',
  ],
];

/**
 * Redact known secret patterns from a string value.
 * Returns the original string if no secrets are detected.
 */
export function redactSecrets(str: string): string {
  let result = str;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}
