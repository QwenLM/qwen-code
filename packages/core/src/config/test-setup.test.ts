/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Storage } from './storage.js';

describe('core test runtime isolation', () => {
  it('keeps Storage runtime output outside the developer home directory', () => {
    const runtimeDir = path.resolve(Storage.getRuntimeBaseDir());
    const homeDir = path.resolve(os.homedir());
    const relative = path.relative(homeDir, runtimeDir);

    expect(relative).not.toBe('');
    expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(true);
  });
});
