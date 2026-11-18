/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as dingtalkPackage from './index.js';
import { plugin } from './index.js';

describe('DingTalk management fields', () => {
  it('opts in to shared output mode without redeclaring its management field', () => {
    expect(plugin.supportsOutputMode).toBe(true);
    expect(plugin.requiredConfigFields).toEqual(['clientId', 'clientSecret']);
    expect(plugin.management?.fields.map((field) => field.key)).toEqual([
      'clientId',
      'clientSecret',
      'interactiveCards',
    ]);
  });
});

describe('DingTalk package export surface (#17173 R3)', () => {
  it('exports the managed adapter surface the CLI and deps consume', () => {
    // Reverting the managed export block must red this suite, not leave
    // every consumer test green on its direct module import.
    expect(typeof dingtalkPackage.ManagedDingtalkAdapter).toBe('function');
    expect(typeof dingtalkPackage.dingtalkSettings).toBe('function');
    expect(typeof dingtalkPackage.createManagedDingtalkDeps).toBe('function');
    expect(typeof dingtalkPackage.DingtalkChannel).toBe('function');
    expect(typeof dingtalkPackage.webhookPlugin).toBe('object');
  });
});
