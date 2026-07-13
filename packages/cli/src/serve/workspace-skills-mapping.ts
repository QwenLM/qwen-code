/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SkillConfig } from '@qwen-code/qwen-code-core';
import type { ServeWorkspaceSkillStatus } from '@qwen-code/acp-bridge/status';

/**
 * Maps a `SkillConfig` (as `SkillManager.listSkills()` returns) to the
 * `/workspace/skills` wire status. Shared by the ACP child's
 * `buildWorkspaceSkillsStatus` and the daemon-local
 * `workspace-skills-status` provider so the two skill listings can never
 * drift in shape.
 */
export function mapSkillConfigToStatus(
  skill: SkillConfig,
  disabledSkillNames: ReadonlySet<string> = new Set(),
  opts: { disabled?: boolean } = {},
): ServeWorkspaceSkillStatus {
  const userDisabled = disabledSkillNames.has(skill.name.toLowerCase());
  const modelInvocable = skill.disableModelInvocation !== true;
  return {
    kind: 'skill',
    status: opts.disabled || userDisabled ? 'disabled' : 'ok',
    name: skill.name,
    description: skill.description,
    level: skill.level,
    modelInvocable,
    installedPath: skill.filePath,
    ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    ...(skill.model ? { model: skill.model } : {}),
    ...(skill.extensionName ? { extensionName: skill.extensionName } : {}),
  };
}
