/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getPackageJson } from './package.js';

export async function getCliVersion(): Promise<string> {
  const pkgJson = await getPackageJson();
  return process.env['CLI_VERSION'] || pkgJson?.version || 'unknown';
}

/**
 * Format the version for display. Real semver releases get a "v" prefix
 * ("v0.19.4"); a non-semver fallback such as "unknown" (from getCliVersion when
 * the package version can't be resolved) is shown as-is so we never render a
 * bogus "vunknown".
 */
export function formatVersionLabel(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}
