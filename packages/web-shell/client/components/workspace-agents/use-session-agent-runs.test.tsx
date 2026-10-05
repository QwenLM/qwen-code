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
  pruneRunFrames,
  settledAgentRunKey,
  TERMINAL_FRAME_GRACE_MS,
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
    let map = applyRunFrame(new Map(), frame('r1', { activityAt: 200 }), 0, 0);
    map = applyRunFrame(
      map,
      frame('r1', { activityAt: 100, outputText: 'old' }),
      0,
      1,
    );
    expect(map.get('r1')?.frame.outputText).toBeUndefined();
    map = applyRunFrame(
      map,
      frame('r1', { status: 'completed', activityAt: 300 }),
      5,
      2,
    );
    expect(map.get('r1')?.terminalAt).toBe(5);
    const replayed = applyRunFrame(
      map,
      frame('r1', { status: 'running', activityAt: 400 }),
      6,
      3,
    );
    expect(replayed).toBe(map);
  });

  it('drops a run once its reply is in the transcript, or after the grace period', () => {
    let map = applyRunFrame(new Map(), frame('r1'), 0, 0);
    map = applyRunFrame(map, frame('r2', { status: 'failed' }), 1_000, 1);
    expect(pruneRunFrames(map, new Set(), 2_000)).toBe(map);
    expect([...pruneRunFrames(map, new Set(['r1']), 2_000).keys()]).toEqual([
      'r2',
    ]);
    expect([
      ...pruneRunFrames(map, new Set(), 1_000 + TERMINAL_FRAME_GRACE_MS).keys(),
    ]).toEqual(['r1']);
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
      frame('r1', { status: 'completed', activityAt: 300, outputText: 'ok' }),
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
