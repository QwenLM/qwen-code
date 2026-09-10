/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { plugin } from './index.js';

describe('DingTalk management fields', () => {
  it('exposes output mode as the only background grouping control', () => {
    expect(plugin.management?.fields.map((field) => field.key)).toEqual([
      'clientId',
      'clientSecret',
      'outputMode',
      'interactiveCards',
    ]);
    expect(
      plugin.management?.fields.find((field) => field.key === 'outputMode'),
    ).toMatchObject({
      kind: 'enum',
      options: [{ value: 'final_only' }, { value: 'process_and_result' }],
    });
  });
});
