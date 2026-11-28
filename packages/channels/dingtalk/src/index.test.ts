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
      'cardTemplateId',
      'interactiveCards',
    ]);
  });

  it('names cardTemplateId in both env-resolution lists (R2-3)', () => {
    // The settings store accepts a $VAR reference because the management field
    // is envResolvable; the runtime only resolves it if envResolvableConfigFields
    // also names it. Both must agree, or a misspelled deployment variable reaches
    // the card API as a literal template id and every reply is terminally
    // rejected. Removing either declaration reds this.
    const field = plugin.management?.fields.find(
      (candidate) => candidate.key === 'cardTemplateId',
    );
    expect(field?.envResolvable).toBe(true);
    expect(plugin.envResolvableConfigFields).toContain('cardTemplateId');
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
