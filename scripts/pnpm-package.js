/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function getPinnedPnpmPackage(packageJson) {
  const packageManager = packageJson.packageManager;
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager ?? '')) {
    throw new Error('packageManager must pin an exact pnpm version');
  }

  return packageManager;
}
