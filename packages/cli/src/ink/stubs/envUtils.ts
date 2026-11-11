/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (typeof envVar === 'boolean') return envVar;
  if (typeof envVar === 'undefined') return false;
  const val = process.env[envVar]?.trim().toLowerCase();
  return val === '1' || val === 'true' || val === 'yes' || val === 'on';
}

export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (typeof envVar === 'boolean') return !envVar;
  if (typeof envVar === 'undefined') return false;
  const val = process.env[envVar]?.trim().toLowerCase();
  return val === '0' || val === 'false' || val === 'no' || val === 'off';
}
