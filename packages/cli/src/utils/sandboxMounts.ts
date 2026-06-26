/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';

export function parseSandboxMountSpec(
  rawMount: string,
  platform: NodeJS.Platform = os.platform(),
): { from: string; to: string; opts: string } {
  const mount = rawMount.trim();
  const mountSeparator =
    platform === 'win32' && /^[A-Za-z]:[\\/]/.test(mount)
      ? mount.indexOf(':', 2)
      : mount.indexOf(':');

  const from = mountSeparator === -1 ? mount : mount.slice(0, mountSeparator);
  const rest = mountSeparator === -1 ? '' : mount.slice(mountSeparator + 1);
  const [toPart, optsPart] = rest.split(':');

  return {
    from,
    to: toPart || from,
    opts: optsPart || 'ro',
  };
}
