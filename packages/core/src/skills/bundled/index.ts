/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Entry point for programmatically registered built-in skills.
 *
 * Unlike static SKILL.md files in `builtin/`, skills registered here can
 * have dynamic body generators (`getBody`) and runtime enable/disable
 * callbacks (`isEnabled`).
 *
 * Call `initBundledSkills(skillManager)` after `discoverBuiltinSkills()`
 * during initialization. Programmatic skills have the lowest precedence
 * and can be overridden by user/project skills.
 */

import type { Config } from '../../config/config.js';
import type { SkillDefinition } from '@qwen-code/resource';
import { registerSimplifySkill } from './simplify.js';
import { registerDebugSkill } from './debug.js';
import { registerQuestSkill } from './quest.js';
import { registerMemoryTypesSkill } from './memory-types.js';
import { registerRememberSkill } from './remember.js';
import { registerBatchSkill } from './batch.js';
import { registerLoopSkill } from './loop.js';
import { registerMcpConfigSkill } from './mcp-config.js';
import { registerRunSkill } from './run.js';
import { registerVerifySkill } from './verify.js';
import { registerRunSkillGeneratorSkill } from './run-skill-generator.js';
import { registerWorkflowAuthoringSkill } from './workflow-authoring.js';
import { resolveWorktreeEnabled } from '../../config/feature-flags.js';

export type BundledSkillRegistration = Omit<
  SkillDefinition,
  'skillRoot' | 'isBuiltin' | 'source'
>;

/**
 * Minimal interface for registering bundled skills into a discovery snapshot.
 */
export interface BundledSkillRegistrar {
  registerBundledSkill(definition: BundledSkillRegistration): void;
}

/**
 * Register all programmatic built-in skills.
 */
export function initBundledSkills(
  registrar: BundledSkillRegistrar,
  config?: Config,
): void {
  registerSimplifySkill(registrar);
  registerDebugSkill(registrar);
  registerQuestSkill(registrar);
  if (resolveWorktreeEnabled()) {
    registerBatchSkill(registrar);
  }
  registerMcpConfigSkill(registrar, config?.getDefaultShellToolName());
  if (config) {
    registerRememberSkill(registrar, config);
    registerMemoryTypesSkill(registrar, config);
  }
  registerLoopSkill(registrar);
  registerRunSkill(registrar, config?.getDefaultShellToolName());
  registerVerifySkill(registrar, config?.getDefaultShellToolName());
  registerRunSkillGeneratorSkill(registrar, config?.getDefaultShellToolName());
  registerWorkflowAuthoringSkill(registrar);
}
