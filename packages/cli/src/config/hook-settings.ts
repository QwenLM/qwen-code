/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface HookSettingsForConfig {
  userHooks?: Record<string, unknown>;
  projectHooks?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
}

/**
 * Resolves the hook fields handed to `Config`, shared by startup
 * (`loadCliConfig`) and the `/hooks` reload so both apply the same rules:
 * bare and safe mode load no hooks; user hooks fall back to the merged
 * `hooks` setting when no separated user hooks were supplied.
 *
 * @param mergedHooks The merged `hooks` setting.
 * @param separated User and project hooks read per scope. Project hooks are
 *   expected to be withheld already when the folder is untrusted.
 * @param hooksDisabled True in bare or safe mode.
 */
export function resolveHookSettingsForConfig(
  mergedHooks: Record<string, unknown> | undefined,
  separated:
    | {
        userHooks?: Record<string, unknown>;
        projectHooks?: Record<string, unknown>;
      }
    | undefined,
  hooksDisabled: boolean,
): HookSettingsForConfig {
  if (hooksDisabled) {
    return { userHooks: undefined, projectHooks: undefined, hooks: undefined };
  }
  return {
    userHooks: separated?.userHooks ?? mergedHooks,
    projectHooks: separated?.projectHooks,
    hooks: mergedHooks,
  };
}
