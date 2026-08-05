/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isReplayTurnStartType } from './index.js';

describe('core entry point', () => {
  // Gates the public barrel: packages/cli imports this symbol from
  // @qwen-code/qwen-code-core, so dropping the re-export must fail a
  // package-scoped test run, not just a downstream typecheck.
  it('re-exports isReplayTurnStartType', () => {
    expect(typeof isReplayTurnStartType).toBe('function');
  });
});
