/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_FIXED_ENV_PREFIX } from '../../config/brand.js';

import { runLogger } from '../../utils/runLogger.js';
import type { CodeModeSetting } from '../../codemode/settings.js';
import { getConfigValue, subscribeConfigValue } from '../index.js';
import {
  parseBoolean,
  parseEnabledGateValue,
  parseObjectGateValue,
} from './gateParseUtils.js';

export const CODE_MODE_FEATURE_GATE = 'code_mode';
export const CODE_MODE_FEATURE_ENV = `${BRAND_FIXED_ENV_PREFIX}ENABLE_CODE_MODE`;

export interface CodeModeFeatureConfig {
  readonly enabled: boolean;
  readonly defaultMode: CodeModeSetting;
}

function resolveDefaultMode(
  remote: unknown,
  environmentEnabled: boolean | undefined,
): CodeModeSetting {
  if (remote === 'off' || remote === 'on' || remote === 'only') return remote;
  // Only an omitted remote default inherits 'on' from the environment; an invalid one stays off.
  if (remote === undefined && environmentEnabled) return 'on';
  return 'off';
}

function parseCodeModeFeatureConfig(value: unknown): CodeModeFeatureConfig {
  const record = parseObjectGateValue(value);
  // An explicit environment false also overrides an enabled remote rollout.
  const environmentEnabled = parseBoolean(process.env[CODE_MODE_FEATURE_ENV]);
  return {
    enabled:
      environmentEnabled ?? parseEnabledGateValue(record ?? value) === true,
    defaultMode: resolveDefaultMode(
      record?.['defaultMode'],
      environmentEnabled,
    ),
  };
}

/**
 * Missing or malformed remote values disable rollout unless the environment
 * overrides; never reuse another identity's value.
 */
export function getCodeModeFeatureConfig(): CodeModeFeatureConfig {
  return parseCodeModeFeatureConfig(getConfigValue(CODE_MODE_FEATURE_GATE));
}

export function registerCodeModeFeature(): void {
  subscribeConfigValue(CODE_MODE_FEATURE_GATE, (value) => {
    runLogger.log(
      '[config-service] code_mode feature gate value received',
      parseCodeModeFeatureConfig(value),
    );
  });
}
