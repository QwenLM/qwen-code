/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentSource } from '@qwen-code/core';
import { ConfigSource } from '@qwen-code/core';
import { SettingScope, type LoadableSettingScope } from '../config/settings.js';

/**
 * Determines the appropriate setting scope based on an agent or skill source.
 *
 * Project-sourced resources save to Project (project-level settings),
 * while all other sources (built-in, user, extension, flag) save to User
 * (global settings).
 */
export function getScopeForAgentSource(
  source: AgentSource | undefined,
): LoadableSettingScope {
  if (source === 'project') return SettingScope.Project;
  return SettingScope.User;
}

/**
 * Determines the appropriate setting scope based on a hook's ConfigSource.
 *
 * - Project hooks save to Project scope
 * - Local hooks save to Local scope
 * - All other sources (User, System, Runtime, Extensions, Flag) save to User scope
 */
export function getScopeForHookSource(
  source: ConfigSource,
): LoadableSettingScope {
  if (source === ConfigSource.Project) return SettingScope.Project;
  if (source === ConfigSource.Local) return SettingScope.Local;
  return SettingScope.User;
}
