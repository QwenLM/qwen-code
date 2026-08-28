/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { BuiltinCommandLoader } from './BuiltinCommandLoader.js';
import { BundledSkillLoader } from './BundledSkillLoader.js';
import { FileCommandLoader } from './FileCommandLoader.js';
import { McpPromptLoader } from './McpPromptLoader.js';
import { SavedWorkflowLoader } from './saved-workflow-loader.js';
import { SkillCommandLoader } from './SkillCommandLoader.js';
import type { ICommandLoader } from './types.js';

/**
 * The production slash-command loader set, in the one order every aggregation
 * surface must use.
 *
 * The order is load-bearing. `CommandService.create` renames a colliding
 * command only when it carries an `extensionName`, so for commands that do not,
 * array position alone decides which one keeps the name:
 *
 * - Local skills (user, project) load before `SavedWorkflowLoader` and
 *   `FileCommandLoader`, so a user-authored command keeps its name. This is the
 *   precedence that held before #9408.
 * - Extension skills load last. They do carry an `extensionName`, so a file
 *   command claiming a qualified skill name registers first and the
 *   numeric-suffix branch fires instead of silently overriding the skill.
 *
 * The interactive, non-interactive, and ACP surfaces all build their command
 * set here. A hand-written copy at a fourth site is how these two rules drift
 * apart, which is what #9408 review round 1 flagged as R1-7.
 */
export function buildCommandLoaders(config: Config | null): ICommandLoader[] {
  return [
    new McpPromptLoader(config),
    new BuiltinCommandLoader(config),
    new BundledSkillLoader(config),
    new SkillCommandLoader(config, ['user', 'project']),
    new SavedWorkflowLoader(config),
    new FileCommandLoader(config),
    new SkillCommandLoader(config, ['extension']),
  ];
}
