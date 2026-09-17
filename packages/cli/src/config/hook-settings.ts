/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface HookSettingsForConfig {
  systemHooks?: Record<string, unknown>;
  userHooks?: Record<string, unknown>;
  projectHooks?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
}

/**
 * Resolves the hook fields handed to `Config`, shared by startup
 * (`loadCliConfig`) and the `/hooks` reload so both apply the same rules:
 * bare and safe mode load no hooks; hooks read per scope are passed through
 * exactly as read; the merged `hooks` setting is used only when no per-scope
 * hooks were supplied at all.
 *
 * @param mergedHooks The merged `hooks` setting.
 * @param separated System, user and project hooks read per scope. Project
 *   hooks are expected to be withheld already when the folder is untrusted.
 * @param hooksDisabled True in bare or safe mode.
 */
export function resolveHookSettingsForConfig(
  mergedHooks: Record<string, unknown> | undefined,
  separated:
    | {
        systemHooks?: Record<string, unknown>;
        userHooks?: Record<string, unknown>;
        projectHooks?: Record<string, unknown>;
      }
    | undefined,
  hooksDisabled: boolean,
): HookSettingsForConfig {
  if (hooksDisabled) {
    return {
      systemHooks: undefined,
      userHooks: undefined,
      projectHooks: undefined,
      hooks: undefined,
    };
  }
  // The merged `hooks` is a fallback for callers that cannot separate scopes
  // at all. A caller that passed per-scope data gets exactly what it passed:
  // falling back per field loaded system hooks under the wrong source (or not
  // at all) and registered every settings hook once under each source.
  if (!separated) {
    return { hooks: mergedHooks };
  }
  return {
    systemHooks: separated.systemHooks,
    userHooks: separated.userHooks,
    projectHooks: separated.projectHooks,
    hooks: undefined,
  };
}
