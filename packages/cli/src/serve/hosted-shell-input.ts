/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function hostedShellInputError(
  toolName: unknown,
  input: unknown,
): string | undefined {
  if (toolName !== 'run_shell_command' || !input || typeof input !== 'object')
    return undefined;
  const args = input as Record<string, unknown>;
  for (const field of ['command', 'description']) {
    const value = args[field];
    if (typeof value === 'string' && /[\uD800-\uDFFF]/u.test(value))
      return (
        'Hosted Shell ' +
        field +
        ' contains an unpaired UTF-16 surrogate. Provide valid Unicode and retry.'
      );
  }
  return undefined;
}
