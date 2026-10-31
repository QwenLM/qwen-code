/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_EVENTS } from './claude-events.js';
import { MOD_EVENTS, MOD_METHODS } from './dispatch.js';

describe('Claude Code event names', () => {
  it('lists each engine, API and classic event once, including every supported one', () => {
    expect(CLAUDE_CODE_EVENTS).toHaveLength(144);
    expect(new Set(CLAUDE_CODE_EVENTS).size).toBe(144);
    expect(CLAUDE_CODE_EVENTS).toEqual(expect.arrayContaining([...MOD_EVENTS]));
    expect(MOD_EVENTS).toEqual(expect.arrayContaining([...MOD_METHODS]));
  });
});
