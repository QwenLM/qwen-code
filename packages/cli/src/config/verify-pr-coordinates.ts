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
 * Fills the coordinate variables that settings.json can supply, leaving an
 * already-set variable alone so an export or an inline assignment still wins.
 * An empty value counts as unset, matching how the environment loader treats
 * an empty export.
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
  for (const [field, name] of Object.entries(VERIFY_PR_COORDINATE_ENV) as Array<
    [keyof VerifyPrCoordinates, string]
  >) {
    const value = coordinates?.[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === '') continue;
    const existing = env[name];
    if (existing !== undefined && existing !== '') continue;
    env[name] = trimmed;
    applied.push(name);
  }
  return applied;
}
