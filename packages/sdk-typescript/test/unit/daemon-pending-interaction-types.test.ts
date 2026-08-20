/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { pendingInteractionWireTypesInSync } from '../../src/daemon/types-sync.js';

describe('daemon pending interaction wire types', () => {
  it('keeps bridge and SDK mirrors mutually assignable', () => {
    expect(pendingInteractionWireTypesInSync).toEqual([true, true, true, true]);
  });
});
