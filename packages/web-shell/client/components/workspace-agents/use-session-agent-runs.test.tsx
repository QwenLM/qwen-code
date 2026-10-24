// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonTranscriptBlock,
  SessionAgentEventFrame,
  SessionAgentRunFrame,
} from '@qwen-code/sdk/daemon';
import type { AgentStreamState } from './agent-events';
import type { SessionAgentsApi } from './session-agents-api';
import {
  applyRunFrame,
  isSettledRunFrame,
  pruneRunFrames,
  settledAgentRunKey,
  useSessionAgentRuns,
} from './use-session-agent-runs';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const frame = (
  runId: string,
  over: Partial<SessionAgentRunFrame> = {},
): SessionAgentRunFrame => ({
  type: 'run',
  sessionId: 's1',
  runId,
  author: { agentId: `a-${runId}`, name: `agent-${runId}` },
  status: 'running',
  activityAt: 100,
  ...over,
});

describe('run frame bookkeeping', () => {
  it('keeps the newest frame and never revives a finished run', () => {
    let map = applyRunFrame(new Map(), frame('r1', { activityAt: 200 }), 0);
    map = applyRunFrame(
      map,
      frame('r1', { activityAt: 100, outputText: 'old' }),
      1,
    );
    expect(map.get('r1')?.frame.outputText).toBeUndefined();
    map = applyRunFrame(
      map,
      frame('r1', { status: 'completed', activityAt: 300, recorded: false }),
      2,
    );
    expect(map.get('r1')?.frame.status).toBe('completed');
    expect(map.get('r1')?.order).toBe(0);
    const replayed = applyRunFrame(
      map,
      frame('r1', { status: 'running', activityAt: 400 }),
      3,
    );
    expect(replayed).toBe(map);
  });

  it('reads the record state of a terminal frame as the contract says', () => {
    // Pending record, or retryable: the card stays.
    expect(
      isSettledRunFrame(frame('r', { status: 'completed', recorded: false })),
    ).toBe(false);
    expect(
      isSettledRunFrame(
        frame('r', { status: 'failed', recorded: false, retryable: true }),
      ),
    ).toBe(false);
    // Recorded, or no record coming (dismissed, retried, cancelled queued).
    expect(
      isSettledRunFrame(frame('r', { status: 'completed', recorded: true })),
    ).toBe(true);
    expect(isSettledRunFrame(frame('r', { status: 'cancelled' }))).toBe(true);
    expect(
      isSettledRunFrame(
        frame('r', { status: 'failed', retriedAsRunId: 'r-2' }),
      ),
    ).toBe(true);
    // Live runs carry no record state.
    expect(isSettledRunFrame(frame('r', { status: 'running' }))).toBe(false);
  });

  it('keeps a settled run settled against a stale snapshot', () => {
    const map = applyRunFrame(
      new Map(),
      frame('r1', {
        status: 'completed',
        outputText: 'done',
        recorded: true,
        activityAt: 300,
      }),
      0,
    );
    // Slimmed: the output now renders from the transcript record.
    expect(map.get('r1')).toMatchObject({ settled: true });
    expect(map.get('r1')?.frame.outputText).toBeUndefined();
    // A snapshot polled before the record landed, delivered late.
    const stale = applyRunFrame(
      map,
      frame('r1', { status: 'completed', recorded: false, activityAt: 300 }),
      1,
    );
    expect(stale).toBe(map);
  });

  it('keeps a pending record however long it takes, and settles it from the transcript', () => {
    let map = applyRunFrame(new Map(), frame('r1'), 0);
    map = applyRunFrame(
      map,
      frame('r2', { status: 'failed', outputText: 'partial', recorded: false }),
      1,
    );
    // No clock: a run whose record is pending stays as it is.
    expect(pruneRunFrames(map, new Set())).toBe(map);
    const pruned = pruneRunFrames(map, new Set(['r2']));
    expect(pruned.get('r2')).toMatchObject({ settled: true });
    expect(pruned.get('r2')?.frame.outputText).toBeUndefined();
    expect(pruned.get('r1')).toBe(map.get('r1'));
    expect(pruneRunFrames(pruned, new Set(['r2']))).toBe(pruned);
  });

  it('reads settled run ids from agent_message blocks only', () => {
    const blocks = [
      {
        id: 'b1',
        kind: 'assistant',
        text: 'done',
        meta: {
          qwenAgentMessage: {
            kind: 'agent_message',
            runId: 'run-b',
            author: { agentId: 'a', name: 'a' },
          },
        },
      },
      {
        id: 'b2',
        kind: 'user',
        text: '@a',
        meta: { qwenAgentMessage: { kind: 'agent_mention', runId: 'x' } },
      },
      {
        id: 'b3',
        kind: 'assistant',
        text: 'plain',
      },
      {
        id: 'b4',
        kind: 'assistant',
        text: 'done',
        meta: { qwenAgentMessage: { kind: 'agent_message', runId: 'run-a' } },
      },
    ] as unknown as DaemonTranscriptBlock[];
    expect(settledAgentRunKey(blocks)).toBe('run-a\nrun-b');
  });
});

