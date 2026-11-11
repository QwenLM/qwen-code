/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parse as shellQuoteParse } from 'shell-quote';
import type { SkillDefinition } from '@qwen-code/resource';
import {
  ENV_SKILL_DIR,
  ENV_SKILL_SESSION_ID,
  ENV_SKILL_CONFIG_DIR,
  ENV_SKILL_USER_CONFIG_DIR,
} from '../config/brand.js';
import {
  CONFIG_DIR,
  GLOBAL_CONFIG_DIR,
  getUserConfigDisplayPath,
} from './paths.js';
import { substitutePluginVariables } from '../plugins/configuration/pluginOptionsStorage.js';

/**
 * Parse an arguments string into an array of individual arguments.
 * Uses shell-quote for proper shell argument parsing including quoted strings.
 *
 * Examples:
 * - "foo bar baz" => ["foo", "bar", "baz"]
 * - 'foo "hello world" baz' => ["foo", "hello world", "baz"]
 * - "foo 'hello world' baz" => ["foo", "hello world", "baz"]
 */
export function parseArguments(args: string): string[] {
  if (!args || !args.trim()) {
    return [];
  }

  try {
    // Return $KEY to preserve variable syntax literally (don't expand variables)
    const tokens = shellQuoteParse(args, (key) => `$${key}`);

    // Filter to only string tokens (ignore shell operators, etc.)
    return tokens.filter((token): token is string => typeof token === 'string');
  } catch {
    // Fall back to simple whitespace split if parsing fails
    return args.split(/\s+/).filter(Boolean);
  }
}

/**
 * Parse argument names from the frontmatter 'arguments' field.
 * Accepts either a space-separated string or an array of strings.
 *
 * Examples:
 * - "foo bar baz" => ["foo", "bar", "baz"]
 * - ["foo", "bar", "baz"] => ["foo", "bar", "baz"]
 */
export function parseArgumentNames(
  argumentNames: string | string[] | undefined,
): string[] {
  if (!argumentNames) {
    return [];
  }

  // Filter out empty strings and numeric-only names (which conflict with $0, $1 shorthand)
  const isValidName = (name: string): boolean =>
    typeof name === 'string' && name.trim() !== '' && !/^\d+$/.test(name);

  if (Array.isArray(argumentNames)) {
    return argumentNames.filter(isValidName);
  }
  if (typeof argumentNames === 'string') {
    return argumentNames.split(/\s+/).filter(isValidName);
  }
  return [];
}

/**
 * Generate argument hint showing remaining unfilled args.
 * @param argNames - Array of argument names from frontmatter
 * @param typedArgs - Arguments the user has typed so far
 * @returns Hint string like "[arg2] [arg3]" or undefined if all filled
 */
export function generateProgressiveArgumentHint(
  argNames: string[],
  typedArgs: string[],
): string | undefined {
  const remaining = argNames.slice(typedArgs.length);
  if (remaining.length === 0) return undefined;
  return remaining.map((name) => `[${name}]`).join(' ');
}

/**
 * Substitute $ARGUMENTS placeholders in content with actual argument values.
 *
 * @param content - The content containing placeholders
 * @param args - The raw arguments string (may be undefined/null)
 * @param appendIfNoPlaceholder - If true and no placeholders are found, appends "ARGUMENTS: {args}" to content
 * @param argumentNames - Optional array of named arguments (e.g., ["foo", "bar"]) that map to indexed positions
 * @returns The content with placeholders substituted
 */
export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder = true,
  argumentNames: string[] = [],
): string {
  // undefined/null means no args provided - return content unchanged
  // empty string is a valid input that should replace placeholders with empty
  if (args === undefined || args === null) {
    return content;
  }

  const parsedArgs = parseArguments(args);
  const originalContent = content;

  // Replace named arguments (e.g., $foo, $bar) with their values
  // Named arguments map to positions: argumentNames[0] -> parsedArgs[0], etc.
  for (let i = 0; i < argumentNames.length; i++) {
    const name = argumentNames[i];
    if (!name) continue;

    // Match $name but not $name[...] or $nameXxx (word chars)
    // Also ensure we match word boundaries to avoid partial matches
    content = content.replace(
      new RegExp(`\\$${name}(?![\\[\\w])`, 'g'),
      parsedArgs[i] ?? '',
    );
  }

  // Replace indexed arguments ($ARGUMENTS[0], $ARGUMENTS[1], etc.)
  content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, indexStr: string) => {
    const index = parseInt(indexStr, 10);
    return parsedArgs[index] ?? '';
  });

  // Replace shorthand indexed arguments ($0, $1, etc.)
  content = content.replace(/\$(\d+)(?!\w)/g, (_, indexStr: string) => {
    const index = parseInt(indexStr, 10);
    return parsedArgs[index] ?? '';
  });

  // Replace $ARGUMENTS with the full arguments string
  content = content.replaceAll('$ARGUMENTS', args);

  // If no placeholders were found and appendIfNoPlaceholder is true, append
  // But only if args is non-empty (empty string means command invoked with no args)
  if (content === originalContent && appendIfNoPlaceholder && args) {
    content = content + `\n\nARGUMENTS: ${args}`;
  }

  return content;
}

/**
 * Full skill body substitution: argument placeholders + environment variables.
 *
 * Combines {@link substituteArguments} with branded skill directory, session,
 * and configuration directory placeholders. Qwen uses `${QWEN_CONFIG_DIR}` and
 * `${QWEN_USER_CONFIG_DIR}`; other builds use their configured brand prefix.
 * A complete branded user path resolves through the effective user config root
 * before the bare directory-name placeholder is replaced. Unbranded
 * `${PROJECT_CONFIG_DIR}` and `${USER_CONFIG_DIR}` remain literal.
 *
 * When `pluginPath` is provided, also substitutes plugin-only variables
 * (branded plugin root/data names plus their `${CLAUDE_*}`
 * aliases — including `${CLAUDE_SESSION_ID}`) via
 * {@link substitutePluginVariables}. The CLAUDE_-prefixed alias for the
 * session id intentionally lives in the plugin layer so non-plugin skill
 * bodies don't pick up upstream-flavoured names. Only the skill fork
 * activation path passes `pluginPath`; inline plugin commands use
 * PluginCommandLoader's lighter pipeline.
 */
export function substituteSkillBody(
  skill: Pick<SkillDefinition, 'body' | 'arguments' | 'isBuiltin'>,
  opts: {
    args?: string;
    skillDir: string;
    sessionId: string;
    pluginPath?: string;
    pluginId?: string;
  },
): string {
  const argumentNames = (skill.arguments ?? []).map((a) => a.name);
  let result = substituteArguments(skill.body, opts.args, true, argumentNames);
  result = result.replaceAll('${' + ENV_SKILL_DIR + '}', () => opts.skillDir);
  result = result.replaceAll(
    '${' + ENV_SKILL_SESSION_ID + '}',
    () => opts.sessionId,
  );
  result = result.replaceAll('~/${' + ENV_SKILL_USER_CONFIG_DIR + '}', () =>
    getUserConfigDisplayPath(),
  );
  result = result.replaceAll(
    '${' + ENV_SKILL_CONFIG_DIR + '}',
    () => CONFIG_DIR,
  );
  result = result.replaceAll(
    '${' + ENV_SKILL_USER_CONFIG_DIR + '}',
    () => GLOBAL_CONFIG_DIR,
  );
  if (opts.pluginPath) {
    result = substitutePluginVariables(result, {
      path: opts.pluginPath,
      pluginId: opts.pluginId,
      sessionId: opts.sessionId,
    });
  }
  return result;
}
