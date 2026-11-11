/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getQwenPaths } from './paths.js';

const originalPlatform = process.platform;
afterEach(() =>
  Object.defineProperty(process, 'platform', { value: originalPlatform }),
);

it.each(['win32', 'darwin', 'linux'])(
  'uses the native %s entry without changing the configuration root',
  (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const paths = getQwenPaths();
    expect(paths.dataDir).toBe(join(homedir(), '.qwen'));
    expect(paths.binDir).toBe(join(paths.dataDir, 'bin', 'qwen'));
    expect(paths.linkPath).toBe(
      platform === 'win32'
        ? join(paths.binDir, 'qwen.exe')
        : join(homedir(), '.local/bin/qwen'),
    );
    expect(paths.lockFile).toBe(join(paths.dataDir, 'update.lock'));
  },
);
