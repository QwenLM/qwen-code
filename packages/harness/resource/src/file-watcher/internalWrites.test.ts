/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  clearInternalWrites,
  consumeInternalWrite,
  markInternalWrite,
} from './internalWrites.js';

describe('internal write tracking', () => {
  it('consumes writes within the configured window', () => {
    clearInternalWrites();
    markInternalWrite('/tmp/settings.json', 1000);

    expect(consumeInternalWrite('/tmp/settings.json', 5000, 1200)).toBe(true);
    expect(consumeInternalWrite('/tmp/settings.json', 5000, 1300)).toBe(false);
  });

  it('rejects stale writes', () => {
    clearInternalWrites();
    markInternalWrite('/tmp/settings.json', 1000);

    expect(consumeInternalWrite('/tmp/settings.json', 100, 1200)).toBe(false);
  });
});
