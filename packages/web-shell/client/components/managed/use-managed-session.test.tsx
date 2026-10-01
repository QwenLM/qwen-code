// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionEvent,
  ManagedAgentSessionTranscript,
} from './managed-agent-provider';
import { failureRetryDelayMs, useManagedSession } from './use-managed-session';

function event(
  id: number,
  type: ManagedAgentSessionEvent['type'] = 'assistant_delta',
): ManagedAgentSessionEvent {
  return {
    id,
    at: id,
    type,
    sessionId: 'session-1',
    turnId: 'turn-1',
    data: { text: String(id) },
  };
}

function transcript(lastEventId: number): ManagedAgentSessionTranscript {
  return {
    events: Array.from({ length: lastEventId }, (_, index) => event(index + 1)),
    lastEventId,
  };
}

describe('useManagedSession', () => {
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
  });

  it('reloads the transcript after a stream gap and resumes after it', async () => {
    const cursors: Array<number | undefined> = [];
    const getTranscript = vi
      .fn<ManagedAgentProvider['getTranscript']>()
      .mockResolvedValueOnce(transcript(2))
      .mockResolvedValue(transcript(9));
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        cursors.push(request.lastEventId);
        if (cursors.length === 1) {
          // What the Java provider yields for a resync frame.
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        yield event(10);
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }

    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() => expect(cursors).toEqual([2, 9]));
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]),
    );
    expect(getTranscript).toHaveBeenCalledTimes(2);
  });

  it('bounds the failure backoff between the three-second floor and the attempt cap', () => {
    const caps = [3_000, 6_000, 12_000, 24_000, 30_000, 30_000, 30_000];
    caps.forEach((cap, failures) => {
      for (let sample = 0; sample < 50; sample++) {
        const delay = failureRetryDelayMs(failures);
        expect(delay).toBeGreaterThanOrEqual(3_000);
        expect(delay).toBeLessThanOrEqual(cap);
      }
    });
  });

  it('stops the bootstrap retry loop on a non-retryable failure', async () => {
    vi.useFakeTimers();
    try {
      const getSession = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('session gone'), { status: 404 }),
        );
      const getTranscript = vi
        .fn()
        .mockResolvedValue({ events: [], lastEventId: 0 });
      const provider = {
        getSession,
        getTranscript,
        subscribeEvents: vi.fn(),
      } as unknown as ManagedAgentProvider;
      let latest: ReturnType<typeof useManagedSession> | undefined;
      function Probe() {
        latest = useManagedSession(provider, 'client-1', 'session-1');
        return null;
      }
      root = createRoot(document.createElement('div'));
      act(() => root!.render(<Probe />));
      await act(async () => {});
      expect(getSession).toHaveBeenCalledTimes(1);
      expect(latest?.error).toBe('session gone');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(getTranscript).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off and retries the bootstrap snapshot after a server failure', async () => {
    vi.useFakeTimers();
    try {
      const getSession = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('server busy'), { status: 500 }),
        )
        .mockResolvedValue({ sessionId: 'session-1' });
      const subscribeEvents = vi.fn(async function* (
        _sessionId: string,
        request: { signal?: AbortSignal },
      ) {
        yield event(4);
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      });
      const getTranscript = vi.fn().mockResolvedValue(transcript(3));
      const provider = {
        getSession,
        getTranscript,
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      function Probe() {
        useManagedSession(provider, 'client-1', 'session-1');
        return null;
      }
      root = createRoot(document.createElement('div'));
      act(() => root!.render(<Probe />));
      await act(async () => {});
      expect(getTranscript).toHaveBeenCalledTimes(1);
      for (let step = 0; step < 6; step++)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      expect(getTranscript).toHaveBeenCalledTimes(2);
      await act(async () => {});
      expect(subscribeEvents).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a three-second cadence while healthy and stops on a non-retryable summary failure', async () => {
    vi.useFakeTimers();
    try {
      const getSession = vi
        .fn()
        .mockResolvedValueOnce({ sessionId: 'session-1' })
        .mockRejectedValue(
          Object.assign(new Error('session gone'), { status: 404 }),
        );
      const provider = {
        getSession,
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        async *subscribeEvents(
          _sessionId: string,
          request: { signal?: AbortSignal },
        ) {
          yield event(1);
          await new Promise((resolve) =>
            request.signal?.addEventListener('abort', resolve),
          );
        },
      } as unknown as ManagedAgentProvider;
      function Probe() {
        useManagedSession(provider, 'client-1', 'session-1');
        return null;
      }
      root = createRoot(document.createElement('div'));
      act(() => root!.render(<Probe />));
      await act(async () => {});
      expect(getSession).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      expect(getSession).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(getSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
