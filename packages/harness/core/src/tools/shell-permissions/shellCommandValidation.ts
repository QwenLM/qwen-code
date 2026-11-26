/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mature flag parser and single-command validation API.
 *
 * Extracted from the monolithic shellReadOnlyValidation.ts to provide a
 * focused, well-tested module for:
 * - Flag parsing with support for bundled flags, attached numerics, git
 *   numeric shorthands, and inline values
 * - Single-command read-only validation via allowlist + regex fallback
 */

import { parse, type ParseEntry } from 'shell-quote';
import {
  ALLOWLIST_INDEX,
  SIMPLE_READONLY_REGEXES,
} from './shellReadOnlyCommandConfigs.js';
import { validateReadOnlyBuiltin } from './shellBuiltinValidation.js';
import { containsUnquotedExpansion } from './shellStringAnalysis.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Types of flag arguments:
 * - 'none': flag takes no argument (-v, --verbose)
 * - 'number': flag takes a numeric argument (-n 5, --count=3)
 * - 'string': flag takes a string argument (--format=json)
 * - 'char': flag takes a single-character argument (-t x)
 * - '{}': flag takes a brace-delimited argument (awk -v 'x={1}')
 * - 'EOF': flag consumes everything to end-of-line (used for trailing args)
 */
export type FlagArgType = 'none' | 'number' | 'string' | 'char' | '{}' | 'EOF';

/**
 * Configuration for a read-only command in the whitelist.
 */
export interface CommandReadOnlySpec {
  /** Map of allowed flags to their argument types */
  safeFlags: Record<string, FlagArgType>;
  /**
   * Custom validation callback for complex commands.
   * Returns true if the command is DANGEROUS (should NOT be auto-allowed).
   */
  additionalIsDangerousCallback?: (
    rawCommand: string,
    args: string[],
  ) => boolean;
  /**
   * When false, the tool does NOT respect POSIX `--` end-of-options.
   * Defaults to true.
   */
  respectsDoubleDash?: boolean;
}

// ============================================================================
// Flag validation (mature parser)
// ============================================================================

/**
 * Validates that all flags in a token array are in the safe set.
 * Returns true if all flags are safe, false otherwise.
 *
 * Enhanced behaviors:
 * - `--flag=value` and `--flag value` forms
 * - `--flag=` (empty inline value) handling per type
 * - Git numeric shorthand (-5 → -n 5) when commandName starts with 'git'
 * - Attached numeric for grep/rg short flags (-A20, -B10)
 * - Bundled short flags with strict rejection if any takes args
 * - `--` stops flag parsing (when respectsDoubleDash !== false)
 * - String args starting with `-` rejected (except --sort reverse keys)
 * - All positional args allowed (path validation done separately)
 */
