/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  getLiveAgentPanelLayoutKey,
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
    agentId: 'a',
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

describe('getLiveAgentPanelLayoutKey', () => {
  it('changes when an agent is added (panel grows)', () => {
    const before = getLiveAgentPanelLayoutKey([], false);
    const after = getLiveAgentPanelLayoutKey(
      [agentEntry({ agentId: 'a1' })],
      false,
    );
    expect(after).not.toBe(before);
  });

  it('changes when an agent is removed (panel shrinks)', () => {
    const two = getLiveAgentPanelLayoutKey(
      [agentEntry({ agentId: 'a1' }), agentEntry({ agentId: 'a2' })],
      false,
    );
    const one = getLiveAgentPanelLayoutKey(
      [agentEntry({ agentId: 'a1' })],
      false,
    );
    expect(one).not.toBe(two);
  });

  it('changes when an agent status flips (running -> completed)', () => {
    const running = getLiveAgentPanelLayoutKey(
      [agentEntry({ agentId: 'a1', status: 'running' })],
      false,
    );
    const done = getLiveAgentPanelLayoutKey(
      [agentEntry({ agentId: 'a1', status: 'completed', endTime: 1 })],
      false,
    );
    expect(done).not.toBe(running);
  });

  it('changes when panel focus toggles (adds the navigation hint row)', () => {
    const entries = [agentEntry({ agentId: 'a1' })];
    expect(getLiveAgentPanelLayoutKey(entries, true)).not.toBe(
      getLiveAgentPanelLayoutKey(entries, false),
    );
  });

  it('is STABLE across per-second elapsed-time ticks (no height change)', () => {
    // The panel re-renders every second to refresh elapsed time, but that
    // tick never touches the roster — the key must not churn, or AppContainer
    // would needlessly re-measure the footer every second.
    const entries = [
      agentEntry({ agentId: 'a1', status: 'running', startTime: 0 }),
      agentEntry({ agentId: 'a2', status: 'running', startTime: 0 }),
    ];
    const k1 = getLiveAgentPanelLayoutKey(entries, false);
    const k2 = getLiveAgentPanelLayoutKey(entries, false);
    expect(k2).toBe(k1);
  });

  it('ignores non-agent entries (panel renders only agents)', () => {
    const onlyShell = getLiveAgentPanelLayoutKey([shellEntry()], false);
    const empty = getLiveAgentPanelLayoutKey([], false);
    expect(onlyShell).toBe(empty);
  });
});

// Guard the assumption the layout key relies on: a finished agent stays
// visible (so its row keeps occupying height) for the eviction window, and
// only then shrinks the panel — the "safe" direction the key intentionally
// does not track.
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
