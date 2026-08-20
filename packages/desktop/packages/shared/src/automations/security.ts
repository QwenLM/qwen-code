/**
 * Security Utilities for Automations
 *
 * Shell sanitization and security-related utilities.
 * Prevents command injection attacks via environment variables.
 */

/**
 * Sanitize a value for safe use in shell environment variables.
 * Escapes characters that could be used for shell injection.
 *
 * @param value - The string value to sanitize
 * @returns Sanitized string safe for shell environment variables
 *
 * @example
 * sanitizeForShell('$(rm -rf /)') // Returns '\\$(rm -rf /)'
 * sanitizeForShell('`whoami`')    // Returns '\\`whoami\\`'
 */
export function sanitizeForShell(value: string): string {
  // Escape shell metacharacters that could enable injection
  // This includes: backticks, $, \, ", ', newlines
  return value
    .replace(/\\/g, '\\\\')     // Escape backslashes first
    .replace(/`/g, '\\`')       // Escape backticks (command substitution)
    .replace(/\$/g, '\\$')      // Escape $ (variable expansion)
    .replace(/"/g, '\\"')       // Escape double quotes
    .replace(/'/g, "\\'")       // Escape single quotes
    .replace(/\n/g, '\\n')      // Escape newlines
    .replace(/\r/g, '\\r');     // Escape carriage returns
}
