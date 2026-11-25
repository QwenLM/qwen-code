/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingScope, LoadedSettings } from '../config/settings.js';
import {
  type FeatureActionResult,
  type FeatureToggleStrategy,
  enableFeature,
  disableFeature,
} from './featureToggleUtils.js';

/**
 * Metadata representing the result of an agent settings operation.
 */
export interface AgentActionResult
  extends Omit<FeatureActionResult, 'featureName'> {
  agentName: string;
}

const agentStrategy: FeatureToggleStrategy = {
  needsEnabling: (settings, scope, agentName) => {
    const agentOverrides = settings.forScope(scope).settings.agents?.overrides;
    return agentOverrides?.[agentName]?.enabled !== true;
  },
  enable: (settings, scope, agentName) =>
    settings.setValue(
      scope,
      ['agents', 'overrides', agentName, 'enabled'],
      true,
    ),
  isExplicitlyDisabled: (settings, scope, agentName) => {
    const agentOverrides = settings.forScope(scope).settings.agents?.overrides;
    return agentOverrides?.[agentName]?.enabled === false;
  },
  disable: (settings, scope, agentName) =>
    settings.setValue(
      scope,
      ['agents', 'overrides', agentName, 'enabled'],
      false,
    ),
};

/**
 * Enables an agent by setting `agents.overrides.<agentName>.enabled` to `true`.
 * When a scope is provided, only that scope is written to.
 */
export function enableAgent(
  settings: LoadedSettings,
  agentName: string,
  scope?: SettingScope,
): AgentActionResult {
  const { featureName, ...rest } = enableFeature(
    settings,
    agentName,
    agentStrategy,
    scope,
  );
  return {
    ...rest,
    agentName: featureName,
  };
}

/**
 * Disables an agent by setting `agents.overrides.<agentName>.enabled` to `false`
 * in the specified scope.
 */
export function disableAgent(
  settings: LoadedSettings,
  agentName: string,
  scope: SettingScope,
): AgentActionResult {
  const { featureName, ...rest } = disableFeature(
    settings,
    agentName,
    scope,
    agentStrategy,
  );
  return {
    ...rest,
    agentName: featureName,
  };
}
