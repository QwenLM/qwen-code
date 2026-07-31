/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Environment variable interpolation utilities for HTTP hooks.
 * Provides secure interpolation with whitelist-based access control.
 */

/**
 * Strip CR, LF, and NUL bytes from a header value to prevent HTTP header
 * injection (CRLF injection) via env var values or hook-configured header
 * templates. A malicious env var like "token\r\nX-Evil: 1" would otherwise
 * inject a second header into the request.
 *
 * Aligned with Claude Code's sanitizeHeaderValue behavior.
 */
export function sanitizeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\x00]/g, '');
}

/**
 * Interpolate environment variables in a string value.
 * Only variables in the allowedVars list will be replaced.
 * Variables not in the whitelist will be replaced with empty string.
 *
 * Supports both $VAR_NAME and ${VAR_NAME} syntax.
 *
 * @param value - The string containing environment variable references
 * @param allowedVars - List of allowed environment variable names
 * @returns The interpolated string (sanitized to prevent header injection)
 */
/**
 * Dangerous variable names that could be used for prototype pollution attacks
 */
const DANGEROUS_VAR_NAMES = [
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
];

/**
 * Check if a variable name is safe (not a prototype pollution vector)
 */
function isSafeVarName(varName: string): boolean {
  return !DANGEROUS_VAR_NAMES.includes(varName);
}

export function interpolateEnvVars(
  value: string,
  allowedVars: string[],
): string {
  // Match $VAR_NAME or ${VAR_NAME}
  const interpolated = value.replace(
    /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
    (match, varName: string) => {
      // Block dangerous variable names to prevent prototype pollution
      if (!isSafeVarName(varName)) {
        return '';
      }
      if (allowedVars.includes(varName)) {
        return process.env[varName] || '';
      }
      // Not in whitelist, replace with empty string for security
      return '';
    },
  );
  // Sanitize to prevent CRLF/NUL header injection
  return sanitizeHeaderValue(interpolated);
}

/**
 * Interpolate environment variables in all header values.
 *
 * @param headers - Record of header name to value
 * @param allowedVars - List of allowed environment variable names
 * @returns New headers record with interpolated values
 */
export function interpolateHeaders(
  headers: Record<string, string>,
  allowedVars: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = interpolateEnvVars(value, allowedVars);
  }
  return result;
}

/**
 * Interpolate environment variables in a URL.
 *
 * @param url - The URL string containing environment variable references
 * @param allowedVars - List of allowed environment variable names
 * @returns The interpolated URL
 */
export function interpolateUrl(url: string, allowedVars: string[]): string {
  return interpolateEnvVars(url, allowedVars);
}

/**
 * Check if a string contains environment variable references.
 *
 * @param value - The string to check
 * @returns True if the string contains env var references
 */
export function hasEnvVarReferences(value: string): boolean {
  return /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(value);
}

/**
 * Extract all environment variable names referenced in a string.
 *
 * @param value - The string to extract from
 * @returns Array of environment variable names
 */
export function extractEnvVarNames(value: string): string[] {
  const matches = value.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g);
  const names: string[] = [];
  for (const match of matches) {
    if (match[1] && !names.includes(match[1])) {
      names.push(match[1]);
    }
  }
  return names;
}
