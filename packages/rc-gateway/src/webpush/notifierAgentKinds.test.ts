/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { KIND_SCOPE, SNOOZE_BYPASS_KINDS } from './notifier.js';
import { SESSION_READ } from '../scopes.js';

describe('agent notification kinds', () => {
  it('scope-gates all five agent kinds at session:read', () => {
    for (const kind of [
      'agent.spawned',
      'agent.completed',
      'agent.failed',
      'agent.blocked',
      'agent.cancelled',
    ]) {
      expect(KIND_SCOPE[kind]).toBe(SESSION_READ);
    }
  });

  it('agent.blocked is a critical (snooze-bypass) kind; the others are not', () => {
    expect(SNOOZE_BYPASS_KINDS.has('agent.blocked')).toBe(true);
    expect(SNOOZE_BYPASS_KINDS.has('agent.completed')).toBe(false);
  });
});
