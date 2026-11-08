/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PolicyScope } from '@qwen-code/qwen-code-core';
import { isDeepStrictEqual } from 'node:util';
import { SettingScope, type LoadedSettings } from '../config/settings.js';

/**
 * Which scope produced the merged `agents.crossSessionInbound` value.
 *
 * Only the wording of a hold cause depends on this: the gate reads the
 * merged value and decides from that alone. The scopes are checked in
 * the order the merge lets them win — System overrides everything, a
 * workspace value survives only when it is stricter than the operator
 * values, and the user value stands otherwise — so the answer is the scope
 * whose value is the one in force, not merely a scope that mentions the key.
 * SystemDefaults is reported as `system`: it is operator-provided too.
 */
export function inboundPolicyScope(
  settings: LoadedSettings,
): PolicyScope | undefined {
  const merged = settings.merged.agents?.crossSessionInbound;
  if (merged === undefined) return undefined;
  const valueIn = (scope: SettingScope): unknown =>
    settings.forScope(scope).settings.agents?.crossSessionInbound;

  if (valueIn(SettingScope.System) !== undefined) return 'system';
  const user = valueIn(SettingScope.User);
  const systemDefaults = valueIn(SettingScope.SystemDefaults);
  const workspace = valueIn(SettingScope.Workspace);

  if (isDeepStrictEqual(user, merged)) return 'user';
  if (isDeepStrictEqual(systemDefaults, merged)) return 'system';
  if (
    settings.isTrusted &&
    settings.workspaceSettingsActive &&
    isDeepStrictEqual(workspace, merged)
  ) {
    return 'workspace';
  }
  if (user !== undefined) return 'user';
  if (systemDefaults !== undefined) return 'system';
  return undefined;
}
