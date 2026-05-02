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
  useBackgroundTaskView,
  type DialogEntry,
} from '../../hooks/useBackgroundTaskView.js';
import { useKeypress } from '../../hooks/useKeypress.js';

vi.mock('../../hooks/useBackgroundTaskView.js', () => ({
  useBackgroundTaskView: vi.fn(),
  // Re-export the helper so Dialog renderers can still resolve it under the
  // mocked module. Inline impl keeps the test independent of the hook
  // module while preserving the discriminator-based id contract.
  entryId: (entry: DialogEntry): string =>
    entry.kind === 'agent' ? entry.agentId : entry.shellId,
}));

vi.mock('../../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

const mockedUseBackgroundTaskView = vi.mocked(useBackgroundTaskView);
const mockedUseKeypress = vi.mocked(useKeypress);

function entry(overrides: Partial<AgentDialogEntry> = {}): DialogEntry {
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

interface ProbeHandle {
  actions: ReturnType<typeof useBackgroundTaskViewActions>;
  state: ReturnType<typeof useBackgroundTaskViewState>;
  setEntries: (next: readonly DialogEntry[]) => void;
}

interface Harness {
  cancel: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  abandon: ReturnType<typeof vi.fn>;
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
    setEntries(next) {
      handlers.length = 0;
      currentEntries = next;
      act(() => handle.current!.setEntries(next));
    },
    pressKey(key) {
      act(() => {
        for (const h of handlers) h(key);
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
});
