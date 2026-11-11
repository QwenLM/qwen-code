/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Semantic read-only validation for shell builtins.
 *
 * Callers must perform shell-structure checks before invoking this module.
 * In particular, command substitution, variable expansion, redirection, and
 * background execution must already have been rejected. This validator only
 * reasons about a parsed simple-command token list.
 */

export type BuiltinReadOnlyResult =
  | { matched: false }
  | { matched: true; readOnly: boolean };

const NUMERIC_PRINTF_ARGUMENT =
  /^[-+]?(?:0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)$/;

/**
 * Bash evaluates arguments for numeric printf conversions as arithmetic
 * expressions. Keep those arguments to numeric literals so array subscripts
 * and other expression syntax cannot create a second evaluation boundary.
 */
function validatePrintf(tokens: readonly string[]): boolean {
  const firstArgument = tokens[1];
  if (firstArgument?.startsWith('-') && firstArgument !== '--') {
    // In particular, reject bash's `printf -v name ...`, which mutates shell
    // state rather than writing only to stdout.
    return false;
  }

  const formatIndex = firstArgument === '--' ? 2 : 1;
  const format = tokens[formatIndex] ?? '';

  if (format.includes('$')) {
    return false;
  }

  const withoutEscapedPercent = format.replace(/%%/g, '');
  if (
    /%[-+ 0#']*[0-9.*]*(?:hh|ll|[lLhqjzZt])?n/.test(
      withoutEscapedPercent,
    )
  ) {
    return false;
  }

  if (
    /%[^%a-zA-Z]*(?:hh|ll|[lLhqjzZt])?\\[0-7xX]/.test(
      withoutEscapedPercent,
    ) || /\\[uU]/.test(withoutEscapedPercent)
  ) {
    return false;
  }

  const requiresNumericArguments =
    /%[-+ 0#']*[0-9.*]*(?:hh|ll|[lLhqjzZt])?[diouxXeEfFgGaA]/.test(
      withoutEscapedPercent,
    ) || /%[^%a-zA-Z]*\*/.test(withoutEscapedPercent);

  if (requiresNumericArguments) {
    return tokens
      .slice(formatIndex + 1)
      .every(
        (argument) =>
          !argument.includes('[') &&
          !argument.includes('`') &&
          !argument.includes('$(') &&
          NUMERIC_PRINTF_ARGUMENT.test(argument),
      );
  }

  return true;
}

/**
 * Validate a parsed shell builtin invocation.
 *
 * Only builtins that need argument semantics beyond the existing structured
 * command configs and narrow regex rules are handled here. `matched: false`
 * delegates every other command to those existing validators.
 */
export function validateReadOnlyBuiltin(
  tokens: readonly string[],
): BuiltinReadOnlyResult {
  const command = tokens[0];

  switch (command) {
    case 'echo':
      return { matched: true, readOnly: true };
    case 'printf':
      return { matched: true, readOnly: validatePrintf(tokens) };
    default:
      return { matched: false };
  }
}
