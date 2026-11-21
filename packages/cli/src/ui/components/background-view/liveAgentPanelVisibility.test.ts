/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  getLiveAgentPanelVpMaxRows,
  isLiveAgentPanelVisibleEntry,
  TERMINAL_VISIBLE_MS,
} from './liveAgentPanelVisibility.js';
import type {
  AgentDialogEntry,
  DialogEntry,
} from '../../hooks/useBackgroundTaskView.js';

function agentEntry(
  overrides: Partial<AgentDialogEntry> = {},
): AgentDialogEntry {
  return {
    kind: 'agent',
    id: 'a',
    description: 'desc',
    status: 'running',
    startTime: 0,
    abortController: new AbortController(),
    ...overrides,
  } as AgentDialogEntry;
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

describe('isLiveAgentPanelVisibleEntry (eviction window)', () => {
  it('returns false for non-agent entries', () => {
    expect(isLiveAgentPanelVisibleEntry(shellEntry(), 1000)).toBe(false);
  });

  it('keeps running agents visible unconditionally (no endTime)', () => {
    expect(
      isLiveAgentPanelVisibleEntry(agentEntry({ status: 'running' }), 1000),
    ).toBe(true);
  });

  it('keeps paused agents visible unconditionally (no endTime)', () => {
    expect(
      isLiveAgentPanelVisibleEntry(agentEntry({ status: 'paused' }), 1000),
    ).toBe(true);
  });

  it('returns false for a terminal agent missing endTime (guards NaN)', () => {
    // nowMs - undefined would be NaN, and NaN <= window is false — assert the
    // explicit endTime guard short-circuits before that comparison.
    const entry = agentEntry({ status: 'completed' });
    expect(isLiveAgentPanelVisibleEntry(entry, 1000)).toBe(false);
  });

  it('keeps a terminal agent visible within the window, evicts after', () => {
    const entry = agentEntry({ status: 'completed', endTime: 1000 });
    expect(isLiveAgentPanelVisibleEntry(entry, 1000)).toBe(true);
    expect(
      isLiveAgentPanelVisibleEntry(entry, 1000 + TERMINAL_VISIBLE_MS),
    ).toBe(true);
    expect(
      isLiveAgentPanelVisibleEntry(entry, 1000 + TERMINAL_VISIBLE_MS + 1),
    ).toBe(false);
  });
});

describe('getLiveAgentPanelVpMaxRows', () => {
  it('returns min rows (3) for short terminals', () => {
    expect(getLiveAgentPanelVpMaxRows(15)).toBe(3);
    expect(getLiveAgentPanelVpMaxRows(24)).toBe(3);
  });

  it('grows with terminal height', () => {
    // clamp(floor(h/10), 3, 5)
    expect(getLiveAgentPanelVpMaxRows(30)).toBe(3);
    expect(getLiveAgentPanelVpMaxRows(40)).toBe(4);
    expect(getLiveAgentPanelVpMaxRows(50)).toBe(5);
  });

  it('caps at max rows (5) for tall terminals', () => {
    expect(getLiveAgentPanelVpMaxRows(80)).toBe(5);
    expect(getLiveAgentPanelVpMaxRows(100)).toBe(5);
  });

  it('returns min rows for invalid heights', () => {
    expect(getLiveAgentPanelVpMaxRows(0)).toBe(3);
    expect(getLiveAgentPanelVpMaxRows(-1)).toBe(3);
    expect(getLiveAgentPanelVpMaxRows(Number.NaN)).toBe(3);
  });
});
