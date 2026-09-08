/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactUrlCredentials } from '../extension/redaction.js';

/**
 * Sanitize hook name to remove potentially sensitive information.
 * Extracts the base command name without arguments or full paths.
 *
 * This function protects PII by removing:
 * - Full file paths that may contain usernames
 * - Command arguments that may contain credentials, API keys, tokens
 * - Environment variables with sensitive values
 *
 * Examples:
 * - "/path/to/.gemini/hooks/check-secrets.sh --api-key=abc123" -> "check-secrets.sh"
 * - "python /home/user/script.py --token=xyz" -> "python"
 * - "node index.js" -> "node"
 * - "C:\\Windows\\System32\\cmd.exe /c secret.bat" -> "cmd.exe"
 * - "" or "   " -> "unknown-command"
 *
 * @param hookName Full command string.
 * @returns Sanitized command name.
 */
export function sanitizeHookName(hookName: string): string {
  // Handle empty or whitespace-only strings
  if (!hookName || !hookName.trim()) {
    return 'unknown-command';
  }

  // Split by spaces to get command parts
  const parts = hookName.trim().split(/\s+/);
  if (parts.length === 0) {
    return 'unknown-command';
  }

  // Get the first part (the command)
  const command = parts[0];
  if (!command) {
    return 'unknown-command';
  }

  // If it's a path, extract just the basename
  if (command.includes('/') || command.includes('\\')) {
    const pathParts = command.split(/[/\\]/);
    const basename = pathParts[pathParts.length - 1];
    return basename || 'unknown-command';
  }

  return command;
}

/**
 * Maximum length, in UTF-16 code units, of an error string sent to the
 * usage-statistics sink. Mirrors the OTel span-attribute bound
 * (`SPAN_TEXT_MAX_CHARS` in session-tracing.ts) so both sinks apply the
 * same definition of safe error text.
 */
export const ERROR_TEXT_MAX_CHARS = 1024;

const SECRET_KEY_PATTERN =
  '(?:password|passwd|pwd|token|secret|api[_-]?key|apikey|access[_-]?key|auth|credential|private[_-]?key|session[_-]?key)';

// `--token=xyz`, `--api-key xyz`, `X-Auth-Token: abc` — a dashed or
// hyphenated key containing a secret-like word, followed by a value.
const SECRET_FLAG_PATTERN = new RegExp(
  `(--?[a-z0-9_-]*${SECRET_KEY_PATTERN}[a-z0-9_-]*)(\\s*[=:]\\s*|\\s+)("[^"]*"|'[^']*'|[^\\s"']+)`,
  'gi',
);

// `AWS_SECRET_ACCESS_KEY=xyz`, `API_KEY=xyz`.
const SECRET_ENV_PATTERN = new RegExp(
  `\\b([A-Z0-9_]*${SECRET_KEY_PATTERN.toUpperCase()}[A-Z0-9_]*)=([^\\s"']+)`,
  'g',
);

// `Authorization: Bearer xyz` / `Authorization=xyz` — the header name alone
// is the secret-like key, so any following value (bearer prefix included)
// is masked.
const AUTHORIZATION_HEADER_PATTERN =
  /\b(authorization\s*[:=]\s*)(?:bearer\s+)?("[^"]*"|'[^']*'|[^\s"']+)/gi;

const BEARER_TOKEN_PATTERN = /\b(bearer\s+)[^\s"']+/gi;

/**
 * Redact credential-bearing shapes from error text before it leaves the
 * process via the usage-statistics (RUM) sink. Composes the URL-userinfo
 * redactor with masks for Authorization headers, bare Bearer tokens, and
 * secret-looking flag/env assignments — the shapes that appear in shell
 * command lines echoed by tool error messages. Pattern-masked rather than
 * fingerprinted: the text stays debuggable, and misses are bounded by the
 * truncation cap.
 */
export function redactErrorText(value: string): string {
  let text = redactUrlCredentials(value);
  text = text.replace(AUTHORIZATION_HEADER_PATTERN, '$1***');
  text = text.replace(BEARER_TOKEN_PATTERN, '$1***');
  text = text.replace(SECRET_FLAG_PATTERN, '$1$2***');
  text = text.replace(SECRET_ENV_PATTERN, '$1=***');
  if (text.length > ERROR_TEXT_MAX_CHARS) {
    text = `${text.slice(0, ERROR_TEXT_MAX_CHARS)}…[truncated]`;
  }
  return text;
}
