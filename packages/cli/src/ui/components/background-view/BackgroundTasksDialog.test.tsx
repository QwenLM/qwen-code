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

vi.mock('../../hooks/useBackgroundTaskView.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../hooks/useBackgroundTaskView.js')
    >();
  // Only the hook itself is stubbed (the Harness feeds entries directly);
  // the module's pure helpers (entryId, compareActiveThenTerminal) keep
  // their real implementations so renderer behavior can't silently drift
  // from production — a hand-inlined copy here previously risked exactly
  // that.
  return { ...actual, useBackgroundTaskView: vi.fn() };
});

vi.mock('../../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

const mockedUseBackgroundTaskView = vi.mocked(useBackgroundTaskView);
const mockedUseKeypress = vi.mocked(useKeypress);

function entry(overrides: Partial<AgentDialogEntry> = {}): AgentDialogEntry {
  return {
    id: 'a',
    kind: 'agent',
    agentId: 'a',
    description: 'desc',
    isBackgrounded: true,
    status: 'running',
    startTime: 0,
    abortController: new AbortController(),
    outputFile: '/tmp/agent.jsonl',
    outputOffset: 0,
    notified: false,
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
  pressKey: (key: { name?: string; sequence?: string; ctrl?: boolean }) => void;
  pressKeyBroadcast: (key: {
    name?: string;
    sequence?: string;
    ctrl?: boolean;
  }) => void;
  call: (fn: () => void) => void;
  lastFrame: () => string | undefined;
  probe: { current: ProbeHandle | null };
}

function setup(
  initial: readonly DialogEntry[],
  availableTerminalHeight = 30,
): Harness {
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
      resolvePendingApproval: vi.fn(),
      setActivityChangeCallback: vi.fn(),
      get: (id: string) => {
        const match = currentEntries.find(
          (e) => e.kind === 'agent' && e.agentId === id,
        );
        return match;
      },
      // The detail view lists an agent's children via `.getAll()`
      // (Sub-agents section of the nested-agent tree display).
      getAll: () => currentEntries.filter((e) => e.kind === 'agent'),
    }),
    getMaxSubagentDepth: () => 5,
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
            availableTerminalHeight={availableTerminalHeight}
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
    pressKeyBroadcast(key) {
      act(() => {
        for (const handler of [...handlers]) {
          handler(key);
        }
      });
    },
    call(fn) {
      handlers.length = 0;
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
      isBackgrounded: false,
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
      isBackgrounded: true,
    });
    const h = setup([bg]);

    h.call(() => h.probe.current!.actions.openDialog());

    h.pressKey({ sequence: 'x' });
    expect(h.cancel).toHaveBeenCalledWith('bg-1');
  });

  it('foreground child of a background parent cancels on the first `x` (chain-aware confirm)', () => {
    // The two-step confirm exists to protect the USER's turn. A nested
    // foreground child awaited by a background parent blocks that parent,
    // not the user — same chain verdict as the [blocking] row prefix —
    // so it cancels one-shot like any background entry.
    const bgParent = entry({
      id: 'p',
      agentId: 'p',
      description: 'bg parent work',
      isBackgrounded: true,
    });
    const fgChild = entry({
      id: 'c',
      agentId: 'c',
      description: 'awaited child work',
      status: 'running',
      isBackgrounded: false,
      parentAgentId: 'p',
      depth: 1,
    });
    const h = setup([bgParent, fgChild]);

    h.call(() => h.probe.current!.actions.openDialog());
    h.call(() => h.probe.current!.actions.moveSelectionDown());

    h.pressKey({ sequence: 'x' });
    expect(h.cancel).toHaveBeenCalledWith('c');
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
      isBackgrounded: false,
    });
    const h = setup([completed]);

    h.call(() => h.probe.current!.actions.openDialog());

    h.pressKey({ sequence: 'x' });
    expect(h.lastFrame()).not.toContain('x again to confirm stop');

    h.pressKey({ sequence: 'x' });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('sanitizes ANSI/control sequences in an entry label (terminal-injection guard)', () => {
    // A /fork directive is user-controlled and flows verbatim into the entry
    // description; a raw escape sequence must not reach the terminal when the
    // dialog renders the row.
    const ESC = '';
    const malicious = entry({
      agentId: 'fork-evil',
      subagentType: 'fork',
      description: `r${ESC}[2Jx`,
      prompt: `prompt ${ESC}[31mred`,
      recentActivities: [
        {
          at: 1,
          name: 'Shell',
          description: `activity ${ESC}[?25lhide`,
        },
      ],
    });
    const h = setup([malicious]);
    h.call(() => h.probe.current!.actions.openDialog());

    const frame = h.lastFrame() ?? '';
    // The raw clear-screen escape (ESC + "[2J") never reaches the frame...
    expect(frame).not.toContain(`${ESC}[2J`);
    // ...it survives only as inert, escaped text.
    expect(frame).toContain('[2J');

    h.call(() => h.probe.current!.actions.enterDetail());
    const detailFrame = h.lastFrame() ?? '';
    expect(detailFrame).not.toContain(`${ESC}[2J`);
    expect(detailFrame).not.toContain(`${ESC}[31m`);
    expect(detailFrame).not.toContain(`${ESC}[?25l`);
    expect(detailFrame).toContain('[31m');
    expect(detailFrame).toContain('[?25l');
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
      isBackgrounded: false,
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

  it('lets ask-user-question approvals own all keyboard input in detail mode', () => {
    const questionApproval: NonNullable<
      AgentDialogEntry['pendingApprovals']
    >[number] = {
      callId: 'ask-1',
      name: 'ask_user_question',
      description: 'choose',
      confirmationDetails: {
        type: 'ask_user_question',
        title: 'Need input',
        questions: [
          {
            question: 'Pick one',
            header: 'Choice',
            options: [
              {
                label: 'Alpha',
                description: 'Use alpha.',
              },
              {
                label: 'Beta',
                description: 'Use beta.',
              },
            ],
          },
        ],
      } as NonNullable<
        AgentDialogEntry['pendingApprovals']
      >[number]['confirmationDetails'],
      respond: vi.fn(),
      at: Date.now(),
    };
    const bg = entry({
      agentId: 'bg-question',
      pendingApprovals: [questionApproval],
    });
    const h = setup([bg]);

    h.call(() => h.probe.current!.actions.openDialog());
    h.call(() => h.probe.current!.actions.enterDetail());

    expect(h.probe.current!.state.dialogMode).toBe('detail');
    expect(h.probe.current!.state.dialogOpen).toBe(true);

    h.pressKeyBroadcast({ sequence: 'x' });
    h.pressKeyBroadcast({ name: 'left' });
    h.pressKeyBroadcast({ name: 'space' });

    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.probe.current!.state.dialogMode).toBe('detail');
    expect(h.probe.current!.state.dialogOpen).toBe(true);
  });

  it('Esc backs out of an armed foreground cancel without closing the dialog', () => {
    const fg = entry({
      agentId: 'fg-1',
      status: 'running',
      isBackgrounded: false,
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

  it('moves list selection with Ctrl+N/P readline aliases', () => {
    const h = setup([
      entry({ agentId: 'a' }),
      entry({ agentId: 'b' }),
      entry({ agentId: 'c' }),
    ]);

    h.call(() => h.probe.current!.actions.openDialog());
    expect(h.probe.current!.state.selectedIndex).toBe(0);

    h.pressKey({ name: 'n', sequence: '\u000E', ctrl: true });
    expect(h.probe.current!.state.selectedIndex).toBe(1);

    h.pressKey({ name: 'p', sequence: '\u0010', ctrl: true });
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

  // ── R2 #15: WorkflowDetailBody budget chip rendering ────────────────

  function workflowEntry(overrides: Partial<DialogEntry> = {}): DialogEntry {
    const base = {
      id: 'wf_test1234',
      kind: 'workflow' as const,
      runId: 'wf_test1234',
      description: 'demo',
      meta: null,
      status: 'completed' as const,
      startTime: 0,
      endTime: 5_000,
      outputFile: '',
      outputOffset: 0,
      notified: false,
      abortController: new AbortController(),
      currentPhase: null,
      phases: ['Plan'] as string[],
      agentsDispatched: 0,
      agentsCompleted: 0,
      recentLogs: [] as string[],
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: new Map<string | null, number>(),
    };
    return { ...base, ...overrides } as unknown as DialogEntry;
  }

  describe('WorkflowDetailBody budget chip (R2 #15)', () => {
    function openWorkflowDetail(entries: readonly DialogEntry[]) {
      const h = setup(entries);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      return h;
    }

    it('renders the M/N token chip and capped per-phase totals', () => {
      const perPhase = new Map<string | null, number>([['Plan', 3_500]]);
      const wf = workflowEntry({
        tokensSpent: 3_500,
        tokenBudgetTotal: 10_000,
        perPhaseTokens: perPhase,
      });
      const h = openWorkflowDetail([wf]);
      const f = h.lastFrame() ?? '';
      // R1 #7: formatTokenCount renders 3500 as `3.5k`, 10000 as `10k`.
      expect(f).toContain('3.5k/10k tokens');
      expect(f).toContain('Plan');
      expect(f).toContain('3.5kt');
    });

    it('renders plain spent (no cap) when uncapped and zero per-phase chips suppressed', () => {
      const wf = workflowEntry({
        tokensSpent: 850,
        tokenBudgetTotal: null,
        perPhaseTokens: new Map<string | null, number>([['Plan', 0]]),
      });
      const h = openWorkflowDetail([wf]);
      const f = h.lastFrame() ?? '';
      expect(f).toContain('850 tokens');
      // Uncapped: no slash form on the budget chip.
      expect(f).not.toMatch(/\d+\/\d+ tokens/);
      // Zero per-phase tally: no `· 0t` chip noise on the Plan row.
      expect(f).not.toMatch(/Plan.*0t/);
    });

    it('hides the token chip entirely when both spend and cap are zero/null', () => {
      const wf = workflowEntry({
        tokensSpent: 0,
        tokenBudgetTotal: null,
        perPhaseTokens: new Map<string | null, number>(),
      });
      const h = openWorkflowDetail([wf]);
      const f = h.lastFrame() ?? '';
      // Subtitle has elapsed + phase count, but no `tokens` chip.
      expect(f).not.toMatch(/tokens/);
    });

    it('R1 #6 + R2 #15: surfaces null-sentinel per-phase tokens as `(no phase)` row', () => {
      const perPhase = new Map<string | null, number>([
        [null, 420], // pre-phase spend
        ['Plan', 1_100],
      ]);
      const wf = workflowEntry({
        tokensSpent: 1_520,
        tokenBudgetTotal: 5_000,
        perPhaseTokens: perPhase,
      });
      const h = openWorkflowDetail([wf]);
      const f = h.lastFrame() ?? '';
      // formatTokenCount: 1520 → "1.5k", 5000 → "5.0k" (< 10000 keeps one decimal).
      expect(f).toContain('1.5k/5.0k tokens');
      expect(f).toContain('(no phase)');
      expect(f).toContain('420t');
    });
  });

  describe('nested sub-agent display', () => {
    // Entries are passed pre-grouped (parent before child) — in production
    // useBackgroundTaskView applies reorderChildrenUnderParents before the
    // snapshot reaches the dialog; this suite mocks the hook, so grouping
    // is the fixture's job and the dialog only owns indent/labels.
    it('indents a nested child row with ↳ in the list', () => {
      const parent = entry({
        id: 'p',
        agentId: 'p',
        description: 'parent work',
      });
      const child = entry({
        id: 'c',
        agentId: 'c',
        description: 'child work',
        parentAgentId: 'p',
        depth: 1,
      });
      const h = setup([parent, child]);
      h.call(() => h.probe.current!.actions.openDialog());
      const frame = h.lastFrame() ?? '';
      expect(frame).toContain('↳');
      expect(frame.indexOf('parent work')).toBeLessThan(
        frame.indexOf('child work'),
      );
    });

    it('tags [blocking] only when the whole chain is foreground', () => {
      const bgParent = entry({
        id: 'p',
        agentId: 'p',
        description: 'bg parent work',
        isBackgrounded: true,
      });
      const fgChild = entry({
        id: 'c',
        agentId: 'c',
        description: 'awaited child work',
        isBackgrounded: false,
        parentAgentId: 'p',
        depth: 1,
      });
      const fgTop = entry({
        id: 't',
        agentId: 't',
        description: 'top-level fg work',
        isBackgrounded: false,
      });
      const h = setup([bgParent, fgChild, fgTop]);
      h.call(() => h.probe.current!.actions.openDialog());
      const lines = (h.lastFrame() ?? '').split('\n');
      const childLine = lines.find((l) => l.includes('awaited child')) ?? '';
      const topLine = lines.find((l) => l.includes('top-level fg')) ?? '';
      // The child blocks its background parent, not the user's turn.
      expect(childLine).not.toContain('[blocking]');
      // Regression guard: a plain foreground top-level agent keeps the tag.
      expect(topLine).toContain('[blocking]');
    });

    it('shows the level badge and Parent breadcrumb in a nested child detail', () => {
      const parent = entry({
        id: 'p',
        agentId: 'p',
        description: 'parent work',
        subagentType: 'researcher',
      });
      const child = entry({
        id: 'c',
        agentId: 'c',
        description: 'child work',
        parentAgentId: 'p',
        depth: 1,
      });
      const h = setup([parent, child]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.moveSelectionDown());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = h.lastFrame() ?? '';
      expect(frame).toContain('level 2 of 5');
      expect(frame).toContain('Parent');
      expect(frame).toContain('main › researcher — parent work');
    });

    it('lists live children in the parent detail Sub-agents section', () => {
      const parent = entry({
        id: 'p',
        agentId: 'p',
        description: 'parent work',
      });
      const child = entry({
        id: 'c',
        agentId: 'c',
        description: 'child work',
        parentAgentId: 'p',
        depth: 1,
        subagentType: 'explore',
      });
      const h = setup([parent, child]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = h.lastFrame() ?? '';
      expect(frame).toContain('Sub-agents');
      expect(frame).toContain('○\uFE0E explore — child work');
      // The parent itself is top-level: no Parent section, no badge.
      expect(frame).not.toContain('level 1 of');
    });

    it('sorts the Sub-agents roster active-first so the cap cannot hide running children', () => {
      // getAll() is insertion-ordered (oldest spawn first). With more than
      // five children, the raw order would fill the capped roster with the
      // oldest completed children and hide the newest still-running one —
      // the row the user most wants to see. Same two-bucket ordering as
      // the main list (compareActiveThenTerminal).
      const parent = entry({
        id: 'p',
        agentId: 'p',
        description: 'parent work',
      });
      const doneChildren = [1, 2, 3, 4, 5].map((n) =>
        entry({
          id: `done-${n}`,
          agentId: `done-${n}`,
          description: `done-${n} work`,
          status: 'completed',
          startTime: n,
          endTime: 100 + n,
          parentAgentId: 'p',
          depth: 1,
        }),
      );
      const runningChild = entry({
        id: 'live-6',
        agentId: 'live-6',
        description: 'live-6 work',
        status: 'running',
        startTime: 6,
        parentAgentId: 'p',
        depth: 1,
      });
      const h = setup([parent, ...doneChildren, runningChild]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = h.lastFrame() ?? '';
      expect(frame).toContain('Sub-agents');
      // The running child is visible despite being the 6th by insertion…
      expect(frame).toContain('live-6 work');
      // …and the oldest-finished child is the one that fell past the cap.
      expect(frame).not.toContain('done-1 work');
      expect(frame).toContain('1 more');
    });

    it('falls back to the launch-time parent name when the parent is gone', () => {
      const orphan = entry({
        id: 'c',
        agentId: 'c',
        description: 'child work',
        parentAgentId: 'gone',
        parentName: 'researcher',
        depth: 1,
      });
      const h = setup([orphan]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = h.lastFrame() ?? '';
      expect(frame).toContain('researcher');
      expect(frame).toContain('no longer running');
    });
  });

  describe('subagent observability (issue #6569)', () => {
    it('renders the newest activity in full across wrapped lines instead of truncating', () => {
      // A command far wider than the 80-col harness terminal. The tail
      // marker can only appear in the frame if the live row wraps instead
      // of truncating to one line.
      const longCommand = `git log --format='%H %s' --since='2 weeks ago' -- packages/core/src/agents packages/cli/src/ui/components/background-view END_OF_COMMAND`;
      const running = entry({
        recentActivities: [
          { name: 'read_file', description: 'old-read.ts', at: 1 },
          { name: 'run_shell_command', description: longCommand, at: 2 },
        ],
      });
      const h = setup([running]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = (h.lastFrame() ?? '').replace(/\n\s*/g, ' ');
      expect(frame).toContain('END_OF_COMMAND');
    });

    it('still truncates non-live activity rows to one line', () => {
      const longOldCommand = `find . -name '*.ts' -not -path './node_modules/*' -exec grep -l 'subagent' {} + OLD_COMMAND_TAIL`;
      const running = entry({
        recentActivities: [
          { name: 'run_shell_command', description: longOldCommand, at: 1 },
          { name: 'read_file', description: 'src/index.ts', at: 2 },
        ],
      });
      const h = setup([running]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = (h.lastFrame() ?? '').replace(/\n\s*/g, ' ');
      expect(frame).not.toContain('OLD_COMMAND_TAIL');
      expect(frame).toContain('src/index.ts');
    });

    it('shows the Transcript section with the JSONL trace path', () => {
      const running = entry({ outputFile: '/tmp/subagents/agent-abc.jsonl' });
      const h = setup([running]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = h.lastFrame() ?? '';
      expect(frame).toContain('Transcript');
      expect(frame).toContain('/tmp/subagents/agent-abc.jsonl');
    });

    it('renders up to 10 progress rows in the detail view', () => {
      const activities = Array.from({ length: 12 }, (_, i) => ({
        name: 'read_file',
        description: `file-${i}.ts`,
        at: i,
      }));
      const h = setup([entry({ recentActivities: activities })]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = h.lastFrame() ?? '';
      expect(frame).not.toContain('file-1.ts');
      expect(frame).toContain('file-2.ts');
      expect(frame).toContain('file-11.ts');
    });

    it('shows all rows when the buffer holds exactly 10 activities', () => {
      const activities = Array.from({ length: 10 }, (_, i) => ({
        name: 'read_file',
        description: `file-${i}.ts`,
        at: i,
      }));
      const h = setup([entry({ recentActivities: activities })]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = h.lastFrame() ?? '';
      expect(frame).toContain('file-0.ts');
      expect(frame).toContain('file-9.ts');
    });

    it('drops only the oldest row at 11 activities', () => {
      const activities = Array.from({ length: 11 }, (_, i) => ({
        name: 'read_file',
        description: `file-${i}.ts`,
        at: i,
      }));
      const h = setup([entry({ recentActivities: activities })]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = h.lastFrame() ?? '';
      expect(frame).not.toContain('file-0.ts');
      expect(frame).toContain('file-1.ts');
      expect(frame).toContain('file-10.ts');
    });

    it('omits the Progress section entirely when there are no activities', () => {
      const h = setup([entry({ recentActivities: [] })]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = h.lastFrame() ?? '';
      expect(frame).not.toContain('Progress');
    });

    it('keeps the live command visible in a short terminal by dropping older rows', () => {
      // Regression: `MaxSizedBox` clips from the bottom, so a full 10-row
      // history used to push the live command (and Transcript) off a short
      // terminal — the opposite of what this view is for. The oldest rows
      // must yield to the live row instead.
      const activities = [
        ...Array.from({ length: 9 }, (_, i) => ({
          name: 'read_file',
          description: `history-${i}.ts`,
          at: i,
        })),
        {
          name: 'run_shell_command',
          description: 'git log --oneline LIVE_COMMAND_MARKER',
          at: 9,
        },
      ];
      const h = setup([entry({ recentActivities: activities })], 20);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = (h.lastFrame() ?? '').replace(/\n\s*/g, ' ');
      // The live row survives...
      expect(frame).toContain('LIVE_COMMAND_MARKER');
      // ...at the cost of the oldest history row.
      expect(frame).not.toContain('history-0.ts');
    });

    it('keeps the live row visible with a full 10-row history and no transcript (short terminal)', () => {
      // The [Critical] reviewer scenario: maxHeight=14 (availableTerminalHeight
      // 20 - 6 chrome), 10 activities, no outputFile/parent/children. The
      // Progress spacer+header are budgeted, so the live row must still render.
      const activities = [
        ...Array.from({ length: 9 }, (_, i) => ({
          name: 'read_file',
          description: `hist-${i}.ts`,
          at: i,
        })),
        {
          name: 'run_shell_command',
          description: 'git log ONLY_LIVE_ROW_MARKER',
          at: 9,
        },
      ];
      const h = setup(
        [entry({ outputFile: '', recentActivities: activities })],
        20,
      );
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = (h.lastFrame() ?? '').replace(/\n\s*/g, ' ');
      expect(frame).toContain('ONLY_LIVE_ROW_MARKER');
    });

    it('renders the full transcript path (wraps instead of truncating)', () => {
      const longPath =
        '/home/runner/.qwen/projects/some-workspace-slug/subagents/2f9c1a7b-1234-4a5b-8c9d-abcdef012345/agent-general-purpose-call-9.jsonl';
      const running = entry({ outputFile: longPath });
      const h = setup([running]);
      h.call(() => h.probe.current!.actions.openDialog());
      h.call(() => h.probe.current!.actions.enterDetail());
      const frame = (h.lastFrame() ?? '').replace(/\n\s*/g, '');
      // The whole path is present (the tail is not clipped off).
      expect(frame).toContain('agent-general-purpose-call-9.jsonl');
    });
  });
});
