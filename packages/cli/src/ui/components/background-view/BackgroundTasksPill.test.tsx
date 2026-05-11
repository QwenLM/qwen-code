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

function dreamEntry(overrides: Partial<DialogEntry> = {}): DialogEntry {
  return {
    kind: 'dream',
    dreamId: 'd-1',
    status: 'running',
    startTime: 0,
    sessionCount: 5,
    ...overrides,
  } as DialogEntry;
}

function monitorEntry(overrides: Partial<DialogEntry> = {}): DialogEntry {
  return {
    kind: 'monitor',
    monitorId: 'mon-1',
    command: 'tail -f app.log',
    description: 'watch app logs',
    status: 'running',
    startTime: 0,
    abortController: new AbortController(),
    eventCount: 0,
    lastEventTime: 0,
    maxEvents: 1000,
    idleTimeoutMs: 300_000,
    droppedLines: 0,
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

  it('uses singular form for one running monitor', () => {
    expect(getPillLabel([monitorEntry({ monitorId: 'mon-a' })])).toBe(
      '1 monitor',
    );
  });

  it('uses plural form for multiple running monitors', () => {
    expect(
      getPillLabel([
        monitorEntry({ monitorId: 'mon-a' }),
        monitorEntry({ monitorId: 'mon-b' }),
      ]),
    ).toBe('2 monitors');
  });

  it('groups all three kinds with shells → agents → monitors order', () => {
    expect(
      getPillLabel([
        agentEntry({ agentId: 'a' }),
        shellEntry({ shellId: 'bg_a' }),
        monitorEntry({ monitorId: 'mon-a' }),
        monitorEntry({ monitorId: 'mon-b' }),
      ]),
    ).toBe('1 shell, 1 local agent, 2 monitors');
  });

  it('counts only running entries when monitors mix with terminal entries', () => {
    expect(
      getPillLabel([
        monitorEntry({ monitorId: 'mon-a', status: 'running' }),
        monitorEntry({ monitorId: 'mon-b', status: 'completed' }),
        monitorEntry({ monitorId: 'mon-c', status: 'cancelled' }),
      ]),
    ).toBe('1 monitor');
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

  it('uses singular form for one running dream', () => {
    expect(getPillLabel([dreamEntry({ dreamId: 'd-1' })])).toBe('1 dream');
  });

  it('uses plural form for multiple running dreams', () => {
    expect(
      getPillLabel([
        dreamEntry({ dreamId: 'd-1' }),
        dreamEntry({ dreamId: 'd-2' }),
      ]),
    ).toBe('2 dreams');
  });

  it('places dream last in the kind ordering (shell, agent, monitor, dream)', () => {
    // Ordering is asserted explicitly because it's a UX choice — dream
    // is system-initiated (not user-triggered) and the user is least
    // likely to need it at a glance, so it sits to the right of the
    // user-launched kinds.
    expect(
      getPillLabel([
        dreamEntry({ dreamId: 'd-1' }),
        agentEntry({ agentId: 'a' }),
        shellEntry({ shellId: 'bg_a' }),
        monitorEntry({ monitorId: 'mon-a' }),
      ]),
    ).toBe('1 shell, 1 local agent, 1 monitor, 1 dream');
  });

  it('counts only running dreams when terminal dreams mix in', () => {
    // Mirrors the existing monitor + agent terminal-mix tests so dream
    // gets the same coverage profile.
    expect(
      getPillLabel([
        dreamEntry({ dreamId: 'd-a', status: 'running' }),
        dreamEntry({ dreamId: 'd-b', status: 'completed' }),
        dreamEntry({ dreamId: 'd-c', status: 'failed' }),
      ]),
    ).toBe('1 dream');
  });
});