describe('useSessionAgentRuns', () => {
  let latest: ReturnType<typeof useSessionAgentRuns>;
  const mounted: Array<{ root: ReturnType<typeof createRoot> }> = [];

  afterEach(() => {
    for (const { root } of mounted) act(() => root.unmount());
    mounted.length = 0;
  });

  function fakeApi(snapshot: SessionAgentRunFrame[]) {
    let emit: ((event: SessionAgentEventFrame) => void) | undefined;
    let state: ((state: AgentStreamState) => void) | undefined;
    const unsubscribe = vi.fn();
    const api: SessionAgentsApi = {
      listRuns: vi.fn().mockResolvedValue({ frames: snapshot }),
      mention: vi.fn(),
      cancelRun: vi.fn(),
      retryRun: vi.fn().mockResolvedValue({}),
      stopAll: vi.fn(),
      respondToPermission: vi.fn(),
      subscribe: vi.fn((_sessionId, onEvent, onState) => {
        emit = onEvent;
        state = onState;
        return unsubscribe;
      }),
    };
    return {
      api,
      unsubscribe,
      emit: (event: SessionAgentEventFrame) => act(() => emit?.(event)),
      setState: (next: AgentStreamState) => act(() => state?.(next)),
    };
  }

  function Probe(props: Parameters<typeof useSessionAgentRuns>[0]) {
    latest = useSessionAgentRuns(props);
    return null;
  }

  function mount(props: Parameters<typeof useSessionAgentRuns>[0]) {
    const root = createRoot(document.createElement('div'));
    mounted.push({ root });
    act(() => root.render(<Probe {...props} />));
    return (next: Parameters<typeof useSessionAgentRuns>[0]) =>
      act(() => root.render(<Probe {...next} />));
  }

  it('shows the snapshot, follows the stream, and hides a run once its reply is recorded', async () => {
    const stream = fakeApi([
      frame('r1', { status: 'queued', queuePosition: 1 }),
    ]);
    const rerender = mount({
      api: stream.api,
      sessionId: 's1',
      settledRunIds: new Set(),
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(latest.runs.map((run) => run.status)).toEqual(['queued']);
    expect(latest.anyLive).toBe(true);

    stream.emit(frame('r1', { status: 'running', activityAt: 200 }));
    stream.emit(
      frame('r1', {
        status: 'completed',
        activityAt: 300,
        outputText: 'ok',
        recorded: false,
      }),
    );
    // Finished, but its record may be deferred behind a main-model turn: the
    // output stays on screen.
    expect(latest.runs.map((run) => run.outputText)).toEqual(['ok']);
    expect(latest.anyLive).toBe(false);

    rerender({
      api: stream.api,
      sessionId: 's1',
      settledRunIds: new Set(['r1']),
    });
    expect(latest.runs).toEqual([]);
  });

  it('drops a finished run when its frame says recorded, before the transcript has it', async () => {
    const stream = fakeApi([]);
    mount({ api: stream.api, sessionId: 's1', settledRunIds: new Set() });
    const done = {
      status: 'completed' as const,
      activityAt: 300,
      outputText: 'ok',
    };
    stream.emit(frame('r1', { ...done, recorded: false }));
    expect(latest.runs).toHaveLength(1);
    stream.emit(frame('r1', { ...done, recorded: true, recordId: 'rec-1' }));
    expect(latest.runs).toEqual([]);
    // A late snapshot from before the record landed does not bring it back.
    stream.emit(frame('r1', { ...done, recorded: false }));
    expect(latest.runs).toEqual([]);
  });

  it('drops a run that will write no record (dismissed, retried, cancelled)', async () => {
    const stream = fakeApi([]);
    mount({ api: stream.api, sessionId: 's1', settledRunIds: new Set() });
    stream.emit(frame('r1', { status: 'queued' }));
    stream.emit(frame('r1', { status: 'cancelled', activityAt: 200 }));
    expect(latest.runs).toEqual([]);
  });

  it('keeps a pending record past any timer', async () => {
    vi.useFakeTimers();
    try {
      const stream = fakeApi([]);
      mount({ api: stream.api, sessionId: 's1', settledRunIds: new Set() });
      stream.setState('open');
      stream.emit(
        frame('r1', { status: 'completed', activityAt: 300, recorded: false }),
      );
      await act(async () => {
        vi.advanceTimersByTime(60 * 60_000);
      });
      expect(latest.runs.map((run) => run.runId)).toEqual(['r1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a retryable run through the route and lets the new run take over', async () => {
    const stream = fakeApi([]);
    mount({ api: stream.api, sessionId: 's1', settledRunIds: new Set() });
    const restarted = frame('r1', {
      status: 'failed',
      activityAt: 300,
      error: 'daemon restarted',
      recorded: false,
      retryable: true,
    });
    stream.emit(restarted);
    expect(latest.runs.map((run) => run.runId)).toEqual(['r1']);

    await act(async () => {
      await latest.retry('r1');
    });
    expect(stream.api.retryRun).toHaveBeenCalledWith('s1', 'r1');
    expect(latest.runs).toEqual([]);
    // A snapshot polled before the retry does not bring the old card back.
    stream.emit(restarted);
    expect(latest.runs).toEqual([]);
    // The daemon's frames: the new run, and the old one's final frame.
    stream.emit(frame('r2', { status: 'queued', activityAt: 400 }));
    stream.emit(
      frame('r1', { status: 'failed', activityAt: 400, retriedAsRunId: 'r2' }),
    );
    expect(latest.runs.map((run) => run.runId)).toEqual(['r2']);
  });

  it('keeps the run when the retry is refused', async () => {
    const stream = fakeApi([]);
    vi.mocked(stream.api.retryRun).mockRejectedValue(new Error('gone'));
    mount({ api: stream.api, sessionId: 's1', settledRunIds: new Set() });
    stream.emit(
      frame('r1', { status: 'failed', recorded: false, retryable: true }),
    );
    await act(async () => {
      await expect(latest.retry('r1')).rejects.toThrow('gone');
    });
    expect(latest.runs.map((run) => run.runId)).toEqual(['r1']);
  });

  it('ignores frames of another session and resets on a session switch', async () => {
    const stream = fakeApi([]);
    const rerender = mount({
      api: stream.api,
      sessionId: 's1',
      settledRunIds: new Set(),
    });
    stream.emit(frame('other', { sessionId: 's2' }));
    expect(latest.runs).toEqual([]);
    stream.emit(frame('r1'));
    expect(latest.runs).toHaveLength(1);

    rerender({ api: stream.api, sessionId: 's2', settledRunIds: new Set() });
    expect(stream.unsubscribe).toHaveBeenCalled();
    expect(latest.runs).toEqual([]);
  });

  it('polls the snapshot while the stream is down', async () => {
    vi.useFakeTimers();
    try {
      const stream = fakeApi([]);
      mount({ api: stream.api, sessionId: 's1', settledRunIds: new Set() });
      expect(stream.api.listRuns).toHaveBeenCalledTimes(1);
      stream.setState('closed');
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(stream.api.listRuns).toHaveBeenCalledTimes(2);
      stream.setState('open');
      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });
      expect(stream.api.listRuns).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing without an API or a session', () => {
    const stream = fakeApi([]);
    mount({ api: stream.api, sessionId: undefined, settledRunIds: new Set() });
    mount({ api: undefined, sessionId: 's1', settledRunIds: new Set() });
    expect(stream.api.subscribe).not.toHaveBeenCalled();
    expect(latest.runs).toEqual([]);
  });
});
