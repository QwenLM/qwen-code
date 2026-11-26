/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type {
  SkillHookContext,
  SkillActivationSource,
} from '../hooks/types.js';
import { normalizePluginMarketplaceMetadata } from '@qwen-code/resource';
import { isWorkflowSkill } from '../workflows/workflow-skills.js';

/** 从实际生效的 Skill 定义取得归属，不信任调用参数携带的插件信息。 */
export function buildSkillHookContext(
  config: Config,
  input: Record<string, unknown>,
  source: SkillActivationSource,
  requestedName?: string,
): SkillHookContext {
  const name = typeof input['skill'] === 'string' ? input['skill'] : '';
  const result: SkillHookContext = {
    requested_skill_name: requestedName ?? name,
    activation_source: source,
    plugin: normalizePluginMarketplaceMetadata(),
  };
  const skill = config.getSkillManager?.()?.getSkill(name);
  if (!skill) return result;

  const workflow = isWorkflowSkill(skill) ? skill.workflow : undefined;
  result.skill_name = skill.name;
  result.skill_type = workflow ? 'workflow' : 'normal';
  result.skill_source =
    skill.source ?? (skill.isBuiltin ? 'built-in' : undefined);
  result.skill_location = skill.location;
  if (result.skill_source === 'plugin') {
    result.plugin = normalizePluginMarketplaceMetadata(skill.plugin);
  }
  return result;
}
