/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import type { Config } from '@qwen-code/qwen-code-core';
import { BackgroundTasksDialog } from './BackgroundTasksDialog.js';
import {
  BackgroundTaskViewProvider,
  useBackgroundTaskViewActions,
  useBackgroundTaskViewState,
} from '../../contexts/BackgroundTaskViewContext.js';
import { ConfigContext } from '../../contexts/ConfigContext.js';
import {
  type AgentDialogEntry,
  type DreamDialogEntry,
  useBackgroundTaskView,
  type DialogEntry,
} from '../../hooks/useBackgroundTaskView.js';
import { useKeypress } from '../../hooks/useKeypress.js';

vi.mock('../../hooks/useBackgroundTaskView.js', () => ({
  useBackgroundTaskView: vi.fn(),
  // Re-export the helper so Dialog renderers can still resolve it under the
  // mocked module. Inline impl keeps the test independent of the hook
  // module while preserving the discriminator-based id contract.
  entryId: (entry: DialogEntry): string => {
    switch (entry.kind) {
      case 'agent':
        return entry.agentId;
      case 'shell':
        return entry.shellId;
      case 'monitor':
        return entry.monitorId;
      case 'dream':
        return entry.dreamId;
      default: {
        const _exhaustive: never = entry;
        throw new Error(
          `entryId: unknown DialogEntry kind: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  },
}));

vi.mock('../../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

const mockedUseBackgroundTaskView = vi.mocked(useBackgroundTaskView);
const mockedUseKeypress = vi.mocked(useKeypress);

function entry(overrides: Partial<AgentDialogEntry> = {}): AgentDialogEntry {
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

function dreamEntry(
  overrides: Partial<DreamDialogEntry> = {},
): DreamDialogEntry {
  return {
    kind: 'dream',
    dreamId: 'd-1',
    status: 'running',
    startTime: 0,
    sessionCount: 7,
    progressText: 'Scheduled managed auto-memory dream.',
    ...overrides,
  };
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

interface ProbeHandle {
  actions: ReturnType<typeof useBackgroundTaskViewActions>;
  state: ReturnType<typeof useBackgroundTaskViewState>;
  setEntries: (next: readonly DialogEntry[]) => void;
}

interface Harness {
  cancel: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  abandon: ReturnType<typeof vi.fn>;
  monitorCancel: ReturnType<typeof vi.fn>;
  dreamCancelTask: ReturnType<typeof vi.fn>;
  setEntries: (next: readonly DialogEntry[]) => void;
  pressKey: (key: { name?: string; sequence?: string }) => void;
  call: (fn: () => void) => void;
  lastFrame: () => string | undefined;
  probe: { current: ProbeHandle | null };
}

function setup(initial: readonly DialogEntry[]): Harness {
  const handlers: Array<(key: { name?: string; sequence?: string }) => void> =
    [];
  mockedUseKeypress.mockImplementation((cb, opts) => {
    if (opts?.isActive !== false) handlers.push(cb as never);
  });

  const cancel = vi.fn();
  const resume = vi.fn();
  const abandon = vi.fn();
  const monitorCancel = vi.fn();
  const dreamCancelTask = vi.fn();
  // Stub registry that resolves `.get(agentId)` against the current entries
  // snapshot — the dialog now re-reads agent entries via `.get()` to pick up
  // live activity/stats mutations the snapshot misses.
  let currentEntries: readonly DialogEntry[] = initial;
  const config = {
    getBackgroundTaskRegistry: () => ({
      cancel,
      setActivityChangeCallback: vi.fn(),
      get: (id: string) => {
        const match = currentEntries.find(
          (e) => e.kind === 'agent' && e.agentId === id,
        );
        return match;
      },
    }),
    getMonitorRegistry: () => ({
      cancel: monitorCancel,
      // Resolve `.get(monitorId)` against the snapshot so the dialog's
      // `selectedEntry` re-resolution path works for monitor kind too.
      get: (id: string) => {
        const match = currentEntries.find(
          (e) => e.kind === 'monitor' && e.monitorId === id,
        );
        return match;
      },
    }),
    getMemoryManager: () => ({
      cancelTask: dreamCancelTask,
    }),
    resumeBackgroundAgent: resume,
    abandonBackgroundAgent: abandon,
  } as unknown as Config;

  const handle: { current: ProbeHandle | null } = { current: null };

  // Wrapper holds the entries in React state so updates propagate normally.
  // The hook mock is bound to this wrapper via the closure below.
  function Harness() {
    const [entries, setEntries] = useState(initial);
    mockedUseBackgroundTaskView.mockImplementation(() => ({ entries }));
    return (
      <ConfigContext.Provider value={config}>
        <BackgroundTaskViewProvider config={config}>
          <Probe entriesSetter={setEntries} />
          <BackgroundTasksDialog
            availableTerminalHeight={30}
            terminalWidth={80}
          />
        </BackgroundTaskViewProvider>
      </ConfigContext.Provider>
    );
  }

  function Probe({
    entriesSetter,
  }: {
    entriesSetter: (e: readonly DialogEntry[]) => void;
  }) {
    handle.current = {
      actions: useBackgroundTaskViewActions(),
      state: useBackgroundTaskViewState(),
      setEntries: entriesSetter,
    };
    return null;
  }

  const { lastFrame } = render(<Harness />);

  return {
    cancel,
    resume,
    abandon,
    monitorCancel,
    dreamCancelTask,
    setEntries(next) {
      handlers.length = 0;
      currentEntries = next;
      act(() => handle.current!.setEntries(next));
    },
    pressKey(key) {
      // Real `useKeypress` unbinds the previous callback on rerender, so
      // only the most recently registered closure should run. Calling all
      // accumulated handlers misses state updates that happened between
      // renders (the older closures see stale state) — the symptom looks
      // like a re-render race in production code that doesn't exist.
      act(() => {
        const latest = handlers[handlers.length - 1];
        if (latest) latest(key);
      });
    },
    call(fn) {
      act(() => fn());
    },
    lastFrame,
    probe: handle,
  };
}

describe('BackgroundTasksDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits to list mode when the running entry being viewed flips to a terminal status', () => {
    const running = entry({ agentId: 'a', status: 'running' });
    const h = setup([running]);

    h.call(() => h.probe.current!.actions.openDialog());
    h.call(() => h.probe.current!.actions.enterDetail());
    expect(h.probe.current!.state.dialogMode).toBe('detail');

    h.setEntries([{ ...running, status: 'completed' }]);

    expect(h.probe.current!.state.dialogMode).toBe('list');
  });

  it('exits to list mode after cancelling the running entry being viewed in detail', () => {
    const running = entry({ agentId: 'a', status: 'running' });
    const h = setup([running]);

    h.call(() => h.probe.current!.actions.openDialog());
    h.call(() => h.probe.current!.actions.enterDetail());
    expect(h.probe.current!.state.dialogMode).toBe('detail');

    h.pressKey({ sequence: 'x' });
    expect(h.cancel).toHaveBeenCalledWith('a');

    // Registry would push the cancelled status; simulate that update.
    h.setEntries([{ ...running, status: 'cancelled' }]);

    expect(h.probe.current!.state.dialogMode).toBe('list');
  });

  it('routes monitor cancel via monitorRegistry.cancel(monitorId)', () => {
    // Pin the monitor-cancel branch in `cancelSelected` — flipping it to
    // anything else (e.g. shell's `requestCancel`) would silently break,
    // since neither task_stop nor the dialog-test mocks fail loudly on
    // the wrong method name.
    const mon = monitorEntry({ monitorId: 'mon-zzz', status: 'running' });
    const h = setup([mon]);

    h.call(() => h.probe.current!.actions.openDialog());
    h.call(() => h.probe.current!.actions.enterDetail());
    expect(h.probe.current!.state.dialogMode).toBe('detail');

    h.pressKey({ sequence: 'x' });
    expect(h.monitorCancel).toHaveBeenCalledWith('mon-zzz');
    // Agent registry's cancel must NOT be called for a monitor entry —
    // belt-and-braces guard against the kind switch falling through.
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('keeps detail mode when an already-terminal entry is opened (no spurious fallback)', () => {
    const done = entry({ agentId: 'a', status: 'completed' });
    const h = setup([done]);

    h.call(() => h.probe.current!.actions.openDialog());
    h.call(() => h.probe.current!.actions.enterDetail());
    expect(h.probe.current!.state.dialogMode).toBe('detail');

    // The auto-fallback ref must only trigger on a running → terminal
    // transition. Re-rendering with a fresh terminal entry must not evict
    // the user from detail.
    h.setEntries([{ ...done }]);
    expect(h.probe.current!.state.dialogMode).toBe('detail');
  });

  it('foreground cancel requires two `x` presses to confirm (one-press is a no-op)', () => {
    // Foreground entries block the parent's tool-call: cancelling one ends
    // the current turn with a partial result for that subagent. The dialog
    // gates the destructive action behind a confirm step so the user can't
    // wipe out their turn with a stray keypress.
    const fg = entry({
      agentId: 'fg-1',
      status: 'running',
      flavor: 'foreground',
    });
    const h = setup([fg]);

    h.call(() => h.probe.current!.actions.openDialog());

    h.pressKey({ sequence: 'x' });
    expect(h.cancel).not.toHaveBeenCalled();

    h.pressKey({ sequence: 'x' });
    expect(h.cancel).toHaveBeenCalledWith('fg-1');
  });

  it('background cancel still fires on the first `x` press (no confirm)', () => {
    // Backwards compatibility: the existing background-only cancel UX
    // stays one-shot. Adding a confirm there would regress every workflow
    // that relies on quickly cancelling a long-running async agent.
    const bg = entry({
      agentId: 'bg-1',
      status: 'running',
      flavor: 'background',
    });
    const h = setup([bg]);

    h.call(() => h.probe.current!.actions.openDialog());

    h.pressKey({ sequence: 'x' });
    expect(h.cancel).toHaveBeenCalledWith('bg-1');
  });

  it('ignores `x` on a terminal foreground entry (no arm, no cancel call)', () => {
    // A foreground entry briefly stays visible after settling but before
    // the tool-call's finally path unregisters it. The dialog's hint
    // footer drops "x stop" once status leaves 'running', but without
    // gating handleCancelKey itself, the first `x` would still arm a
    // confirm step on the (now-terminal) entry — surfacing a misleading
    // "x again to confirm stop" line that does nothing.
    const completed = entry({
      agentId: 'fg-done',
      status: 'completed',
      flavor: 'foreground',
    });
    const h = setup([completed]);

    h.call(() => h.probe.current!.actions.openDialog());

    h.pressKey({ sequence: 'x' });
    expect(h.lastFrame()).not.toContain('x again to confirm stop');

    h.pressKey({ sequence: 'x' });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('detail-mode left clears any armed foreground cancel before exiting', () => {
    // Detail-mode `x` arms the foreground confirm step on the focused
    // entry. If the user presses `left` to back out without confirming,
    // the armed state must NOT carry into list mode — otherwise the
    // hint bar still shows "x again to confirm stop" and the next `x`
    // unintentionally cancels the run.
    const fg = entry({
      agentId: 'fg-1',
      status: 'running',
      flavor: 'foreground',
    });
    const h = setup([fg]);

    h.call(() => h.probe.current!.actions.openDialog());
    h.call(() => h.probe.current!.actions.enterDetail());

    h.pressKey({ sequence: 'x' });
    h.pressKey({ name: 'left' });
    expect(h.probe.current!.state.dialogMode).toBe('list');

    // Back in list mode, the next `x` arms again rather than confirming
    // a stale armed state inherited from detail mode.
    h.pressKey({ sequence: 'x' });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('Esc backs out of an armed foreground cancel without closing the dialog', () => {
    const fg = entry({
      agentId: 'fg-1',
      status: 'running',
      flavor: 'foreground',
    });
    const h = setup([fg]);

    h.call(() => h.probe.current!.actions.openDialog());

    h.pressKey({ sequence: 'x' });
    h.pressKey({ name: 'escape' });
    // Dialog still open — Esc on the armed cancel resets the confirm
    // state instead of nuking the dialog.
    expect(h.probe.current!.state.dialogOpen).toBe(true);

    // After the Esc reset, the next `x` arms again rather than confirming.
    h.pressKey({ sequence: 'x' });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('clamps selectedIndex when entries shrink', () => {
    const a = entry({ agentId: 'a' });
    const b = entry({ agentId: 'b' });
    const c = entry({ agentId: 'c' });
    const h = setup([a, b, c]);

    h.call(() => h.probe.current!.actions.openDialog());
    h.call(() => h.probe.current!.actions.moveSelectionDown());
    h.call(() => h.probe.current!.actions.moveSelectionDown());
    expect(h.probe.current!.state.selectedIndex).toBe(2);

    h.setEntries([a]);
    expect(h.probe.current!.state.selectedIndex).toBe(0);

    h.setEntries([]);
    expect(h.probe.current!.state.selectedIndex).toBe(0);
  });

  it('resumes a paused task with the r key', () => {
    const paused = entry({ agentId: 'a', status: 'paused' });
    const h = setup([paused]);

    h.call(() => h.probe.current!.actions.openDialog());
    h.pressKey({ sequence: 'r' });

    expect(h.resume).toHaveBeenCalledWith('a');
  });

  it('abandons a paused task with the x key', () => {
    const paused = entry({ agentId: 'a', status: 'paused' });
    const h = setup([paused]);

    h.call(() => h.probe.current!.actions.openDialog());
    h.pressKey({ sequence: 'x' });

    expect(h.abandon).toHaveBeenCalledWith('a');
  });

  it('does not resume blocked paused tasks and surfaces the blocked reason', () => {
    const blocked = entry({
      agentId: 'a',
      status: 'paused',
      resumeBlockedReason: 'Legacy fork bootstrap transcript is missing.',
    });
    const h = setup([blocked]);

    h.call(() => h.probe.current!.actions.openDialog());
    expect(h.lastFrame()).not.toContain('r resume');
    expect(h.lastFrame()).toContain('x abandon');

    h.pressKey({ sequence: 'r' });
    expect(h.resume).not.toHaveBeenCalled();

    h.call(() => h.probe.current!.actions.enterDetail());
    const detailFrame = h.lastFrame();
    expect(detailFrame).toContain('Resume blocked');
    expect(detailFrame).toContain(
      'Legacy fork bootstrap transcript is missing.',
    );
    expect(detailFrame).not.toContain('r resume');
  });

  it('still allows resume for paused tasks that only have a stale error', () => {
    const paused = entry({
      agentId: 'a',
      status: 'paused',
      error: 'Temporary resume setup failed.',
    });
    const h = setup([paused]);

    h.call(() => h.probe.current!.actions.openDialog());
    expect(h.lastFrame()).toContain('r resume');

    h.pressKey({ sequence: 'r' });
    expect(h.resume).toHaveBeenCalledWith('a');

    h.call(() => h.probe.current!.actions.enterDetail());
    const detailFrame = h.lastFrame();
    expect(detailFrame).toContain('Error');
    expect(detailFrame).toContain('Temporary resume setup failed.');
    expect(detailFrame).toContain('r resume');
  });

  describe('MonitorDetailBody render branches', () => {
    function openMonitorDetail(monitorOverrides: Partial<DialogEntry> = {}) {
      const mon = monitorEntry({
        monitorId: 'mon-z',
        description: 'watch app logs',
        command: 'tail -f app.log',
        ...monitorOverrides,
      });
      const h = setup([mon]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      return h.lastFrame() ?? '';
    }

    it('renders title from description and shows Command block', () => {
      const f = openMonitorDetail();
      expect(f).toContain('Monitor');
      expect(f).toContain('watch app logs');
      expect(f).toContain('Command');
      expect(f).toContain('tail -f app.log');
    });

    it('renders pid when defined, omits when undefined', () => {
      expect(
        openMonitorDetail({ pid: 4242 } as Partial<DialogEntry>),
      ).toContain('pid 4242');
      expect(openMonitorDetail()).not.toContain('pid ');
    });

    it('uses singular "1 event" / plural "N events"', () => {
      const f1 = openMonitorDetail({ eventCount: 1 } as Partial<DialogEntry>);
      expect(f1).toContain('1 event');
      // Guard against false positive — substring "1 event" also matches "1 events".
      expect(f1).not.toContain('1 events');

      const f5 = openMonitorDetail({ eventCount: 5 } as Partial<DialogEntry>);
      expect(f5).toContain('5 events');
    });

    it('renders droppedLines only when > 0', () => {
      expect(
        openMonitorDetail({ droppedLines: 0 } as Partial<DialogEntry>),
      ).not.toContain('dropped');
      expect(
        openMonitorDetail({ droppedLines: 3 } as Partial<DialogEntry>),
      ).toContain('3 dropped');
    });

    it('renders exitCode in subtitle when defined', () => {
      expect(
        openMonitorDetail({
          status: 'completed',
          exitCode: 0,
        } as Partial<DialogEntry>),
      ).toContain('exit 0');
      expect(
        openMonitorDetail({
          status: 'completed',
          exitCode: 1,
        } as Partial<DialogEntry>),
      ).toContain('exit 1');
    });

    it('renders Error block for failed status', () => {
      const f = openMonitorDetail({
        status: 'failed',
        error: 'spawn ENOENT',
      } as Partial<DialogEntry>);
      expect(f).toContain('Error');
      expect(f).toContain('spawn ENOENT');
      // The auto-stop label must not appear on a `failed` entry — the
      // two error-block branches share a render slot, so a regression
      // collapsing them would silently swap the user-facing wording.
      expect(f).not.toContain('Stopped because');
    });

    it('renders "Stopped because" block for completed with auto-stop reason', () => {
      const f = openMonitorDetail({
        status: 'completed',
        error: 'Max events reached',
      } as Partial<DialogEntry>);
      expect(f).toContain('Stopped because');
      expect(f).toContain('Max events reached');
    });

    it('omits the error block entirely when error is undefined', () => {
      const f = openMonitorDetail({ status: 'completed' });
      expect(f).not.toContain('Error');
      expect(f).not.toContain('Stopped because');
    });
  });

  describe('dream entries', () => {
    // Coverage for the dream task kind in the unified pill / dialog
    // plumbing — list rendering, detail body, hint visibility, and
    // cancellation routing. Mirrors the agent / shell / monitor
    // coverage profile so each kind has parity in this test file.
    it('renders the [dream] row with session count in list mode', () => {
      const h = setup([dreamEntry({ sessionCount: 7 })]);
      h.call(() => h.probe.current!.actions.openDialog());

      const f = h.lastFrame() ?? '';
      expect(f).toContain('[dream]');
      expect(f).toContain('memory consolidation');
      expect(f).toContain('reviewing 7 sessions');
    });

    it('renders DreamDetailBody with sessions / progress / topics on detail view', () => {
      const h = setup([
        dreamEntry({
          status: 'completed',
          sessionCount: 5,
          progressText: 'Managed auto-memory dream completed.',
          touchedTopics: ['user', 'project', 'feedback'],
        }),
      ]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());

      const f = h.lastFrame() ?? '';
      expect(f).toContain('Dream');
      expect(f).toContain('Sessions reviewing');
      expect(f).toContain('5');
      expect(f).toContain('Progress');
      expect(f).toContain('Managed auto-memory dream completed.');
      expect(f).toContain('Topics touched (3)');
      expect(f).toContain('user');
      expect(f).toContain('project');
      expect(f).toContain('feedback');
    });

    it('shows the "x stop" hint for a running dream entry', () => {
      const h = setup([dreamEntry({ status: 'running' })]);
      h.call(() => h.probe.current!.actions.openDialog());
      const f = h.lastFrame() ?? '';
      expect(f).toContain('x stop');
    });

    it("routes 'x' on a running dream to MemoryManager.cancelTask(dreamId)", () => {
      // Pin the dream-cancel branch in `cancelSelected` — flipping it
      // to anything else (e.g. shell's `requestCancel`) would silently
      // break the only path the user has to stop a runaway dream
      // consolidation, since the hint already advertises the action.
      const h = setup([dreamEntry({ dreamId: 'd-zzz', status: 'running' })]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.pressKey({ sequence: 'x' });
      expect(h.dreamCancelTask).toHaveBeenCalledWith('d-zzz');
      // Belt-and-braces — the registry-side cancel paths must not fire
      // for a dream entry, otherwise the wrong AbortController gets
      // signalled.
      expect(h.cancel).not.toHaveBeenCalled();
      expect(h.monitorCancel).not.toHaveBeenCalled();
    });

    it('omits the topics block entirely while the dream is still running', () => {
      // Topics only get populated via metadata.touchedTopics on
      // completion; mid-run the body should hide the section instead of
      // rendering an empty header.
      const h = setup([dreamEntry({ status: 'running', touchedTopics: [] })]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const f = h.lastFrame() ?? '';
      expect(f).not.toContain('Topics touched');
    });

    it('renders the Error block on failed status with a "+ Stopped because" verb', () => {
      // Dream failures need to surface — they are the user's only signal
      // that consolidation didn't happen as expected (success path
      // already produces a memory_saved toast in useGeminiStream).
      const h = setup([
        dreamEntry({
          status: 'failed',
          error: 'Dream agent failed: model timeout',
        }),
      ]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const f = h.lastFrame() ?? '';
      expect(f).toContain('Failed');
      expect(f).toContain('Error');
      expect(f).toContain('Dream agent failed: model timeout');
    });

    it('caps visible topics at 8 and renders a "+N more" tail for overflow', () => {
      // Real consolidations can touch many memory files; the body must
      // not push the hint footer off-screen. Cap mirrors MAX_TOPICS in
      // DreamDetailBody.
      const manyTopics = Array.from({ length: 12 }, (_, i) => `topic-${i + 1}`);
      const h = setup([
        dreamEntry({ status: 'completed', touchedTopics: manyTopics }),
      ]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const f = h.lastFrame() ?? '';
      // First 8 visible.
      expect(f).toContain('topic-1');
      expect(f).toContain('topic-8');
      // Past the cap — must NOT be inlined.
      expect(f).not.toContain('topic-9');
      expect(f).not.toContain('topic-12');
      // Tail summary.
      expect(f).toContain('+4 more');
      // Header still reflects the full count, not the capped slice.
      expect(f).toContain('Topics touched (12)');
    });
  });
});
