/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookOutput } from '@qwen-code/qwen-code-core/hooks/types.js';

function unicodeError(field: string): string {
  return (
    'Hosted Shell ' +
    field +
    ' contains an unpaired UTF-16 surrogate. Provide valid Unicode and retry.'
  );
}

export function hostedShellHookInputError(
  toolName: unknown,
  output: HookOutput | undefined,
): string | undefined {
  if (toolName !== 'run_shell_command') return undefined;
  return ['command', 'description'].some(
    (field) => output?.stopReason === unicodeError(field),
  )
    ? output?.stopReason
    : undefined;
}

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
      return unicodeError(field);
  }
  return undefined;
}
