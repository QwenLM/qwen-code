/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { plugin } from './index.js';

describe('DingTalk management fields', () => {
  it('opts in to shared output mode without redeclaring its management field', () => {
    expect(plugin.supportsOutputMode).toBe(true);
    expect(plugin.management?.fields.map((field) => field.key)).toEqual([
      'clientId',
      'clientSecret',
      'interactiveCards',
    ]);
  });
});
