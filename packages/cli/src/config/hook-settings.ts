/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';

export interface HookSettingsForConfig {
  userHooks?: Record<string, unknown>;
  projectHooks?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
}

/**
 * Resolves the hook fields handed to `Config`, shared by startup
 * (`loadCliConfig`) and the `/hooks` reload so both apply the same rules:
 * bare and safe mode load no hooks. Legacy merged hooks retain system hooks
 * without assigning workspace definitions to the user scope.
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
  const fallbackUserHooks =
    mergedHooks &&
    Object.fromEntries(
      Object.entries(mergedHooks).map(([event, definitions]) => {
        const projectDefinitions = separated?.projectHooks?.[event];
        return [
          event,
          Array.isArray(definitions) && Array.isArray(projectDefinitions)
            ? definitions.filter(
                (definition) =>
                  !projectDefinitions.some((project) =>
                    isDeepStrictEqual(definition, project),
                  ),
              )
            : definitions,
        ];
      }),
    );
  return {
    userHooks: separated?.userHooks ?? fallbackUserHooks,
    projectHooks: separated ? (separated.projectHooks ?? {}) : undefined,
    hooks: mergedHooks,
  };
}
