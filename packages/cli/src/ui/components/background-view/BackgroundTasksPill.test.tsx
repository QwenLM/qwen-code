/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { BackgroundTaskEntry } from '@qwen-code/qwen-code-core';
import { getPillLabel } from './BackgroundTasksPill.js';

function entry(overrides: Partial<BackgroundTaskEntry>): BackgroundTaskEntry {
  return {
    agentId: 'a',
    description: 'desc',
    status: 'running',
    startTime: 0,
    abortController: new AbortController(),
    ...overrides,
  };
}

describe('getPillLabel', () => {
  it('uses singular form for one running agent', () => {
    expect(getPillLabel([entry({ agentId: 'a' })])).toBe('1 local agent');
  });

  it('uses plural form for multiple running agents', () => {
    expect(
      getPillLabel([
        entry({ agentId: 'a' }),
        entry({ agentId: 'b' }),
        entry({ agentId: 'c' }),
      ]),
    ).toBe('3 local agents');
  });

  it('counts only running entries when running and terminal mix', () => {
    expect(
      getPillLabel([
        entry({ agentId: 'a', status: 'running' }),
        entry({ agentId: 'b', status: 'completed' }),
        entry({ agentId: 'c', status: 'cancelled' }),
      ]),
    ).toBe('1 local agent');
  });

  it('uses singular done form for one terminal-only entry', () => {
    expect(getPillLabel([entry({ agentId: 'a', status: 'completed' })])).toBe(
      '1 local agent done',
    );
  });

  it('uses plural done form when all entries are terminal', () => {
    expect(
      getPillLabel([
        entry({ agentId: 'a', status: 'completed' }),
        entry({ agentId: 'b', status: 'failed' }),
      ]),
    ).toBe('2 local agents done');
  });
});