export function validateFlags(
  tokens: string[],
  startIndex: number,
  config: CommandReadOnlySpec,
  options?: { commandName?: string },
): boolean {
  const respectsDoubleDash = config.respectsDoubleDash !== false;
  const commandName = options?.commandName ?? '';
  let i = startIndex;

  while (i < tokens.length) {
    const token = tokens[i];

    // After -- everything is a positional (safe for read-only commands)
    if (token === '--' && respectsDoubleDash) {
      // Remaining tokens are all positionals — safe
      break;
    }

    // Long flag with = value (--flag=value or --flag=)
    if (token.startsWith('--') && token.includes('=')) {
      const eqIndex = token.indexOf('=');
      const flag = token.slice(0, eqIndex);
      const argType = config.safeFlags[flag];
      if (argType === undefined) return false; // Unknown flag
      // Value is inline — regardless of type, the value is consumed within
      // the token itself. We do NOT consume the next token.
      i++;
      continue;
    }

    // Long flag without = value
    if (token.startsWith('--')) {
      const argType = config.safeFlags[token];
      if (argType === undefined) return false; // Unknown flag
      if (argType !== 'none') {
        // Flag takes an argument - consume next token
        i++;
        if (i >= tokens.length) return false; // Missing argument
        const argValue = tokens[i];
        if (argType === 'number' && !/^-?\d+$/.test(argValue)) return false;
        // SECURITY: reject string args starting with '-' to prevent confusion
        // like `--output -o` where -o might look like another flag.
        // Exception: --sort allows reverse sort keys like `-refname`
        if (
          argType === 'string' &&
          argValue.startsWith('-') &&
          token !== '--sort'
        ) {
          return false;
        }
      }
      i++;
      continue;
    }

    // Short flag handling
    if (token.startsWith('-') && token.length > 1) {
      // Git numeric shorthand: -5 means -n 5
      // When commandName starts with 'git' and -n is in safeFlags with type 'number',
      // bare `-\d+` tokens are accepted
      if (
        commandName.startsWith('git') &&
        /^-\d+$/.test(token) &&
        config.safeFlags['-n'] === 'number'
      ) {
        i++;
        continue;
      }

      // Single short flag (exactly 2 chars, e.g., -v, -n)
      if (token.length === 2) {
        const argType = config.safeFlags[token];
        if (argType === undefined) return false;
        if (argType !== 'none') {
          // Flag takes an argument - consume next token
          i++;
          if (i >= tokens.length) return false;
          const argValue = tokens[i];
          if (argType === 'number' && !/^-?\d+$/.test(argValue)) return false;
          if (argType === 'char' && argValue.length !== 1) return false;
          // SECURITY: reject string/char args starting with '-'
          if (
            (argType === 'string' || argType === 'char') &&
            argValue.startsWith('-')
          ) {
            return false;
          }
        }
        i++;
        continue;
      }

      // Token is longer than 2 chars and starts with '-' (not '--')
      // Check for attached value: -A20, -B10, -k2,2, etc.
      const shortFlag = token.slice(0, 2);
      const remainder = token.slice(2);
      const shortFlagType = config.safeFlags[shortFlag];
      if (shortFlagType === 'number' && /^\d+$/.test(remainder)) {
        // Attached numeric value — accepted (e.g., -A20 for grep)
        i++;
        continue;
      }
      if (shortFlagType === 'string' || shortFlagType === 'char') {
        // Attached string/char value — accepted (e.g., -k2,2 for sort)
        // SECURITY: reject if attached value starts with '-' (same as separated)
        if (!remainder.startsWith('-')) {
          i++;
          continue;
        }
      }

      // Try as a registered compound flag (e.g., -vv if explicitly in safeFlags)
      if (config.safeFlags[token] !== undefined) {
        const argType = config.safeFlags[token];
        if (argType !== 'none') {
          i++;
          if (i >= tokens.length) return false;
          const argValue = tokens[i];
          if (argType === 'number' && !/^-?\d+$/.test(argValue)) return false;
        }
        i++;
        continue;
      }

      // Bundled flags: check each char individually (e.g., -la → -l -a)
      // STRICT: If ANY flag in the bundle is not 'none' type, reject the ENTIRE bundle
      let allValid = true;
      for (let j = 1; j < token.length; j++) {
        const bundledFlag = `-${token[j]}`;
        const argType = config.safeFlags[bundledFlag];
        if (argType === undefined) {
          allValid = false;
          break;
        }
        if (argType !== 'none') {
          // A flag in the bundle takes an argument → reject entire bundle
          allValid = false;
          break;
        }
      }
      if (!allValid) {
        return false;
      }
      i++;
      continue;
    }

    // Positional argument - allowed (read-only commands read paths)
    i++;
  }

  return true;
}

// ============================================================================
// Internal: Flag-parsing-based validation
// ============================================================================

/**
 * Validates a single command using the ALLOWLIST_INDEX (flag-based parsing).
 * `matched: false` delegates only commands outside this validator's domain to
 * the narrow regex fallback. Parsed builtins and indexed commands are always
 * terminal, including unsafe results.
 */
