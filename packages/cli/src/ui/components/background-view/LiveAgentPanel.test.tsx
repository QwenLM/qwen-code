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

  it('does NOT surface a flavor marker on foreground agents', () => {
    // Foreground vs background distinction stays with BackgroundTasksDialog
    // (where cancel semantics differ); the panel reads as a glance roster
    // and the marker added more confusion than signal.
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
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('[in turn]');
    expect(frame).toContain('editor');
    expect(frame).toContain('tighten import order');
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
    // `more above` callout flagged with the dropped count and points
    // at the dialog (the only surface where the user can scroll
    // through the full roster + take action).
    expect(frame).toContain('1 more above');
    expect(frame).toContain('to view all');
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

  it('drops snapshot rows the live registry no longer knows about', () => {
    // Foreground subagents unregister silently after the status-change
    // callback fires (`unregisterForeground` deletes from the registry
    // without emitting another transition). The snapshot still lists the
    // entry as `running`, so a naive `live ?? snap` fallback would leave
    // a ghost row that never clears. The panel must trust the registry
    // and drop the row when `registry.get()` returns undefined.
    const ghost = agentEntry({
      agentId: 'ghost-1',
      subagentType: 'editor',
      description: 'editor: long-gone foreground task',
      status: 'running',
    });
    // Stub registry knows nothing about ghost-1 (simulates the
    // post-unregister state).
    const { config } = makeRegistryConfig([]);
    const { lastFrame } = renderPanel({ entries: [ghost], config });
    expect(lastFrame() ?? '').toBe('');
  });

  it('tears the 1s tick down when the bg-tasks dialog opens', () => {
    // While the dialog is open the panel returns null and the dialog
    // owns the same data — a still-running interval is a wasted
    // re-render budget. Verify by checking that advancing the clock
    // past the visibility window with dialogOpen=true does not flip
    // the panel into its "expired" state (which would only happen if
    // the tick advanced `now`).
    const initial = agentEntry({
      agentId: 'live-1',
      subagentType: 'researcher',
      description: 'researcher: investigate',
      status: 'completed',
      startTime: -2000,
      endTime: 0,
    });
    const { config } = makeRegistryConfig([initial]);
    const { lastFrame } = renderPanel({
      entries: [initial],
      config,
      dialogOpen: true,
    });
    // Dialog open → panel hidden, no opportunity for `now` to drift.
    expect(lastFrame() ?? '').toBe('');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // Still hidden. The fact that we got here without the panel ever
    // mounting an interval means subsequent renders won't churn either.
    expect(lastFrame() ?? '').toBe('');
  });

  it('still shows the snapshot when no Config is mounted (test fixtures)', () => {
    // Without a Config provider the panel can't reach the registry, so
    // it has to trust the snapshot — this is the one place the legacy
    // "fall back to snap" behavior is correct (and the seven other
    // tests in this file rely on it).
    const { lastFrame } = renderPanel({
      entries: [
        agentEntry({
          agentId: 'snap-only',
          subagentType: 'researcher',
          description: 'researcher: snapshot-only path',
        }),
      ],
    });
    expect(lastFrame() ?? '').toContain('researcher');
    expect(lastFrame() ?? '').toContain('snapshot-only path');
  });
});
