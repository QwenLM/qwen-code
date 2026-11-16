/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { bootstrapWatchFilter } from './path-comparison.js';

describe('bootstrapWatchFilter', () => {
  const root = path.resolve('/home/user/.qwen');
  const ignored = bootstrapWatchFilter(root, 'extensions');

  it('keeps the root however chokidar spells it', () => {
    expect(ignored(root)).toBe(false);
    expect(ignored(root.split(path.sep).join('/'))).toBe(false);
    expect(ignored(`${root}${path.sep}`)).toBe(false);
  });

  it('keeps only the awaited entry under the root', () => {
    expect(ignored(path.join(root, 'extensions'))).toBe(false);
    expect(ignored(path.join(root, 'settings.json'))).toBe(true);
    expect(ignored(path.join(root, 'other'))).toBe(true);
  });
});
