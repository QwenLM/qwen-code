/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createHookConfigurationRef } from './hookConfigurationRef.js';
describe('Hook reference v1 contract', () => {
  const hook = { type: 'command', command: '' };
  it('matches the protocol vector regardless of object key order', () => {
    expect(
      createHookConfigurationRef('settings:user', 'PreToolUse', 0, 1, hook),
    ).toBe('b482fef8d6b4c312afa67bad19502b6e3874767dd3c3b4f4e95891ecd782619c');
    expect(
      createHookConfigurationRef('settings:user', 'PreToolUse', 0, 1, {
        command: '',
        type: 'command',
      }),
    ).toBe('b482fef8d6b4c312afa67bad19502b6e3874767dd3c3b4f4e95891ecd782619c');
  });
  it('separates source, position and changed configuration', () => {
    const refs = [
      createHookConfigurationRef('settings:user', 'PreToolUse', 0, 1, hook),
      createHookConfigurationRef('settings:project', 'PreToolUse', 0, 1, hook),
      createHookConfigurationRef(
        'plugin:/a/hooks.json',
        'PreToolUse',
        0,
        1,
        hook,
      ),
      createHookConfigurationRef(
        'plugin:/b/hooks.json',
        'PreToolUse',
        0,
        1,
        hook,
      ),
      createHookConfigurationRef('settings:user', 'PreToolUse', 0, 0, hook),
      createHookConfigurationRef('settings:user', 'PreToolUse', 1, 1, hook),
      createHookConfigurationRef('settings:user', 'PreToolUse', 0, 1, {
        ...hook,
        command: 'echo fixed',
      }),
    ];
    expect(new Set(refs).size).toBe(refs.length);
  });
});