function validateCommandViaFlagParsing(command: string): {
  matched: boolean;
  readOnly?: boolean;
} {
  // Block backticks in raw command (command substitution)
  if (/`/.test(command)) return { matched: true, readOnly: false };

  // For grep/rg: reject \n or \r in command (could inject newlines)
  if (/\\[nr]/.test(command)) {
    // Only block for grep/rg commands
    const trimmed = command.trimStart();
    if (
      trimmed.startsWith('grep') ||
      trimmed.startsWith('rg') ||
      /\bgrep\b/.test(trimmed) ||
      /\brg\b/.test(trimmed)
    ) {
      return { matched: true, readOnly: false };
    }
  }

  // Parse command tokens using shell-quote
  let parsed: ParseEntry[];
  try {
    parsed = parse(command, (env) => `$${env}`);
  } catch {
    return { matched: true, readOnly: false };
  }

  // Convert non-string tokens (globs, operators) to strings
  const tokens: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'string') {
      tokens.push(entry);
    } else if (typeof entry === 'object' && entry !== null && 'op' in entry) {
      // Operators (|, >, etc.) - not a simple command → reject
      return { matched: true, readOnly: false };
    } else if (
      typeof entry === 'object' &&
      entry !== null &&
      'pattern' in entry
    ) {
      // Glob - treat as string
      tokens.push((entry as { pattern: string }).pattern);
    } else {
      return { matched: true, readOnly: false };
    }
  }

  if (tokens.length === 0) return { matched: true, readOnly: false };

  // SECURITY: Reject any argument containing a variable marker. shell-quote's
  // env callback preserves both quoted and unquoted variables as `$NAME`, so
  // this also catches expansions hidden inside quotes before builtin handling.
  for (let k = 1; k < tokens.length; k++) {
    if (tokens[k]?.includes('$')) {
      return { matched: true, readOnly: false };
    }
  }

  // Builtins need semantic validation because they do not necessarily map to
  // an external executable allowlist entry. Structural shell features have
  // already been rejected by the caller and parser at this point.
  const builtinResult = validateReadOnlyBuiltin(tokens);
  if (builtinResult.matched) {
    return builtinResult;
  }

  // Find matching command configuration using pre-built index
  let commandConfig: CommandReadOnlySpec | undefined;
  let commandTokens = 0;
  let keyTokensMatched: string[] = [];

  const candidates = ALLOWLIST_INDEX.get(tokens[0]);
  if (!candidates) return { matched: false };

  // Candidates are sorted longest-first, so first match is best (most specific)
  for (const { keyTokens, config } of candidates) {
    if (tokens.length >= keyTokens.length) {
      let matches = true;
      for (let j = 0; j < keyTokens.length; j++) {
        if (tokens[j] !== keyTokens[j]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        commandConfig = config;
        commandTokens = keyTokens.length;
        keyTokensMatched = keyTokens;
        break;
      }
    }
  }

  if (!commandConfig) return { matched: true, readOnly: false };

  // SECURITY: Reject brace expansion patterns {..,} / {..}
  for (let k = commandTokens; k < tokens.length; k++) {
    const token = tokens[k];
    if (!token) continue;
    // Reject brace expansion: {a,b} or {1..5}
    if (token.includes('{') && (token.includes(',') || token.includes('..'))) {
      return { matched: true, readOnly: false };
    }
  }

  // Validate flags
  const commandName = keyTokensMatched.join(' ');
  if (!validateFlags(tokens, commandTokens, commandConfig, { commandName })) {
    return { matched: true, readOnly: false };
  }

  // Run additional custom validation
  if (
    commandConfig.additionalIsDangerousCallback &&
    commandConfig.additionalIsDangerousCallback(
      command,
      tokens.slice(commandTokens),
    )
  ) {
    return { matched: true, readOnly: false };
  }

  return { matched: true, readOnly: true };
}

// ============================================================================
// Internal: Regex-based validation (fallback)
// ============================================================================

/**
 * Validates a single command using the SIMPLE_READONLY_REGEXES.
 */
function isCommandReadOnlyViaRegex(command: string): boolean {
  const testCommand = command.trim();

  for (const { pattern } of SIMPLE_READONLY_REGEXES) {
    if (pattern.test(testCommand)) {
      // Defense-in-depth: if a git command ever reaches the regex path
      // (currently all git commands go through ALLOWLIST_INDEX instead),
      // block dangerous git flags that enable arbitrary code execution.
      if (testCommand.includes('git')) {
        if (/\s-c[\s=]/.test(testCommand)) return false;
        if (/\s--exec-path[\s=]/.test(testCommand)) return false;
        if (/\s--config-env[\s=]/.test(testCommand)) return false;
      }
      return true;
    }
  }
  return false;
}

// ============================================================================
// Public: Single command validation
// ============================================================================

/**
 * Checks if a single command (no shell operators) is read-only.
 *
 * This function:
 * 1. Strips trailing `2>&1`
 * 2. Rejects unquoted expansion ($VAR, globs)
 * 3. Tries flag-parsing validation first (more precise)
 * 4. Falls back to regex validation for simple commands
 */
export function isSingleCommandReadOnly(command: string): boolean {
  let testCommand = command.trim();

  // Handle safe stderr-to-stdout redirection at end
  if (testCommand.endsWith(' 2>&1')) {
    testCommand = testCommand.slice(0, -5).trim();
  }

  // Reject unquoted expansion (globs, $VAR)
  if (containsUnquotedExpansion(testCommand)) {
    return false;
  }

  // Try parsed validation first. Builtins and indexed commands are terminal,
  // so an unsafe semantic decision cannot fall through to a looser regex.
  const parsedDecision = validateCommandViaFlagParsing(testCommand);
  if (parsedDecision.matched) {
    return parsedDecision.readOnly === true;
  }

  // Fall back to regex validation
  if (isCommandReadOnlyViaRegex(testCommand)) {
    return true;
  }

  return false;
}
