/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function getPinnedPnpmPackage(packageJson) {
  const packageManager = packageJson.packageManager;
  // `corepack use pnpm@x.y.z` appends an integrity suffix
  // (+sha512.<128 hex chars>); accept it so the command corepack itself
  // writes cannot break the bootstrap, but reject everything else.
  if (
    !/^pnpm@\d+\.\d+\.\d+(\+sha512\.[0-9a-f]{128})?$/.test(packageManager ?? '')
  ) {
    throw new Error('packageManager must pin an exact pnpm version');
  }

  return packageManager;
}
