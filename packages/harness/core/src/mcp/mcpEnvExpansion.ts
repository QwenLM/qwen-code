/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Expand environment variables in MCP config strings.
 * Only recognizes ${VAR} and ${VAR:-default} syntax.
 * Does NOT expand bare $VAR or Windows %VAR%.
 * Unresolved variables (no env value, no default) are left as-is.
 *
 * @param str - The string containing environment variable placeholders.
 * @param env - A record of environment variable names and their values.
 * @returns The expanded string.
 */
export function expandMcpEnvVars(
  str: string,
  env: Record<string, string | undefined>,
): string {
  if (!str) return str;
  return str.replace(VAR_PATTERN, (_: string, varContent: string) => {
    const sepIdx = varContent.indexOf(':-');
    const varName = sepIdx === -1 ? varContent : varContent.slice(0, sepIdx);
    const envValue = env[varName];
    if (envValue !== undefined) return envValue;
    if (sepIdx !== -1) return varContent.slice(sepIdx + 2);
    return '${' + varContent + '}';
  });
}
