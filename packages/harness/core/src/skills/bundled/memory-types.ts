/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../../config/config.js';
import {
  getMemoryTypesBody,
  MEMORY_TYPES_SKILL_NAME,
} from '../../memory/memory-types.js';
import type { BundledSkillRegistrar } from './index.js';

export function registerMemoryTypesSkill(
  registrar: BundledSkillRegistrar,
  config: Config,
): void {
  registrar.registerBundledSkill({
    name: MEMORY_TYPES_SKILL_NAME,
    description:
      'Type definitions and body structure for user, feedback, project, and reference memories.',
    location: 'bundled',
    body: '',
    userInvocable: false,
    disableModelInvocation: false,
    isEnabled: () => config.isAutoMemoryEnabled(),
    getBody: getMemoryTypesBody,
  });
}
