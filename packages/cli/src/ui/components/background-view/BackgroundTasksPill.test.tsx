/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { DialogEntry } from '../../hooks/useBackgroundTaskView.js';
import { getPillLabel } from './BackgroundTasksPill.js';

function agentEntry(overrides: Partial<DialogEntry> = {}): DialogEntry {
  return {
    kind: 'agent',
    agentId: 'a',
    description: 'desc',
    status: 'running',
    startTime: 0,
    abortController: new AbortController(),
    ...overrides,
  } as DialogEntry;
}

function shellEntry(overrides: Partial<DialogEntry> = {}): DialogEntry {
  return {
    kind: 'shell',
    shellId: 'bg_x',
    command: 'sleep 60',
    cwd: '/tmp',
    status: 'running',
    startTime: 0,
    outputPath: '/tmp/x.out',
    abortController: new AbortController(),
    ...overrides,
  } as DialogEntry;
}

describe('getPillLabel', () => {
  it('uses singular form for one running agent', () => {
    expect(getPillLabel([agentEntry({ agentId: 'a' })])).toBe('1 local agent');
  });

  it('uses plural form for multiple running agents', () => {
    expect(
      getPillLabel([
        agentEntry({ agentId: 'a' }),
        agentEntry({ agentId: 'b' }),
        agentEntry({ agentId: 'c' }),
      ]),
    ).toBe('3 local agents');
  });

  it('uses singular form for one running shell', () => {
    expect(getPillLabel([shellEntry({ shellId: 'bg_a' })])).toBe('1 shell');
  });

  it('uses plural form for multiple running shells', () => {
    expect(
      getPillLabel([
        shellEntry({ shellId: 'bg_a' }),
        shellEntry({ shellId: 'bg_b' }),
      ]),
    ).toBe('2 shells');
  });

  it('groups by kind when both kinds are running, shells first', () => {
    expect(
      getPillLabel([
        agentEntry({ agentId: 'a' }),
        shellEntry({ shellId: 'bg_a' }),
        shellEntry({ shellId: 'bg_b' }),
      ]),
    ).toBe('2 shells, 1 local agent');
  });

  it('counts only running entries when running and terminal mix', () => {
    expect(
      getPillLabel([
        agentEntry({ agentId: 'a', status: 'running' }),
        agentEntry({ agentId: 'b', status: 'completed' }),
        shellEntry({ shellId: 'bg_a', status: 'cancelled' }),
      ]),
    ).toBe('1 local agent');
  });

  it('uses paused form when only paused entries remain', () => {
    expect(getPillLabel([agentEntry({ agentId: 'a', status: 'paused' })])).toBe(
      '1 local agent paused',
    );
  });

  it('uses generic done form when all entries are terminal', () => {
    expect(
      getPillLabel([agentEntry({ agentId: 'a', status: 'completed' })]),
    ).toBe('1 task done');
    expect(
      getPillLabel([
        agentEntry({ agentId: 'a', status: 'completed' }),
        shellEntry({ shellId: 'bg_a', status: 'failed' }),
      ]),
    ).toBe('2 tasks done');
  });
});
