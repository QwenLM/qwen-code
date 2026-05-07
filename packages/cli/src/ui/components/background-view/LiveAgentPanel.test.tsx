/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import type { Config } from '@qwen-code/qwen-code-core';
import { LiveAgentPanel } from './LiveAgentPanel.js';
import { BackgroundTaskViewStateContext } from '../../contexts/BackgroundTaskViewContext.js';
import { ConfigContext } from '../../contexts/ConfigContext.js';
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

function renderPanel(
  options: {
    entries: readonly DialogEntry[];
    dialogOpen?: boolean;
    width?: number;
    maxRows?: number;
    /**
     * Stub Config supplying a `getBackgroundTaskRegistry()` for the
     * panel's per-tick live re-pull. Omit when the test cares only
     * about the snapshot path (panel falls back gracefully).
     */
    config?: Config;
  } = { entries: [] },
) {
  const state = {
    entries: options.entries,
    selectedIndex: 0,
    dialogMode: options.dialogOpen ? ('list' as const) : ('closed' as const),
    dialogOpen: Boolean(options.dialogOpen),
    pillFocused: false,
  };
  // Wrap render() in act() so the panel's mount-time effect (the
  // 1s wall-clock interval) is flushed inside React's scheduler boundary
  // — silences the "update inside a test was not wrapped in act"
  // warning ink-testing-library otherwise leaks for every render.
  let result!: ReturnType<typeof render>;
  act(() => {
    result = render(
      <ConfigContext.Provider value={options.config}>
        <BackgroundTaskViewStateContext.Provider value={state}>
          <LiveAgentPanel width={options.width} maxRows={options.maxRows} />
        </BackgroundTaskViewStateContext.Provider>
      </ConfigContext.Provider>,
    );
  });
  return result;
}

/**
 * Build a stub Config exposing only `getBackgroundTaskRegistry` — the
 * one method the panel calls. Returning a Map-backed registry whose
 * `get` reads from the live store lets a test mutate `recentActivities`
 * after render and observe the panel pick up the new value on the next
 * tick (the actual production behavior we want to lock in).
 */
function makeRegistryConfig(agents: readonly AgentDialogEntry[]): {
  config: Config;
  store: Map<string, AgentDialogEntry>;
} {
  const store = new Map<string, AgentDialogEntry>();
  for (const a of agents) store.set(a.agentId, a);
  const config = {
    getBackgroundTaskRegistry: () => ({
      get: (id: string) => store.get(id),
    }),
  } as unknown as Config;
  return { config, store };
}

describe('<LiveAgentPanel />', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides when there are no agent entries', () => {
    const { lastFrame } = renderPanel({ entries: [] });
    expect(lastFrame() ?? '').toBe('');
  });

  it('hides when only non-agent entries exist (shell-only)', () => {
    const { lastFrame } = renderPanel({ entries: [shellEntry()] });
    expect(lastFrame() ?? '').toBe('');
  });

  it('hides when the background dialog is open (avoids duplicate roster)', () => {
    const { lastFrame } = renderPanel({
      entries: [agentEntry({ subagentType: 'researcher' })],
      dialogOpen: true,
    });
    expect(lastFrame() ?? '').toBe('');
  });

  it('renders header and a single running agent row', () => {
    const { lastFrame } = renderPanel({
      entries: [
        agentEntry({
          agentId: 'a-1',
          subagentType: 'researcher',
          description: 'researcher: scan repo for TODO markers',
          startTime: -5_000, // 5s ago at fake-time 0
          recentActivities: [
            { name: 'Glob', description: '**/*.ts', at: -1000 },
          ],
        }),
      ],
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Active agents');
    // Running and total tally both 1.
    expect(frame).toContain('(1/1)');
    expect(frame).toContain('researcher');
    expect(frame).toContain('scan repo for TODO markers');
    // Latest activity is rendered next to the row, with elapsed time.
    expect(frame).toContain('Glob');
    expect(frame).toContain('5s');
  });

  it('marks foreground agents with the [in turn] prefix', () => {
    const { lastFrame } = renderPanel({
      entries: [
        agentEntry({
          agentId: 'fg-1',
          subagentType: 'editor',
          description: 'editor: tighten import order',
          flavor: 'foreground',
        }),
      ],
    });
    expect(lastFrame() ?? '').toContain('[in turn]');
  });

  it('windows from the tail when entries exceed maxRows', () => {
    const entries = [
      agentEntry({
        agentId: 'a-1',
        subagentType: 'old-agent',
        description: 'old work',
      }),
      agentEntry({
        agentId: 'a-2',
        subagentType: 'mid-agent',
        description: 'mid work',
      }),
      agentEntry({
        agentId: 'a-3',
        subagentType: 'fresh-agent',
        description: 'fresh work',
      }),
    ];
    const { lastFrame } = renderPanel({ entries, maxRows: 2 });
    const frame = lastFrame() ?? '';
    // `more above` callout flagged with the dropped count.
    expect(frame).toContain('1 more above');
    // Tail window keeps the newest two rows.
    expect(frame).toContain('mid-agent');
    expect(frame).toContain('fresh-agent');
    // Oldest row falls outside the window.
    expect(frame).not.toContain('old-agent');
    // Total tally still reflects every agent — windowing is a render
    // concern, not a counting one.
    expect(frame).toContain('(3/3)');
  });

  it('re-pulls recentActivities from the live registry on each tick', () => {
    // The snapshot from useBackgroundTaskView only refreshes on
    // statusChange — appendActivity is intentionally silenced there to
    // protect the footer pill / AppContainer from per-tool churn. The
    // panel must reach back into the registry on every tick or it
    // would freeze on whatever activities the snapshot captured at
    // register time (typically empty, since register fires before any
    // tools run).
    const initial = agentEntry({
      agentId: 'live-1',
      subagentType: 'researcher',
      description: 'researcher: investigate',
      recentActivities: [], // snapshot has nothing
    });
    const { config, store } = makeRegistryConfig([initial]);
    const { lastFrame } = renderPanel({ entries: [initial], config });

    // First paint: snapshot says no activities, registry agrees.
    expect(lastFrame() ?? '').not.toContain('Glob');

    // Mutate the registry the way `appendActivity` would in production
    // (replace the array reference on the same entry object) and
    // advance the wall-clock tick. The panel should re-pull and show
    // the new activity without needing a statusChange.
    const live = store.get('live-1')!;
    store.set('live-1', {
      ...live,
      recentActivities: [
        { name: 'Glob', description: '**/*.ts', at: Date.now() },
      ],
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(lastFrame() ?? '').toContain('Glob');
  });

  it('shows terminal status briefly then falls off after the visibility window', () => {
    const { lastFrame } = renderPanel({
      entries: [
        agentEntry({
          agentId: 'done-1',
          subagentType: 'finisher',
          description: 'finisher: wrap up',
          status: 'completed',
          startTime: -2000,
          endTime: 0, // just terminal
        }),
      ],
    });
    // Within the visibility window the row is still on screen but the
    // running tally drops to 0/1.
    expect(lastFrame() ?? '').toContain('finisher');
    expect(lastFrame() ?? '').toContain('(0/1)');

    act(() => {
      vi.advanceTimersByTime(9000);
    });
    // Past TERMINAL_VISIBLE_MS the row is evicted from the panel; with
    // nothing left to show the panel hides itself.
    expect(lastFrame() ?? '').toBe('');
  });
});
