/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  resolveDreamConfig,
  type Config,
} from '@qwen-code/core';
import type { SettingsValue } from '../config/settingsSchema.js';
import { getSettingDefinition } from './settingsUtils.js';

type RuntimeDefaultResolver = (config: Config) => SettingsValue;

const RUNTIME_DEFAULT_RESOLVERS = {
  autoMemoryProject: (config) =>
    config.isAutoMemoryProjectScopeEnabled(),
  autoMemoryUser: (config) => config.isAutoMemoryUserScopeEnabled(),
  autoDream: (config) => resolveDreamConfig(config).enabled,
} satisfies Record<string, RuntimeDefaultResolver>;

/**
 * Resolves a schema-declared runtime default. Returns `undefined` for ordinary
 * settings whose default is fully owned by the static settings schema.
 */
export function getRuntimeDefaultValue(
  key: string,
  config: Config,
): SettingsValue {
  const source = getSettingDefinition(key)?.runtimeDefaultSource;
  return source === undefined
    ? undefined
    : RUNTIME_DEFAULT_RESOLVERS[source](config);
}
