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

  it('elides the default `general-purpose` subagent type from the row', () => {
    // The DEFAULT_BUILTIN_SUBAGENT_TYPE elision suppresses the
    // redundant `general-purpose: ` prefix on rows where the type
    // adds no identity beyond the description. A future regression
    // that flipped the comparison (or hard-coded the wrong literal)
    // would silently re-introduce the prefix without failing
    // existing cases.
    const { lastFrame } = renderPanel({
      entries: [
        agentEntry({
          agentId: 'gp-1',
          subagentType: 'general-purpose',
          description: 'investigate the change in component layer',
        }),
      ],
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('investigate the change');
    expect(frame).not.toContain('general-purpose:');
  });

  it('truncates the description tail when the panel width is too narrow', () => {
    // The width prop is plumbed all the way down to the row's outer
    // Box; without exercising a narrow case the truncation behavior
    // (left flex-shrink + truncate-end) is uncovered. Anchor the
    // test on the right-pinned tail (` · Ns`) which must remain
    // visible regardless of how aggressive the truncation gets.
    const { lastFrame } = renderPanel({
      entries: [
        agentEntry({
          agentId: 'narrow-1',
          subagentType: 'researcher',
          description:
            'researcher: scan the entire repository for occurrences of TODO and FIXME markers and triage them by area',
          startTime: -3_000,
        }),
      ],
      width: 50,
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('…');
    // Right column still intact at the tail.
    expect(frame).toContain('▶ 3s');
  });

  it('clears the 1s tick interval when unmounted with live work in flight', () => {
    // The closest existing case (`tears the 1s tick down when the
    // bg-tasks dialog opens`) short-circuits BEFORE the interval is
    // ever scheduled. This case mounts with a running agent — the
    // interval IS scheduled — and asserts unmount tears it down so
    // setNow can't fire on a discarded fiber.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const running = agentEntry({
      agentId: 'unmount-1',
      subagentType: 'researcher',
      description: 'researcher: investigate',
      startTime: -1_000,
    });
    const { config } = makeRegistryConfig([running]);
    const { unmount } = renderPanel({ entries: [running], config });
    // Interval scheduled because there's running work.
    expect(setIntervalSpy).toHaveBeenCalled();
    const intervalIdsBefore = setIntervalSpy.mock.results
      .map((r) => r.value)
      .filter(Boolean);
    act(() => unmount());
    // Each interval the panel scheduled should be cleared on unmount.
    for (const id of intervalIdsBefore) {
      expect(clearIntervalSpy).toHaveBeenCalledWith(id);
    }
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('maps internal tool names to user-facing display names in the activity field', () => {
    // `recentActivities[].name` carries the internal tool name from
    // AgentToolCallEvent (e.g. `run_shell_command`, `glob`). Without
    // mapping through ToolDisplayNames the panel would surface those
    // raw identifiers while BackgroundTasksDialog shows `Shell` /
    // `Glob` — vocabulary drift between two views of the same data.
    const { lastFrame } = renderPanel({
      entries: [
        agentEntry({
          agentId: 'shell-1',
          subagentType: 'researcher',
          description: 'researcher: scan repo',
          recentActivities: [
            { name: 'run_shell_command', description: 'rg TODO', at: 0 },
          ],
        }),
      ],
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Shell');
    expect(frame).not.toContain('run_shell_command');
  });

  it('renders elapsed + token count for completed agents with stats', () => {
    // Locks in the cost-visibility win the panel is partly motivated
    // by — completed entries should surface `▶ Ns · Nk tokens`. Using
    // a completed entry (rather than running) so the assertion is
    // stable against the running-tally heuristic.
    const { lastFrame } = renderPanel({
      entries: [
        agentEntry({
          agentId: 'done-1',
          subagentType: 'researcher',
          description: 'researcher: investigate',
          status: 'completed',
          startTime: -12_000,
          endTime: 0,
          stats: { totalTokens: 2400, toolUses: 5, durationMs: 12_000 },
        }),
      ],
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('12s');
    expect(frame).toContain('2.4k tokens');
  });

  it('counts paused agents as active in the header tally', () => {
    // The header read "Active agents (running/total)" but the
    // panel ALSO renders paused agents as active rows (warning
    // color, ⏸ glyph). With only paused entries the tally would
    // read "(0/1)" — visually contradicting the row that's clearly
    // present. Numerator now includes paused.
    const { lastFrame } = renderPanel({
      entries: [
        agentEntry({
          agentId: 'paused-1',
          subagentType: 'researcher',
          description: 'researcher: paused waiting on resume',
          status: 'paused',
        }),
      ],
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('(1/1)');
    expect(frame).toContain('⏸');
  });

  it.each([
    ['paused', '⏸'],
    ['failed', '✖'],
    ['cancelled', '✖'],
  ] as const)('renders the %s status with the %s glyph', (status, glyph) => {
    // Status routing is otherwise uncovered for paused / failed /
    // cancelled — a future regression that flattened the switch
    // would slip past the existing running / completed cases.
    const { lastFrame } = renderPanel({
      entries: [
        agentEntry({
          agentId: `${status}-1`,
          subagentType: 'researcher',
          description: 'researcher: status routing fixture',
          status,
          // paused entries don't carry an endTime; failed / cancelled do.
          endTime: status === 'paused' ? undefined : 0,
        }),
      ],
    });
    expect(lastFrame() ?? '').toContain(glyph);
  });

  it('strips the subagentType: prefix from the description case-insensitively', () => {
    // `descriptionWithoutPrefix` lowercases both sides — the existing
    // tests only feed lowercase prefixes, so a future revert to
    // strict `startsWith` would silently re-introduce
    // `Researcher: Researcher: …` double-prefix on capitalised inputs.
    const { lastFrame } = renderPanel({
      entries: [
        agentEntry({
          agentId: 'cap-1',
          subagentType: 'researcher',
          description: 'Researcher: cap-mismatch description',
        }),
      ],
    });
    const frame = lastFrame() ?? '';
    // The prefix MUST have been stripped — the descriptive tail
    // should appear exactly once, with no leading "Researcher: ".
    expect(frame).toContain('cap-mismatch description');
    expect(frame).not.toContain('Researcher: cap-mismatch');
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
    // Neither the legacy `[in turn]` (pre-rename) nor the current
    // `[blocking]` (BackgroundTasksDialog convention) should bleed
    // into the glance panel — only the dialog surfaces the flavor
    // distinction, where the cancel semantics warrant it.
    expect(frame).not.toContain('[in turn]');
    expect(frame).not.toContain('[blocking]');
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

  it('reconciles snapshots the live registry no longer knows about as neutral-finished', () => {
    // `unregisterForeground` calls `emitStatusChange(entry)` BEFORE
    // it deletes the entry, so a snapshot taken on that callback
    // captures the agent as "still running" while the very next
    // render's `registry.get()` returns undefined. Naively falling
    // back to the snap leaves a ghost-running row that never clears;
    // dropping the row outright makes the agent disappear instantly
    // and the user loses the "what just finished?" beat. Synthesize
    // a terminal version so the 8s visibility window gives feedback
    // and then evicts the row cleanly.
    //
    // The synthesis MUST use a neutral glyph rather than the success
    // ✔ — foreground subagents do not transition through
    // `complete`/`fail`/`cancel` on the registry before unregister,
    // so the panel cannot tell whether the run succeeded or failed.
    // Showing ✔ for 8s on a run the user just saw fail (via the
    // inline tool result) would be a confusing lie.
    const ghost = agentEntry({
      agentId: 'ghost-1',
      subagentType: 'editor',
      description: 'editor: long-gone foreground task',
      status: 'running',
    });
    const { config } = makeRegistryConfig([]);
    const { lastFrame } = renderPanel({ entries: [ghost], config });
    let frame = lastFrame() ?? '';
    expect(frame).toContain('editor');
    expect(frame).toContain('long-gone foreground task');
    // The synthesis sets status='completed' for the visibility-window
    // logic but flags `synthesized: true` so the row renders the
    // neutral `·` glyph instead of the success `✔`.
    expect(frame).toContain('(0/1)');
    expect(frame).not.toContain('✔');
    expect(frame).toContain('·');
    // After the visibility window the row evicts and the panel hides.
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    frame = lastFrame() ?? '';
    expect(frame).toBe('');
  });

  it('escapes ANSI control codes in user-controlled strings', () => {
    // `subagentType` (subagent config) and `recentActivities[].description`
    // (LLM-generated) can carry ANSI escape sequences. Without
    // sanitization they bleed through Ink's <Text> and corrupt the
    // panel chrome (color overrides, cursor moves, screen clears).
    // HistoryItemDisplay applies `escapeAnsiCtrlCodes` for the same
    // reason; the panel must do the same.
    const malicious = '[31mEVIL[0m';
    const { lastFrame } = renderPanel({
      entries: [
        agentEntry({
          agentId: 'ansi-1',
          subagentType: malicious,
          description: `${malicious}: scan ${malicious} repo`,
          recentActivities: [{ name: 'Glob', description: malicious, at: 0 }],
        }),
      ],
    });
    const frame = lastFrame() ?? '';
    // Raw escape sequence MUST NOT appear; the JSON-string-escaped
    // form (visible literal ``) is acceptable since it's
    // inert at the terminal level.
    expect(frame).not.toContain('[31m');
    expect(frame).not.toContain('[0m');
    // The visible word survives the escaping (the wrapper became
    // visible literals, the payload didn't disappear).
    expect(frame).toContain('EVIL');
  });

  it('keeps the success glyph for entries the registry still tracks (non-synthesized)', () => {
    // Sibling assertion to the synthesized case above — when the
    // registry HAS the entry (an authentic completed transition,
    // e.g. a background subagent reaching `complete()`), the panel
    // should keep rendering the green ✔. The neutral glyph is
    // synthesis-only.
    const real = agentEntry({
      agentId: 'real-1',
      subagentType: 'researcher',
      description: 'researcher: real completion',
      status: 'completed',
      startTime: -3_000,
      endTime: 0,
    });
    const { config } = makeRegistryConfig([real]);
    const { lastFrame } = renderPanel({ entries: [real], config });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✔');
    expect(frame).not.toContain('·');
  });

  it('keeps terminal snapshots visible until the TTL even when the registry forgot them', () => {
    // Cancelled / failed foreground subagents go through
    // `cancel`/`fail` (which stamp `endTime` and emit statusChange)
    // followed by `unregisterForeground` (which deletes silently).
    // The snap captures the real `endTime`, so the panel must keep
    // it on screen until the visibility window expires — dropping
    // immediately would contradict the "brief terminal visibility"
    // contract the synthesized-completion path also relies on.
    const cancelled = agentEntry({
      agentId: 'cancelled-1',
      subagentType: 'researcher',
      description: 'researcher: was cancelled then unregistered',
      status: 'cancelled',
      startTime: -2_000,
      endTime: 0, // fresh terminal at fake-time 0
    });
    const { config } = makeRegistryConfig([]);
    const { lastFrame } = renderPanel({ entries: [cancelled], config });
    let frame = lastFrame() ?? '';
    // Within the window the row stays on screen with the cancelled
    // glyph (✖, warning color routing — see status-icon test).
    expect(frame).toContain('was cancelled');
    expect(frame).toContain('✖');
    // After TERMINAL_VISIBLE_MS the row evicts and the panel hides.
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    frame = lastFrame() ?? '';
    expect(frame).toBe('');
  });

  it('drops rows where the snapshot is terminal AND has no endTime', () => {
    // Defensive: terminal status without endTime is an upstream
    // invariant violation (`complete`/`fail`/`cancel` always stamp
    // endTime). Drop rather than render an entry the visibility
    // window has no way to evict.
    const broken = agentEntry({
      agentId: 'broken-1',
      subagentType: 'researcher',
      description: 'researcher: malformed snapshot',
      status: 'failed',
      endTime: undefined,
    });
    const { config } = makeRegistryConfig([]);
    const { lastFrame } = renderPanel({ entries: [broken], config });
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
