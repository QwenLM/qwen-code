/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Option } from '@commander-js/extra-typings';

/**
 * Scope values accepted on the `skills` command line.
 *
 * `project` is an accepted alias of `workspace` so the repository-level scope
 * can be spelled the same way as in the `plugins` and `mcp` commands, which
 * both use `project`. `workspace` stays supported for backward compatibility.
 */
export const SKILL_SCOPE_CHOICES = ['user', 'workspace', 'project'] as const;

/** Raw scope value as parsed from the command line. */
export type SkillScopeInput = (typeof SKILL_SCOPE_CHOICES)[number];

/** Scope value used by the skill install/link/uninstall/settings helpers. */
export type SkillScope = 'user' | 'workspace';

/** Maps a command-line scope value onto the internal scope value. */
export function normalizeSkillScope(scope?: string): SkillScope {
  return scope === 'workspace' || scope === 'project' ? 'workspace' : 'user';
}

/**
 * Builds the shared `-s, --scope` option so every `skills` subcommand exposes
 * the same short flag and the same set of accepted values.
 */
export function createSkillScopeOption(
  description: string,
  defaultScope: SkillScopeInput = 'user',
) {
  return new Option('-s, --scope <scope>', description)
    .choices(SKILL_SCOPE_CHOICES)
    .default(defaultScope);
}
