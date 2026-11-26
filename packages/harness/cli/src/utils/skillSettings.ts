/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandSettings } from '../config/createCliSettingsService.js';
import type { SettingScope } from '../config/settings.js';

import {
  type FeatureActionResult,
  type FeatureToggleStrategy,
  enableFeature,
  disableFeature,
} from './featureToggleUtils.js';

export type { ModifiedScope } from './featureToggleUtils.js';

/**
 * Metadata representing the result of a skill settings operation.
 */
export interface SkillActionResult
  extends Omit<FeatureActionResult, 'featureName'> {
  skillName: string;
}

const skillStrategy: FeatureToggleStrategy = {
  needsEnabling: (settings, scope, skillName) => {
    const scopeDisabled = settings.forScope(scope).settings.skills?.disabled;
    return !!scopeDisabled?.includes(skillName);
  },
  enable: (settings, scope, skillName) => {
    const disabled = settings.forScope(scope).settings.skills?.disabled ?? [];
    return settings.setValue(
      scope,
      'skills.disabled',
      disabled.filter((name) => name !== skillName),
    );
  },
  isExplicitlyDisabled: (settings, scope, skillName) => {
    const currentScopeDisabled =
      settings.forScope(scope).settings.skills?.disabled ?? [];
    return currentScopeDisabled.includes(skillName);
  },
  disable: (settings, scope, skillName) => {
    const disabled = settings.forScope(scope).settings.skills?.disabled ?? [];
    return settings.setValue(
      scope,
      'skills.disabled',
      disabled.includes(skillName) ? disabled : [...disabled, skillName],
    );
  },
};

/**
 * Enables a skill by removing it from the disabled list.
 * When a scope is provided, only that scope is written to.
 */
export function enableSkill(
  settings: CommandSettings,
  skillName: string,
  scope?: SettingScope,
): SkillActionResult {
  const { featureName, ...rest } = enableFeature(
    settings,
    skillName,
    skillStrategy,
    scope,
  );
  return {
    ...rest,
    skillName: featureName,
  };
}

/**
 * Disables a skill by adding it to the disabled list in the specified scope.
 */
export function disableSkill(
  settings: CommandSettings,
  skillName: string,
  scope: SettingScope,
): SkillActionResult {
  const { featureName, ...rest } = disableFeature(
    settings,
    skillName,
    scope,
    skillStrategy,
  );
  return {
    ...rest,
    skillName: featureName,
  };
}
