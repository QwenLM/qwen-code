/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `initialize` 回包的产品快照：仅采集会话自身的事实（commands、agents、skills、
 * output style、permissionMode）。模型目录与账号数据由宿主补齐，wire 投影也在宿主。
 */

import {
  DEFAULT_OUTPUT_STYLE_NAME,
  PERMISSION_MODES,
  type PermissionPolicySnapshot,
  type Config,
} from '@qwen-code/core';
import { buildSdkCommandSnapshot } from '../../../sdkCommandCatalog.js';
import type { ThreadInitializeSnapshot } from '../contract/threadSessionTypes.js';

/** Use the same effective restrictions as execution, including unavailable policy. */
export function buildSessionPermissionPolicy(
  config: Pick<Config, 'getPermissionModeRestriction'>,
): PermissionPolicySnapshot {
  const disabledModeMessages: Record<string, string> = {};
  for (const mode of PERMISSION_MODES) {
    const reason = config.getPermissionModeRestriction(mode);
    if (reason !== undefined) disabledModeMessages[mode] = reason;
  }
  return {
    disabledModes: Object.keys(disabledModeMessages),
    disabledModeMessages,
  };
}

export async function buildSessionInitializeSnapshot(
  config: Config,
  options: { includePermissionMode?: boolean } = {},
  signal?: AbortSignal,
): Promise<ThreadInitializeSnapshot> {
  const [commands, availableOutputStyles] = await Promise.all([
    buildSdkCommandSnapshot(config, signal),
    config.getAvailableOutputStyles().catch(() => ({
      [DEFAULT_OUTPUT_STYLE_NAME]: null,
    })),
  ]);

  const agentRegistry = config.getAgentRegistry?.();
  const agents =
    agentRegistry?.getAllAgentNames().map((name) => {
      const definition = agentRegistry.getDiscoveredDefinition(name);
      if (!definition) {
        return {
          name,
          description: '',
        };
      }

      const model =
        definition.kind === 'local' ? definition.modelConfig?.model : undefined;

      return {
        name,
        description: definition.description ?? '',
        ...(model && model !== 'inherit' ? { model } : {}),
      };
    }) ?? [];

  const skillManager = config.getSkillManager();
  const skills = skillManager
    .getSkills()
    .filter(
// skillOverrides='off' 与会话级 allowlist 都在这里过滤：
// 未列入 allowlist 的项目 Skill 不能进入 init.skills。
      (skill) =>
        skillManager.getSkillVisibilityOverride(skill.name) !== 'off' &&
        skillManager.isSkillAllowedForMainSession(skill.name),
    )
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      ...(skill.source ? { source: skill.source } : {}),
    }));

  return {
    commands,
    permissionPolicy: buildSessionPermissionPolicy(config),
    agents,
    skills,
    outputStyleName:
      config.getOutputStyle?.()?.name ?? DEFAULT_OUTPUT_STYLE_NAME,
    availableOutputStyleNames: Object.keys(availableOutputStyles),
    ...(options.includePermissionMode
      ? { permissionMode: config.getPermissionMode() }
      : {}),
  };
}
