/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { vi } from 'vitest';

export const MACHINE_ID = '/etc/machine-id';
export const PINNED_MACHINE_ID = '0123456789abcdef0123456789abcdef';

// The runtime refuses without a stable host identity; pin the host file so
// in-process suites run on hosts that do not provide one.
export function pinHostMachineId(): void {
  const delegateReadFile = fs.readFile;
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (String(args[0]) === MACHINE_ID) return PINNED_MACHINE_ID;
    return delegateReadFile(...args);
  });
}
