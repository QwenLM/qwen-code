// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupReact, flushReact, mountReact } from '../../test/reactHarness';
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
  afterEach(() => cleanupReact());

  let latest: ReturnType<typeof useManagedSession> | undefined;
  function Probe({ provider }: { provider: ManagedAgentProvider }) {
    latest = useManagedSession(provider, 'client-1', 'session-1');
    return null;
  }

  function deterministicBackoff(): () => void {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    return () => random.mockRestore();
  }

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

    mountReact(<Probe provider={provider} />);

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

  it('grows the failure backoff exponentially toward the jittered cap', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      expect([0, 1, 2, 3, 4, 5, 6].map(failureRetryDelayMs)).toEqual([
        3_000, 4_500, 7_500, 13_500, 16_500, 16_500, 16_500,
      ]);
    } finally {
      random.mockRestore();
    }
  });

  it('resets the stream backoff after every delivered event', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let calls = 0;
      const subscribeEvents = vi.fn(async function* (
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        calls++;
        if (calls <= 3) {
          yield event(calls);
          throw new TypeError('connection reset by peer');
        }
        yield event(4);
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      });
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      for (let step = 0; step < 3; step++)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3_000);
        });
      expect(
        subscribeEvents.mock.calls.map(([, options]) => options.lastEventId),
      ).toEqual([1, 1, 2, 3]);
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('stops resubscribing when the stream answers with a non-retryable error', async () => {
    vi.useFakeTimers();
    try {
      const subscribeEvents = vi.fn(async function* () {
        yield event(1);
        throw Object.assign(new Error('session gone'), { status: 404 });
      });
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      expect(subscribeEvents).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(subscribeEvents).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an expired credential instead of going terminal', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        async *subscribeEvents(
          _sessionId: string,
          request: { lastEventId?: number; signal?: AbortSignal },
        ) {
          calls++;
          if (calls === 1) {
            yield event(1);
            throw Object.assign(new Error('Unauthorized'), { status: 401 });
          }
          yield event(2);
          await new Promise((resolve) =>
            request.signal?.addEventListener('abort', resolve),
          );
        },
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      expect(calls).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(calls).toBe(2);
      expect(latest?.stoppedReason).toBeUndefined();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resubscribes an unchanged cursor after a retryable stream failure', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const subscribeEvents = vi.fn(async function* (
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        calls++;
        if (calls === 1)
          throw Object.assign(new Error('server busy'), { status: 500 });
        yield event(2);
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      });
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      expect(subscribeEvents).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(subscribeEvents).toHaveBeenCalledTimes(2);
      expect(subscribeEvents.mock.calls[1]?.[1].lastEventId).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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
      mountReact(<Probe provider={provider} />);
      await flushReact();
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
        request: { lastEventId?: number; signal?: AbortSignal },
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
      mountReact(<Probe provider={provider} />);
      await flushReact();
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
          request: { lastEventId?: number; signal?: AbortSignal },
        ) {
          yield event(1);
          await new Promise((resolve) =>
            request.signal?.addEventListener('abort', resolve),
          );
        },
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
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

  it('resets the stream backoff when only replayed duplicates arrive then the connection dies', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let calls = 0;
      const subscribeEvents = vi.fn(async function* (
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        calls++;
        if (calls <= 3) {
          yield event(1);
          throw new TypeError('connection reset by peer');
        }
        yield event(2);
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      });
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      for (let step = 0; step < 3; step++)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3_000);
        });
      expect(subscribeEvents).toHaveBeenCalledTimes(4);
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('resets the stream backoff for a long-lived connection that delivered nothing', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      const subscribeEvents = vi.fn(
        (
          _sessionId: string,
          request: { lastEventId?: number; signal?: AbortSignal },
        ) => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<ManagedAgentSessionEvent>>(
                (resolve, reject) => {
                  const timer = setTimeout(
                    () => reject(new TypeError('idle timeout by gateway')),
                    4_000,
                  );
                  request.signal?.addEventListener(
                    'abort',
                    () => {
                      clearTimeout(timer);
                      resolve({ done: true, value: undefined });
                    },
                    { once: true },
                  );
                },
              ),
          }),
        }),
      );
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(subscribeEvents).toHaveBeenCalledTimes(3);
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('backs off the failing gap snapshot on its own ladder while the stream keeps delivering', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi
          .fn()
          .mockResolvedValueOnce(transcript(1))
          .mockRejectedValue(
            Object.assign(new Error('server busy'), { status: 500 }),
          ),
        subscribeEvents: vi.fn(async function* () {
          yield event(2);
          yield { ...event(2), type: 'stream_gap' };
        }),
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(provider.subscribeEvents).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_999);
      });
      expect(provider.subscribeEvents).toHaveBeenCalledTimes(3);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_999);
      });
      expect(provider.subscribeEvents).toHaveBeenCalledTimes(4);
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('re-enters the stream loop at rung zero after a transient bootstrap failure', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      const subscribeEvents = vi.fn(
        (
          _sessionId: string,
          _request: { lastEventId?: number; signal?: AbortSignal },
        ) => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Promise.reject(
                Object.assign(new Error('server busy'), { status: 500 }),
              ),
          }),
        }),
      );
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error('server busy'), { status: 500 }),
          )
          .mockResolvedValue(transcript(1)),
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      expect(subscribeEvents).toHaveBeenCalledTimes(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(subscribeEvents).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(subscribeEvents).toHaveBeenCalledTimes(2);
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('reconnects on the healthy cadence after a clean stream close', async () => {
    vi.useFakeTimers();
    try {
      const subscribeEvents = vi.fn(
        (
          _sessionId: string,
          _request: { lastEventId?: number; signal?: AbortSignal },
        ) => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Promise.resolve({
                done: true,
                value: undefined,
              } as IteratorResult<ManagedAgentSessionEvent>),
          }),
        }),
      );
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      expect(subscribeEvents).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_999);
      });
      expect(subscribeEvents).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(subscribeEvents).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the summary poll to its healthy cadence after one transient failure', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      const getSession = vi
        .fn()
        .mockResolvedValueOnce({ sessionId: 'session-1' })
        .mockRejectedValueOnce(
          Object.assign(new Error('server busy'), { status: 500 }),
        )
        .mockResolvedValue({ sessionId: 'session-1' });
      const subscribeEvents = vi.fn(
        (
          _sessionId: string,
          request: { lastEventId?: number; signal?: AbortSignal },
        ) => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<ManagedAgentSessionEvent>>((resolve) =>
                request.signal?.addEventListener(
                  'abort',
                  () => resolve({ done: true, value: undefined }),
                  { once: true },
                ),
              ),
          }),
        }),
      );
      const provider = {
        getSession,
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      expect(getSession).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(getSession).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_999);
      });
      expect(getSession).toHaveBeenCalledTimes(3);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(getSession).toHaveBeenCalledTimes(4);
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('keeps the terminal stop reason visible while the stream keeps delivering', async () => {
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
          request: { lastEventId?: number; signal?: AbortSignal },
        ) {
          yield event(2);
          await new Promise((resolve) => setTimeout(resolve, 3_500));
          yield event(3);
          await new Promise((resolve) =>
            request.signal?.addEventListener('abort', resolve),
          );
        },
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(getSession).toHaveBeenCalledTimes(2);
      expect(latest?.error).toBeUndefined();
      expect(latest?.stoppedReason).toBe('session gone');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires the terminal stop reason after a later authoritative read succeeds', async () => {
    vi.useFakeTimers();
    try {
      const getSession = vi
        .fn()
        .mockResolvedValueOnce({ sessionId: 'session-1' })
        .mockRejectedValueOnce(
          Object.assign(new Error('session gone'), { status: 404 }),
        )
        .mockResolvedValue({ sessionId: 'session-1' });
      const provider = {
        getSession,
        getTranscript: vi
          .fn()
          .mockResolvedValueOnce(transcript(1))
          .mockResolvedValue(transcript(2)),
        async *subscribeEvents(
          _sessionId: string,
          request: { lastEventId?: number; signal?: AbortSignal },
        ) {
          yield event(2);
          await new Promise((resolve) => setTimeout(resolve, 4_000));
          yield { ...event(2), type: 'stream_gap' };
          await new Promise((resolve) =>
            request.signal?.addEventListener('abort', resolve),
          );
        },
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      expect(latest?.stoppedReason).toBe('session gone');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_400);
      });
      expect(latest?.stoppedReason).toBeUndefined();
      expect(getSession).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('climbs the reconnect ladder across consecutive undelivered stream failures', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      const subscribeEvents = vi.fn(
        (
          _sessionId: string,
          _request: { lastEventId?: number; signal?: AbortSignal },
        ) => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Promise.reject(
                Object.assign(new Error('server busy'), { status: 500 }),
              ),
          }),
        }),
      );
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      expect(subscribeEvents).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(subscribeEvents).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(subscribeEvents).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_999);
      });
      expect(subscribeEvents).toHaveBeenCalledTimes(3);
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('backs the bootstrap retry off across consecutive rejections', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error('server busy'), { status: 500 }),
          )
          .mockRejectedValueOnce(
            Object.assign(new Error('server busy'), { status: 500 }),
          )
          .mockResolvedValue(transcript(1)),
        async *subscribeEvents(
          _sessionId: string,
          request: { lastEventId?: number; signal?: AbortSignal },
        ) {
          yield event(1);
          await new Promise((resolve) =>
            request.signal?.addEventListener('abort', resolve),
          );
        },
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      expect(provider.getTranscript).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(provider.getTranscript).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(provider.getTranscript).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_001);
      });
      expect(provider.getTranscript).toHaveBeenCalledTimes(3);
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('records a definite gap-snapshot answer but keeps streaming behind its ladder', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi
          .fn()
          .mockResolvedValueOnce(transcript(1))
          .mockRejectedValue(
            Object.assign(new Error('history pruned'), { status: 404 }),
          ),
        subscribeEvents: vi.fn(async function* () {
          yield event(2);
          yield { ...event(2), type: 'stream_gap' };
        }),
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      expect(provider.subscribeEvents).toHaveBeenCalledTimes(1);
      expect(latest?.stoppedReason).toBe('history pruned');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(provider.subscribeEvents).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_999);
      });
      expect(provider.subscribeEvents).toHaveBeenCalledTimes(3);
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2]);
      expect(latest?.stoppedReason).toBe('history pruned');
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('resets the gap-snapshot ladder after a healed outage', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi
          .fn()
          .mockResolvedValueOnce(transcript(1))
          .mockRejectedValueOnce(
            Object.assign(new Error('server busy'), { status: 500 }),
          )
          .mockRejectedValueOnce(
            Object.assign(new Error('server busy'), { status: 500 }),
          )
          .mockResolvedValueOnce(transcript(2))
          .mockRejectedValue(
            Object.assign(new Error('server busy'), { status: 500 }),
          ),
        subscribeEvents: vi.fn(async function* () {
          yield event(2);
          yield { ...event(2), type: 'stream_gap' };
        }),
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(provider.subscribeEvents).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_999);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(provider.subscribeEvents).toHaveBeenCalledTimes(4);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(provider.subscribeEvents).toHaveBeenCalledTimes(5);
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });
});
