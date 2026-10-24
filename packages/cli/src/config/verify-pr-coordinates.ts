/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface VerifyPrCoordinates {
  assetsRepo?: string | undefined;
  assetsBranch?: string | undefined;
}

/**
 * The variables the `verify-pr` skill reads for its publishing coordinates.
 * `applyVerifyPrCoordinateEnv` is the only writer: the skill resolves
 * `--assets-repo`/`--assets-branch`, then these variables, then its own
 * defaults.
 */
export const VERIFY_PR_COORDINATE_ENV = {
  assetsRepo: 'QWEN_VERIFY_ASSETS_REPO',
  assetsBranch: 'QWEN_VERIFY_ASSETS_BRANCH',
} as const;

/**
 * The names this function itself wrote into each environment object. A value
 * the operator exported is never in the set, so it survives a settings change
 * or a deletion; a value we wrote is replaced when the setting changes and
 * dropped when it disappears. Without this the bridge was add-only, and a
 * long-lived process kept publishing to a host the operator had since changed.
 */
const writtenByBridge = new WeakMap<NodeJS.ProcessEnv, Set<string>>();

/**
 * Fills the coordinate variables that settings.json can supply. An exported
 * variable wins, and stays winning through later calls; a value this function
 * wrote earlier is refreshed or removed on the next call. An empty value counts
 * as unset, matching how the environment loader treats an empty export.
 *
 * Callers pass operator-scope settings only. These values decide where a
 * maintainer's verification evidence is published, which is not a decision a
 * cloned repository's settings file may make.
 */
export function applyVerifyPrCoordinateEnv(
  coordinates: VerifyPrCoordinates | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const applied: string[] = [];
  let ours = writtenByBridge.get(env);
  if (!ours) {
    ours = new Set<string>();
    writtenByBridge.set(env, ours);
  }
  for (const [field, name] of Object.entries(VERIFY_PR_COORDINATE_ENV) as Array<
    [keyof VerifyPrCoordinates, string]
  >) {
    const value = coordinates?.[field];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed === '') {
      if (ours.delete(name)) delete env[name];
      continue;
    }
    const existing = env[name];
    if (existing !== undefined && existing !== '' && !ours.has(name)) continue;
    if (existing !== trimmed) {
      env[name] = trimmed;
      applied.push(name);
    }
    ours.add(name);
  }
  return applied;
}
