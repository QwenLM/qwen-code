// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupReact, flushReact, mountReact } from '../../test/reactHarness';
import { createJavaManagedAgentProvider } from './java-managed-agent-provider';
import {
  corruptFrame as corrupt,
  javaDeltaEvent as javaDelta,
  javaSessionPayload,
  sseFrame,
} from './managed-agent-sse.test-fixtures';
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

  it('retires a session-leg verdict on the poll loop next success', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
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
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        async *subscribeEvents(
          _sessionId: string,
          request: { lastEventId?: number; signal?: AbortSignal },
        ) {
          yield event(2);
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
      expect(latest?.stoppedLeg).toBe('session');
      expect(latest?.error).toBeUndefined();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(latest?.stoppedReason).toBeUndefined();
      expect(latest?.stoppedLeg).toBeUndefined();
      expect(latest?.error).toBeUndefined();
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('restarts the loops after a session-leg bootstrap stop when a later read succeeds', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const provider = {
        getSession: vi
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error('session gone'), { status: 404 }),
          )
          .mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        async *subscribeEvents(
          _sessionId: string,
          request: { lastEventId?: number; signal?: AbortSignal },
        ) {
          calls++;
          yield event(2);
          await new Promise((resolve) =>
            request.signal?.addEventListener('abort', resolve),
          );
        },
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(latest?.stoppedReason).toBe('session gone');
      // The terminal stop also ended the bootstrap's in-flight read: the
      // skeleton and the loading line must not outlive the verdict.
      expect(latest?.loading).toBe(false);
      expect(calls).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_300);
      });
      expect(latest?.stoppedReason).toBeUndefined();
      expect(calls).toBe(1);
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a transcript-leg verdict while only session-leg reads succeed', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi
          .fn()
          .mockResolvedValueOnce(transcript(1))
          .mockRejectedValueOnce(
            Object.assign(new Error('history pruned'), { status: 404 }),
          )
          .mockResolvedValue(transcript(2)),
        subscribeEvents: vi.fn(async function* () {
          calls++;
          if (calls > 1) {
            await new Promise((resolve) => setTimeout(resolve, 120_000));
            return;
          }
          yield event(2);
          yield { ...event(2), type: 'stream_gap' };
        }),
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      expect(latest?.stoppedReason).toBe('history pruned');
      expect(latest?.stoppedLeg).toBe('transcript');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(provider.getSession.mock.calls.length).toBeGreaterThan(4);
      expect(latest?.stoppedReason).toBe('history pruned');
      expect(latest?.stoppedLeg).toBe('transcript');
      expect(latest?.loading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a transcript verdict standing through a session blip and its recovery', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      const getSession = vi
        .fn()
        .mockResolvedValueOnce({ sessionId: 'session-1' })
        .mockRejectedValueOnce(
          Object.assign(new Error('Not found'), { status: 404 }),
        )
        .mockResolvedValue({ sessionId: 'session-1' });
      const provider = {
        getSession,
        getTranscript: vi.fn(() =>
          Promise.reject(
            Object.assign(new Error('history pruned'), { status: 404 }),
          ),
        ),
        subscribeEvents: vi.fn(),
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.stoppedReason).toBe('history pruned');
      expect(latest?.stoppedLeg).toBe('transcript');
      // The session leg's definite blip lands inside this window: it is
      // recorded on its own slot but never displaces the standing
      // transcript verdict...
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      expect(latest?.stoppedReason).toBe('history pruned');
      expect(latest?.stoppedLeg).toBe('transcript');
      // No snapshot ever succeeded in this scenario, so the failure record
      // is the only writer that could have ended the bootstrap loading.
      expect(latest?.loading).toBe(false);
      // ...and the verdict is still standing after the session leg heals
      // and the re-armed bootstrap keeps climbing the transcript ladder.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(getSession.mock.calls.length).toBeGreaterThan(3);
      expect(latest?.stoppedReason).toBe('history pruned');
      expect(latest?.stoppedLeg).toBe('transcript');
      expect(provider.subscribeEvents).not.toHaveBeenCalled();
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('prefers the standing transcript verdict over a later session verdict', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      const getSession = vi
        .fn()
        .mockResolvedValueOnce({ sessionId: 'session-1' })
        .mockRejectedValue(
          Object.assign(new Error('Not found'), { status: 404 }),
        );
      const provider = {
        getSession,
        getTranscript: vi.fn(() =>
          Promise.reject(
            Object.assign(new Error('history pruned'), { status: 404 }),
          ),
        ),
        subscribeEvents: vi.fn(),
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.stoppedReason).toBe('history pruned');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_100);
      });
      // The session leg has answered the same definite 404 for rungs in a
      // row now — recorded on its own slot — but the standing transcript
      // verdict of the more specific authority outranks it.
      expect(latest?.stoppedReason).toBe('history pruned');
      expect(latest?.stoppedLeg).toBe('transcript');
      expect(provider.subscribeEvents).not.toHaveBeenCalled();
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('records a definite stream answer and keeps resubscribing behind its ladder', async () => {
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
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(subscribeEvents).toHaveBeenCalledTimes(2);
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('stream');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(subscribeEvents.mock.calls.length).toBeGreaterThan(10);
      expect(subscribeEvents.mock.calls.length).toBeLessThanOrEqual(45);
      expect(latest?.stoppedReason).toBe('session gone');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a definite stream verdict standing through later transient failures', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let subscribeCalls = 0;
      const subscribeEvents = vi.fn(async function* () {
        subscribeCalls += 1;
        yield event(1);
        if (subscribeCalls === 1)
          throw Object.assign(new Error('session gone'), { status: 404 });
        throw new TypeError('connection reset by peer');
      });
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('stream');
      // Every later call is a weaker transient failure on the same leg: it
      // must not downgrade the standing terminal verdict.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_000);
      });
      expect(subscribeCalls).toBeGreaterThan(2);
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('stream');
      expect(latest?.error).toBeUndefined();
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('retires a definite stream verdict once the stream delivers again', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let subscribeCalls = 0;
      const subscribeEvents = vi.fn(async function* (
        _sessionId: string,
        request: { signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          yield event(1);
          throw Object.assign(new Error('session gone'), { status: 404 });
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
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('stream');
      // The reconnect delivers a genuinely new frame: the stream retires
      // its own verdict — no other leg's success was involved.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      expect(subscribeCalls).toBe(2);
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2]);
      expect(latest?.stoppedReason).toBeUndefined();
      expect(latest?.stoppedLeg).toBeUndefined();
      expect(latest?.error).toBeUndefined();
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('expires a terminal stream verdict on an error-free replay-only reconnect', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let subscribeCalls = 0;
      const subscribeEvents = vi.fn(async function* (
        _sessionId: string,
        request: { signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          yield event(1);
          throw Object.assign(new Error('session gone'), { status: 404 });
        }
        // A live but idle session: the reconnect replays history only.
        yield event(1);
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
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('stream');
      // The reconnect opens at t=3000 and stays error-free: three seconds
      // of proof-of-life expires the terminal verdict it contradicts.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_100);
      });
      expect(subscribeCalls).toBe(2);
      expect(latest?.stoppedReason).toBeUndefined();
      expect(latest?.stoppedLeg).toBeUndefined();
      expect(latest?.error).toBeUndefined();
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('expires a terminal stream verdict on an error-free clean close', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let subscribeCalls = 0;
      const subscribeEvents = vi.fn(async function* (
        _sessionId: string,
        request: { signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          yield event(1);
          throw Object.assign(new Error('session gone'), { status: 404 });
        }
        if (subscribeCalls === 2) {
          // Replays history and closes without an error.
          yield event(1);
          return;
        }
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
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('stream');
      // The reconnect at t=3000 closes cleanly carrying nothing new: an
      // error-free answer is the leg's own success evidence. The third
      // attempt and its proof-of-life land outside this window — only the
      // clean close could have cleared the verdict.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      expect(subscribeCalls).toBe(2);
      expect(latest?.stoppedReason).toBeUndefined();
      expect(latest?.stoppedLeg).toBeUndefined();
      expect(latest?.error).toBeUndefined();
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('expires a terminal stream verdict when resyncs answer but never advance the cursor', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let subscribeCalls = 0;
      const subscribeEvents = vi.fn(async function* () {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          yield event(1);
          throw Object.assign(new Error('session gone'), { status: 404 });
        }
        yield { ...event(1), type: 'stream_gap' };
      });
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('stream');
      // Every resync answers with the same head: the stream leg keeps
      // answering, so its terminal verdict expires on the first stall, and
      // after three consecutive stalls the stall warning is what stands.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_100);
      });
      expect(subscribeCalls).toBeGreaterThanOrEqual(4);
      expect(latest?.stoppedReason).toBeUndefined();
      expect(latest?.stoppedLeg).toBeUndefined();
      expect(latest?.error).toMatch(/not advancing/);
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('restores a terminal stream verdict when a reconnect fails past the proof-of-life point', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let subscribeCalls = 0;
      const subscribeEvents = vi.fn(async function* () {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          yield event(1);
          throw Object.assign(new Error('session gone'), { status: 404 });
        }
        // A slow failure: the attempt stays in flight past the
        // proof-of-life point before rejecting.
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        throw new TypeError('connection reset by peer');
      });
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('stream');
      // Attempt 2 opens at t=3000 and rejects at t=7000 — past the +3s
      // proof-of-life point. A failing attempt is not the success evidence
      // the timer credited: the verdict still stands mid-attempt…
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_500);
      });
      expect(subscribeCalls).toBe(2);
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('stream');
      // …and is restored the moment the slow failure lands, without the
      // weaker transient message taking its place.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_600);
      });
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('stream');
      expect(latest?.error).toBeUndefined();
      // The next slow failure re-proves it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(7_000);
      });
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('stream');
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('keeps a terminal stream verdict standing through an unanswered reconnect', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let subscribeCalls = 0;
      const subscribeEvents = vi.fn(async function* (
        _sessionId: string,
        request: { signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          yield event(1);
          throw Object.assign(new Error('session gone'), { status: 404 });
        }
        // An open-but-silent connection: it never yields, throws, or
        // returns — a proxy black-holing the response body.
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
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('stream');
      // Attempt 2 opens at t=3000 and stays open past the +3s
      // proof-of-life point without ever answering: wall time alone is
      // not the leg's success evidence, so the verdict stands.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_100);
      });
      expect(subscribeCalls).toBe(2);
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('stream');
      expect(latest?.error).toBeUndefined();
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('expires a transient stream failure on an error-free idle reconnect', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let subscribeCalls = 0;
      const subscribeEvents = vi.fn(async function* (
        _sessionId: string,
        request: { signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1)
          throw Object.assign(new Error('upstream unavailable'), {
            status: 502,
          });
        // A live but idle session: the reconnect replays history only.
        yield event(1);
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
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBe('upstream unavailable');
      // The reconnect opens at t=3000 and stays error-free: three seconds
      // of proof-of-life expires the transient record it contradicts.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_100);
      });
      expect(subscribeCalls).toBe(2);
      expect(latest?.error).toBeUndefined();
      expect(latest?.stoppedReason).toBeUndefined();
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('keeps a transient stream failure standing through an unanswered reconnect', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let subscribeCalls = 0;
      const subscribeEvents = vi.fn(async function* (
        _sessionId: string,
        request: { signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1)
          throw Object.assign(new Error('upstream unavailable'), {
            status: 502,
          });
        yield* [];
        // An open-but-silent connection: no frame ever arrives and the
        // attempt neither throws nor returns — a proxy black-holing the
        // response body.
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
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBe('upstream unavailable');
      // Attempt 2 opens at t=3000 and stays open past the +3s
      // proof-of-life point without ever answering: the transient record
      // it never contradicted stays standing.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_100);
      });
      expect(subscribeCalls).toBe(2);
      expect(latest?.error).toBe('upstream unavailable');
      expect(latest?.stoppedReason).toBeUndefined();
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('keeps the stall warning through an idle connection that never advances', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let subscribeCalls = 0;
      const subscribeEvents = vi.fn(async function* (
        _sessionId: string,
        request: { signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls <= 3) {
          yield { ...event(1), type: 'stream_gap' };
          return;
        }
        // The reconnect then parks idle and error-free, so the
        // proof-of-life point passes with the connection open.
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
      // Three resyncs answer without advancing the cursor: the stall
      // warning surfaces.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_100);
      });
      expect(subscribeCalls).toBe(4);
      expect(latest?.error).toMatch(/not advancing/);
      // The idle error-free reconnect must not expire it: the stream still
      // has not advanced, so the condition the warning describes holds.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_100);
      });
      expect(latest?.error).toMatch(/not advancing/);
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('keeps a stream failure visible while the summary poll is healthy', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let subscribeCalls = 0;
      const subscribeEvents = vi.fn(async function* () {
        subscribeCalls += 1;
        // The stream keeps failing: no answer ever credits the leg, so its
        // record can leave only through the poll — which must not happen.
        yield* [];
        throw Object.assign(new Error('server busy'), { status: 500 });
      });
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        subscribeEvents,
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBe('server busy');
      expect(latest?.stoppedReason).toBeUndefined();
      // Two healthy poll successes inside this window retire only their
      // own leg: the stream's transient record must still be standing.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(provider.getSession.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(subscribeCalls).toBe(2);
      expect(latest?.error).toBe('server busy');
      expect(latest?.stoppedReason).toBeUndefined();
    } finally {
      restoreBackoff();
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

  it('keeps bootstrapping when only the transcript leg is definitively gone', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error('history pruned'), { status: 404 }),
          )
          .mockResolvedValue(transcript(1)),
        async *subscribeEvents(
          _sessionId: string,
          request: { lastEventId?: number; signal?: AbortSignal },
        ) {
          calls++;
          yield event(2);
          await new Promise((resolve) =>
            request.signal?.addEventListener('abort', resolve),
          );
        },
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      expect(latest?.stoppedReason).toBe('history pruned');
      expect(calls).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(calls).toBe(1);
      expect(latest?.stoppedReason).toBeUndefined();
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the session leg the bootstrap decision regardless of settle order', async () => {
    vi.useFakeTimers();
    try {
      const provider = {
        getSession: vi.fn(
          () =>
            new Promise((_resolve, reject) =>
              setTimeout(
                () =>
                  reject(
                    Object.assign(new Error('session gone'), { status: 404 }),
                  ),
                30,
              ),
            ),
        ),
        getTranscript: vi.fn(() =>
          Promise.reject(
            Object.assign(new Error('history pruned'), { status: 404 }),
          ),
        ),
        subscribeEvents: vi.fn(),
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(provider.getTranscript).toHaveBeenCalledTimes(1);
      expect(latest?.stoppedReason).toBe('session gone');
      expect(latest?.stoppedLeg).toBe('session');
      expect(provider.subscribeEvents).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a definite session-leg answer from the clean-close summary read', async () => {
    vi.useFakeTimers();
    try {
      const provider = {
        getSession: vi
          .fn()
          .mockResolvedValueOnce({ sessionId: 'session-1' })
          .mockRejectedValueOnce(
            Object.assign(new Error('bad request'), { status: 400 }),
          )
          .mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript: vi.fn().mockResolvedValue(transcript(1)),
        subscribeEvents: vi.fn(async function* () {
          yield* [];
        }),
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(latest?.stoppedReason).toBe('bad request');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(provider.subscribeEvents).toHaveBeenCalledTimes(2);
      expect(latest?.stoppedReason).toBeUndefined();
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
      expect(latest?.error).toBeUndefined();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(getTranscript).toHaveBeenCalledTimes(1);
      // The shared failure writer cleared the bootstrap's loading flag,
      // even though no snapshot ever succeeded.
      expect(latest?.loading).toBe(false);
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

  it('backs off and keeps polling after a definite summary answer instead of stopping', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
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
      expect(latest?.stoppedReason).toBe('session gone');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_899);
      });
      expect(getSession).toHaveBeenCalledTimes(3);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_999);
      });
      expect(getSession).toHaveBeenCalledTimes(4);
      expect(latest?.stoppedReason).toBe('session gone');
    } finally {
      restoreBackoff();
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
      expect(provider.subscribeEvents).toHaveBeenCalledTimes(3);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
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

  it('lets a gap snapshot supersede the streamed events it has assembled', async () => {
    const getTranscript = vi
      .fn<ManagedAgentProvider['getTranscript']>()
      .mockResolvedValueOnce({ events: [event(1)], lastEventId: 1 })
      .mockResolvedValue({
        // The server has assembled the streamed deltas 2-4 into one item,
        // projected as a single event carrying the full text at id 2.
        events: [event(1), { ...event(2), data: { text: 'hello' } }],
        lastEventId: 4,
      });
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 1) {
          yield { ...event(2), data: { text: 'he' } };
          yield { ...event(3), data: { text: 'll' } };
          yield { ...event(4), data: { text: 'o' } };
          yield { ...event(4), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    // The snapshot is authoritative for its covered range: the raw streamed
    // deltas it assembled away must not survive the merge as duplicates.
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2]),
    );
    expect(latest?.events[1]?.data).toEqual({ text: 'hello' });
  });

  it('preserves loaded older pages and their paging cursor across a stream gap', async () => {
    let deliverGap!: () => void;
    let deliverGap2!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const gapGate2 = new Promise<void>((resolve) => {
      deliverGap2 = resolve;
    });
    const cursors: Array<number | undefined> = [];
    let snapshotCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-3') {
          return Promise.resolve({
            events: [event(1), event(2)],
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-8') {
          return Promise.resolve({
            events: [event(5), event(6), event(7)],
            olderCursor: 'cursor-5',
            lastEventId: 9,
          });
        }
        snapshotCalls += 1;
        if (snapshotCalls === 1) {
          return Promise.resolve({
            events: [event(5), event(6)],
            olderCursor: 'cursor-5',
            lastEventId: 6,
          });
        }
        if (snapshotCalls === 2) {
          return Promise.resolve({
            events: [event(5), event(6), event(7)],
            olderCursor: 'cursor-5',
            lastEventId: 7,
          });
        }
        // The second gap's window slid forward.
        return Promise.resolve({
          events: [event(8), event(9)],
          olderCursor: 'cursor-8',
          lastEventId: 9,
        });
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        cursors.push(request.lastEventId);
        if (cursors.length === 1) {
          await gapGate;
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        if (cursors.length === 2) {
          await gapGate2;
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6]),
    );
    expect(latest?.olderCursor).toBe('cursor-3');

    deliverGap();

    // The gap resync merges the durable snapshot over the live array: the
    // page the user had paged into survives...
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6, 7]),
    );
    await vi.waitFor(() => expect(cursors).toEqual([6, 7]));

    // ...and paging keeps going from where the user left off.
    expect(latest?.olderCursor).toBe('cursor-3');
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]),
    );
    expect(latest?.olderCursor).toBeUndefined();

    // A second gap whose window slid past the paged region: the paged pages
    // are dropped rather than fused across the hole, the window's cursor is
    // adopted, and the hole pages back.
    deliverGap2();
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([8, 9]),
    );
    expect(latest?.olderCursor).toBe('cursor-8');
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7, 8, 9]),
    );
  });

  it('drops the paging cursor when a gap snapshot carries the full history', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    let snapshotCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        snapshotCalls += 1;
        return Promise.resolve(
          snapshotCalls === 1
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : // A snapshotted transcript: the full history, nothing older
              // to page.
              {
                events: [
                  event(1),
                  event(2),
                  event(3),
                  event(4),
                  event(5),
                  event(6),
                  event(7),
                ],
                lastEventId: 7,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-3'));

    deliverGap();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]),
    );
    // The full-history snapshot leaves nothing older to page: the cursor is
    // cleared and loadOlder is inert instead of re-fetching raw events the
    // snapshot has assembled into items.
    expect(latest?.olderCursor).toBeUndefined();
    const callsBefore = getTranscript.mock.calls.length;
    await act(async () => {
      await latest!.loadOlder();
    });
    expect(getTranscript.mock.calls.length).toBe(callsBefore);
  });

  it('discards an in-flight older page when a gap lands the full history', async () => {
    let deliverGap!: () => void;
    let releasePage!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    let snapshotCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          // The older page stays in flight until the test releases it.
          return pageGate.then(() => ({
            events: [
              { ...event(3), data: { text: 'he' } },
              { ...event(4), data: { text: 'll' } },
            ],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          }));
        }
        snapshotCalls += 1;
        return Promise.resolve(
          snapshotCalls === 1
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : // Full-history snapshot: deltas 3-4 are assembled into the item
              // projected at id 3, and nothing is left to page.
              {
                events: [
                  { ...event(3), data: { text: 'hello' } },
                  event(5),
                  event(6),
                  event(7),
                ],
                lastEventId: 7,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    // The older-page fetch starts and stays in flight...
    act(() => {
      void latest!.loadOlder();
    });
    // ...while the gap resync lands the full-history snapshot.
    deliverGap();
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 5, 6, 7]),
    );
    expect(latest?.olderCursor).toBeUndefined();

    // The stale page arrives late: it must be discarded, not merged — the
    // snapshot already carries events 3-4 in assembled form.
    await act(async () => {
      releasePage();
      await pageGate;
    });
    await vi.waitFor(() => expect(latest?.loadingOlder).toBe(false));
    expect(latest?.events.map((item) => item.id)).toEqual([3, 5, 6, 7]);
    expect(latest?.events[0]?.data).toEqual({ text: 'hello' });
    expect(latest?.olderCursor).toBeUndefined();
  });

  it('keeps the current view and the paging cursor when a gap snapshot is empty', async () => {
    const cursors: Array<number | undefined> = [];
    const getTranscript = vi
      .fn<ManagedAgentProvider['getTranscript']>()
      .mockResolvedValueOnce({
        events: [event(1), event(2)],
        olderCursor: 'cursor-1',
        lastEventId: 2,
      })
      // An empty snapshot asserts nothing about content.
      .mockResolvedValue({ events: [], lastEventId: 4 });
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        cursors.push(request.lastEventId);
        if ((request.lastEventId ?? 0) === 2) {
          yield event(3);
          yield { ...event(3), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    // The empty snapshot wiped nothing — neither the events nor the paging
    // cursor — and the stream resumed from its head.
    await vi.waitFor(() => expect(cursors).toEqual([2, 4]));
    expect(latest?.events.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(latest?.olderCursor).toBe('cursor-1');
    expect(latest?.loading).toBe(false);
  });

  it('drops kept item projections when a gap snapshot is unassembled', async () => {
    let deliverGap1!: () => void;
    let deliverGap2!: () => void;
    const gate1 = new Promise<void>((resolve) => {
      deliverGap1 = resolve;
    });
    const gate2 = new Promise<void>((resolve) => {
      deliverGap2 = resolve;
    });
    let snapshotCalls = 0;
    let subscribeCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        snapshotCalls += 1;
        if (snapshotCalls === 1) {
          // Legacy raw window; the server has no snapshot yet.
          return Promise.resolve({
            events: [event(5), event(6)],
            olderCursor: 'cursor-5',
            lastEventId: 6,
          });
        }
        if (snapshotCalls === 2) {
          // The durable snapshot now exists: deltas 3-4 are assembled into
          // the item projected at id 3, and the snapshot carries the full
          // history (no older cursor).
          return Promise.resolve({
            events: [
              {
                ...event(3),
                data: { text: 'hello' },
                assembledFromItem: true,
              },
              event(5),
              event(6),
              event(7),
            ],
            lastEventId: 7,
          });
        }
        // Reconciliation deleted the snapshot: a raw page again.
        return Promise.resolve({
          events: [event(5), event(6), event(7)],
          olderCursor: 'cursor-5',
          lastEventId: 7,
        });
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          await gate1;
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        if (subscribeCalls === 2) {
          await gate2;
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6]),
    );

    // Gap 1 lands the assembled full history: the raw page is superseded.
    deliverGap1();
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 5, 6, 7]),
    );

    // Gap 2 lands in the reconciliation window: the snapshot is gone, the
    // page is raw, and the kept item projection must not survive to
    // duplicate or un-retract the raw events.
    deliverGap2();
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7]),
    );
    // The cursor was cleared by the full-history gap, so the raw page's
    // cursor is adopted.
    expect(latest?.olderCursor).toBe('cursor-5');
  });

  it('adopts the snapshot cursor when the user never paged', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            lastEventId: 6,
          });
        }
        return Promise.resolve(
          getTranscript.mock.calls.length === 1
            ? // The session fits in one page at open: no cursor.
              { events: [event(1), event(2)], lastEventId: 2 }
            : // The session has since outgrown the page: older events exist.
              {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 2) {
          await gapGate;
          yield { ...event(2), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2]),
    );
    expect(latest?.olderCursor).toBeUndefined();

    deliverGap();

    // The unpaged prefix is dropped, and the snapshot's cursor is adopted so
    // the range below the window stays pageable.
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-5'));
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6]),
    );
  });

  it('drops the unpaged prefix on a gap when the user never paged back', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const getTranscript = vi
      .fn<ManagedAgentProvider['getTranscript']>()
      .mockResolvedValueOnce({
        events: [event(3), event(4)],
        olderCursor: 'cursor-3',
        lastEventId: 4,
      })
      .mockResolvedValue({
        events: [event(5), event(6), event(7)],
        olderCursor: 'cursor-5',
        lastEventId: 7,
      });
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 4) {
          await gapGate;
          yield { ...event(4), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4]),
    );
    deliverGap();
    // The user never paged: the aged-out prefix is trimmed back to the
    // snapshot window instead of growing for the life of the panel, and the
    // window's cursor replaces the one whose page was dropped.
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7]),
    );
    expect(latest?.olderCursor).toBe('cursor-5');
  });

  it('keeps a live event newer than a lagging gap snapshot head', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const getTranscript = vi
      .fn<ManagedAgentProvider['getTranscript']>()
      .mockResolvedValueOnce({
        events: [event(5), event(6)],
        olderCursor: 'cursor-5',
        lastEventId: 6,
      })
      // The snapshot was planned before event 7 landed: it lags the stream,
      // and re-states event 5 with different content so the resync is
      // observable in the merged state.
      .mockResolvedValue({
        events: [{ ...event(5), data: { text: 'five' } }, event(6)],
        olderCursor: 'cursor-5',
        lastEventId: 6,
      });
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          yield event(7);
          await gapGate;
          yield { ...event(7), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7]),
    );
    deliverGap();
    // Gate on the resync having actually run, then: event 7 is newer than
    // the snapshot head, so it survives the merge.
    await vi.waitFor(() => expect(getTranscript).toHaveBeenCalledTimes(2));
    expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7]);
    expect(latest?.events[0]?.data).toEqual({ text: 'five' });
  });

  it('adopts the window cursor when a hole opens between the pages and the window', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const befores: Array<string | undefined> = [];
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before) befores.push(request.before);
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-7') {
          return Promise.resolve({
            events: [event(5), event(6)],
            olderCursor: 'cursor-5',
            lastEventId: 8,
          });
        }
        return Promise.resolve(
          befores.length === 0
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : // The gap window sits far above the paged pages.
              {
                events: [event(7), event(8)],
                olderCursor: 'cursor-7',
                lastEventId: 8,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-3'));

    deliverGap();

    // The paged [3,4] are dropped rather than fused across the hole, and the
    // window's cursor is adopted so the hole pages back.
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-7'));
    expect(latest?.events.map((item) => item.id)).toEqual([7, 8]);
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7, 8]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6, 7, 8]),
    );
    expect(befores).toEqual(['cursor-5', 'cursor-7', 'cursor-5']);
  });

  it('refreshes a stale retained event from the server copy', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [{ ...event(3), data: { text: 'RETRACTED-ME' } }, event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-9') {
          // The re-paged range carries the server's retraction of event 3.
          return Promise.resolve({
            events: [
              { ...event(3), data: { text: '' } },
              event(5),
              event(6),
              event(7),
              event(8),
            ],
            olderCursor: 'cursor-3',
            lastEventId: 10,
          });
        }
        return Promise.resolve(
          getTranscript.mock.calls.length === 1
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : {
                events: [event(9), event(10)],
                olderCursor: 'cursor-9',
                lastEventId: 10,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events[0]?.data).toEqual({ text: 'RETRACTED-ME' }),
    );

    deliverGap();
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-9'));

    await act(async () => {
      await latest!.loadOlder();
    });
    // The fresh page wins on a shared id: the retraction lands.
    await vi.waitFor(() =>
      expect(latest?.events[0]?.data).toEqual({ text: '' }),
    );
  });

  it('stays exhausted after a gap once the user paged to the beginning', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-3') {
          // The beginning: no older cursor.
          return Promise.resolve({
            events: [event(1), event(2)],
            lastEventId: 6,
          });
        }
        return Promise.resolve(
          getTranscript.mock.calls.length === 1
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : {
                events: [event(5), event(6), event(7)],
                olderCursor: 'cursor-5',
                lastEventId: 7,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6]),
    );
    expect(latest?.olderCursor).toBeUndefined();

    deliverGap();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]),
    );
    // Everything is already loaded: the gap must not re-arm the affordance.
    expect(latest?.olderCursor).toBeUndefined();
    const calls = getTranscript.mock.calls.length;
    await act(async () => {
      await latest!.loadOlder();
    });
    expect(getTranscript.mock.calls.length).toBe(calls);
  });

  it('re-arms paging when a hole opens after the user paged to the beginning', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const befores: Array<string | undefined> = [];
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before) befores.push(request.before);
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-3') {
          return Promise.resolve({
            events: [event(1), event(2)],
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-8') {
          return Promise.resolve({
            events: [event(5), event(6), event(7)],
            olderCursor: 'cursor-5',
            lastEventId: 9,
          });
        }
        return Promise.resolve(
          befores.length === 0
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : // The window slid far past the paged region: a hole opened.
              {
                events: [event(8), event(9)],
                olderCursor: 'cursor-8',
                lastEventId: 9,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await act(async () => {
      await latest!.loadOlder();
    });
    // Paged to the beginning: the affordance is gone.
    await vi.waitFor(() => expect(latest?.olderCursor).toBeUndefined());

    deliverGap();

    // A hole opened between the paged region and the window: the paged
    // pages are dropped rather than fused, the window's cursor is adopted,
    // and the hole pages back.
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-8'));
    expect(latest?.events.map((item) => item.id)).toEqual([8, 9]);
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7, 8, 9]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([
        3, 4, 5, 6, 7, 8, 9,
      ]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]),
    );
    expect(befores).toEqual([
      'cursor-5',
      'cursor-3',
      'cursor-8',
      'cursor-5',
      'cursor-3',
    ]);
  });

  it('adopts the window cursor when the hole is exactly one id wide', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-6') {
          return Promise.resolve({
            events: [event(5)],
            olderCursor: 'cursor-5',
            lastEventId: 7,
          });
        }
        return Promise.resolve(
          getTranscript.mock.calls.length === 1
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : // Exactly one id (5) between the paged pages and the window.
              {
                events: [event(6), event(7)],
                olderCursor: 'cursor-6',
                lastEventId: 7,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });

    deliverGap();

    // The hole is exactly one id wide — still a hole.
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-6'));
    expect(latest?.events.map((item) => item.id)).toEqual([6, 7]);
    await act(async () => {
      await latest!.loadOlder();
    });
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6, 7]),
    );
  });

  it('discards the retried page when a second gap moves the cursor again', async () => {
    let deliverGap!: () => void;
    let deliverGap2!: () => void;
    let releasePage!: () => void;
    let releasePage2!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const gapGate2 = new Promise<void>((resolve) => {
      deliverGap2 = resolve;
    });
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const pageGate2 = new Promise<void>((resolve) => {
      releasePage2 = resolve;
    });
    const befores: Array<string | undefined> = [];
    let snapshotCalls = 0;
    let subscribeCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before) befores.push(request.before);
        if (request.before === 'cursor-5') {
          return pageGate.then(() => ({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          }));
        }
        if (request.before === 'cursor-8') {
          return pageGate2.then(() => ({
            events: [event(6), event(7)],
            olderCursor: 'cursor-6',
            lastEventId: 9,
          }));
        }
        snapshotCalls += 1;
        if (snapshotCalls === 1) {
          return Promise.resolve({
            events: [event(5), event(6)],
            olderCursor: 'cursor-5',
            lastEventId: 6,
          });
        }
        if (snapshotCalls === 2) {
          return Promise.resolve({
            events: [event(8), event(9)],
            olderCursor: 'cursor-8',
            lastEventId: 9,
          });
        }
        return Promise.resolve({
          events: [event(11), event(12)],
          olderCursor: 'cursor-11',
          lastEventId: 12,
        });
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        if (subscribeCalls === 2) {
          await gapGate2;
          yield { ...event(9), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    act(() => {
      void latest!.loadOlder();
    });
    deliverGap();
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-8'));

    // Release the first page: the retry against the moved cursor starts.
    await act(async () => {
      releasePage();
      await pageGate;
    });
    // A second gap moves the cursor again while the retry is in flight.
    deliverGap2();
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-11'));
    await act(async () => {
      releasePage2();
      await pageGate2;
    });

    // The retry bound holds: no third fetch, and the twice-stale page is
    // discarded.
    await vi.waitFor(() => expect(latest?.loadingOlder).toBe(false));
    expect(befores).toEqual(['cursor-5', 'cursor-8']);
    expect(latest?.events.map((item) => item.id)).toEqual([11, 12]);
  });

  it('resets the paging state when the panel reloads', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    let snapshotCalls = 0;
    let subscribeCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-50') {
          // The first generation's page tops out at event 49.
          return Promise.resolve({
            events: [event(48), event(49)],
            olderCursor: 'cursor-48',
            lastEventId: 51,
          });
        }
        snapshotCalls += 1;
        if (snapshotCalls === 1) {
          return Promise.resolve({
            events: [event(50), event(51)],
            olderCursor: 'cursor-50',
            lastEventId: 51,
          });
        }
        if (snapshotCalls === 2) {
          // The reload re-reads the transcript: its window covers event 49.
          return Promise.resolve({
            events: [event(49), event(50)],
            olderCursor: 'cursor-49',
            lastEventId: 50,
          });
        }
        return Promise.resolve({
          events: [event(50), event(51)],
          olderCursor: 'cursor-50',
          lastEventId: 51,
        });
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 2) {
          await gapGate;
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([50, 51]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([48, 49, 50, 51]),
    );

    // Reload: the effect re-enters and the paging state must reset.
    await act(async () => {
      latest!.reload();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([49, 50]),
    );

    deliverGap();

    // The stale pagedHead (49) is adjacent to the new window (50): without
    // the reset, the reload's window edge event 49 would be retained.
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([50, 51]),
    );
    expect(latest?.olderCursor).toBe('cursor-50');
  });

  it('retries a failed page fetch once when a gap moved the cursor', async () => {
    let deliverGap!: () => void;
    let failPage!: (error: Error) => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const pageGate = new Promise<never>((_resolve, reject) => {
      failPage = (error) => reject(error);
    });
    const befores: Array<string | undefined> = [];
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before) befores.push(request.before);
        if (request.before === 'cursor-5') {
          return pageGate;
        }
        if (request.before === 'cursor-8') {
          return Promise.resolve({
            events: [event(6), event(7)],
            olderCursor: 'cursor-6',
            lastEventId: 9,
          });
        }
        return Promise.resolve(
          befores.length === 0
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : {
                events: [event(8), event(9)],
                olderCursor: 'cursor-8',
                lastEventId: 9,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    act(() => {
      void latest!.loadOlder();
    });
    deliverGap();
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-8'));

    // The first fetch rejects after the cursor moved: the click is retried
    // once against the new cursor instead of vanishing silently.
    await act(async () => {
      failPage(new Error('older page fetch failed (502)'));
      await pageGate.catch(() => undefined);
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([6, 7, 8, 9]),
    );
    expect(befores).toEqual(['cursor-5', 'cursor-8']);
    expect(latest?.error).toBeUndefined();
  });

  it('does not count stalls separated by delivered events', async () => {
    vi.useFakeTimers();
    let subscribeCalls = 0;
    let streamed = 2;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(() =>
      Promise.resolve({ events: [event(1)], lastEventId: streamed }),
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls <= 5) {
          if (subscribeCalls >= 3) {
            // A real event between stalls: the counter resets.
            streamed += 1;
            yield event(streamed);
          }
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    try {
      // stall, stall, then every connection delivers an event before its
      // gap — never three stalls in a row.
      for (let round = 0; round < 8; round++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
      }
      expect(latest?.error).toBeUndefined();
      expect(subscribeCalls).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count stalls separated by an advancing resync', async () => {
    vi.useFakeTimers();
    let snapshotCalls = 0;
    let subscribeCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(() => {
      snapshotCalls += 1;
      return Promise.resolve(
        snapshotCalls === 4
          ? // The third gap's resync advances the head: counter resets.
            { events: [event(1), event(2), event(3)], lastEventId: 3 }
          : { events: [event(1), event(2)], lastEventId: 2 },
      );
    });
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls <= 5) {
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    try {
      // stall, stall, [advance resets], stall, stall — never three in a row.
      for (let round = 0; round < 8; round++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
      }
      expect(latest?.error).toBeUndefined();
      expect(subscribeCalls).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a page fetch once when a gap moved the cursor', async () => {
    let deliverGap!: () => void;
    let releasePage!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const befores: Array<string | undefined> = [];
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before) befores.push(request.before);
        if (request.before === 'cursor-5') {
          // The page stays in flight across the gap.
          return pageGate.then(() => ({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          }));
        }
        if (request.before === 'cursor-8') {
          return Promise.resolve({
            events: [event(6), event(7)],
            olderCursor: 'cursor-6',
            lastEventId: 9,
          });
        }
        return Promise.resolve(
          befores.length === 0
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : // The gap window moved the paging cursor forward.
              {
                events: [event(8), event(9)],
                olderCursor: 'cursor-8',
                lastEventId: 9,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    act(() => {
      void latest!.loadOlder();
    });
    deliverGap();
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-8'));

    await act(async () => {
      releasePage();
      await pageGate;
    });
    // The stale page is discarded and re-issued once against the new cursor.
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([6, 7, 8, 9]),
    );
    expect(befores).toEqual(['cursor-5', 'cursor-8']);
    expect(latest?.olderCursor).toBe('cursor-6');
  });

  it('suppresses a stale loadOlder failure after a gap lands the full history', async () => {
    let deliverGap!: () => void;
    let failPage!: (error: Error) => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const pageGate = new Promise<never>((_resolve, reject) => {
      failPage = (error) => reject(error);
    });
    let snapshotCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          // The page fetch fails after the gap has landed.
          return pageGate;
        }
        snapshotCalls += 1;
        return Promise.resolve(
          snapshotCalls === 1
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : {
                events: [event(3), event(4), event(5), event(6), event(7)],
                lastEventId: 7,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    act(() => {
      void latest!.loadOlder();
    });
    deliverGap();
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6, 7]),
    );

    await act(async () => {
      failPage(new Error('older page fetch failed (500)'));
      await pageGate.catch(() => undefined);
    });

    await vi.waitFor(() => expect(latest?.loadingOlder).toBe(false));
    expect(latest?.error).toBeUndefined();
    expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6, 7]);
    expect(latest?.olderCursor).toBeUndefined();
  });

  it('shows a failed older-page fetch and retires it on the next page', async () => {
    let failPage!: (error: Error) => void;
    const pageGate = new Promise<never>((_resolve, reject) => {
      failPage = (error) => reject(error);
    });
    let pageAttempts = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          pageAttempts += 1;
          return pageAttempts === 1
            ? pageGate
            : Promise.resolve({ events: [event(3), event(4)], lastEventId: 6 });
        }
        return Promise.resolve({
          events: [event(5), event(6)],
          olderCursor: 'cursor-5',
          lastEventId: 6,
        });
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { signal?: AbortSignal },
      ) {
        // Older than the snapshot head: ignored, keeps require-yield happy.
        yield event(1);
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    act(() => {
      void latest!.loadOlder();
    });
    await act(async () => {
      failPage(new Error('older page fetch failed (500)'));
      await pageGate.catch(() => undefined);
    });

    // The failed click is a transcript-leg record: surfaced, not sticky.
    await vi.waitFor(() => expect(latest?.loadingOlder).toBe(false));
    expect(latest?.error).toBe('older page fetch failed (500)');
    expect(latest?.stoppedReason).toBeUndefined();
    expect(latest?.stoppedLeg).toBeUndefined();
    expect(latest?.events.map((item) => item.id)).toEqual([5, 6]);
    expect(latest?.olderCursor).toBe('cursor-5');

    // The next successful page read retires its own leg's record.
    await act(async () => {
      void latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6]),
    );
    expect(latest?.error).toBeUndefined();
  });

  it('keeps a failed page fetch visible through later summary polls', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) =>
          request.before
            ? Promise.reject(
                Object.assign(new Error('page failed'), { status: 500 }),
              )
            : Promise.resolve({
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }),
      );
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript,
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
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]);

      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBe('page failed');
      // Two healthy poll successes inside this window must not erase the
      // transcript leg's standing record of the failed click.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_100);
      });
      expect(provider.getSession.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(latest?.error).toBe('page failed');
      expect(latest?.stoppedReason).toBeUndefined();
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]);
      expect(latest?.olderCursor).toBe('cursor-5');
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('records a failed page fetch without claiming a terminal verdict', async () => {
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) =>
        request.before
          ? Promise.reject(
              Object.assign(new Error('The Session was not found.'), {
                status: 404,
              }),
            )
          : Promise.resolve({
              events: [event(5), event(6)],
              olderCursor: 'cursor-5',
              lastEventId: 6,
            }),
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { signal?: AbortSignal },
      ) {
        yield event(7);
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7]),
    );

    await act(async () => {
      await latest!.loadOlder();
    });
    // A failed click is one-off evidence: it surfaces the click's own
    // message but never claims the transcript is terminally gone — a
    // failover 404 on a live session must not stick as a verdict; the
    // poll certifies a genuinely gone session on its own leg.
    expect(latest?.stoppedReason).toBeUndefined();
    expect(latest?.stoppedLeg).toBeUndefined();
    expect(latest?.error).toBe('The Session was not found.');
    expect(latest?.olderCursor).toBe('cursor-5');
  });

  it('keeps a resync verdict standing through a failed page fetch until the stream delivers again', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let snapshotCalls = 0;
      let subscribeCalls = 0;
      const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) => {
          if (request.before)
            return Promise.reject(new Error('older page fetch failed (500)'));
          snapshotCalls += 1;
          return snapshotCalls === 1
            ? Promise.resolve({
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              })
            : Promise.reject(
                Object.assign(new Error('history pruned'), { status: 404 }),
              );
        },
      );
      const provider = {
        getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        getTranscript,
        async *subscribeEvents(
          _sessionId: string,
          request: { signal?: AbortSignal },
        ) {
          subscribeCalls += 1;
          if (subscribeCalls === 1) {
            yield { ...event(6), type: 'stream_gap' };
            return;
          }
          yield event(7);
          await new Promise((resolve) =>
            request.signal?.addEventListener('abort', resolve),
          );
        },
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // The gap resync's definite answer stands as the transcript leg's
      // terminal verdict while the stream recovers around it.
      expect(latest?.stoppedReason).toBe('history pruned');
      expect(latest?.stoppedLeg).toBe('transcript');

      // The failed click is a weaker later failure on the same leg: the
      // standing resync verdict must not be downgraded by it.
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.stoppedReason).toBe('history pruned');
      expect(latest?.stoppedLeg).toBe('transcript');

      // The stream then recovers with a genuinely new frame and never gaps
      // again: the live delivery retires the verdict.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7]);
      expect(latest?.stoppedReason).toBeUndefined();
      expect(latest?.stoppedLeg).toBeUndefined();
      expect(latest?.error).toBeUndefined();
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('recovers past a run of corrupt frames through the resync path', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const transcriptPayload = (lastSequence: number) =>
      JSON.stringify({
        items: [],
        events:
          lastSequence === 2
            ? [JSON.parse(javaDelta(1, 'one')), JSON.parse(javaDelta(2, 'two'))]
            : [
                // The corrupt run 3-6 is absent; the transcript head is 7.
                JSON.parse(javaDelta(1, 'one')),
                JSON.parse(javaDelta(2, 'two')),
                JSON.parse(javaDelta(7, 'after')),
              ],
        coveredSequence: 0,
        hasMore: false,
        lastSequence,
      });
    let transcriptCalls = 0;
    const streamCursors: Array<unknown> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/sessions/get')) {
        return new Response(javaSessionPayload(2), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/transcript/query')) {
        transcriptCalls += 1;
        return new Response(transcriptPayload(transcriptCalls === 1 ? 2 : 7), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/events/stream')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        streamCursors.push(body['afterSequence']);
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (body['afterSequence'] === 2) {
              controller.enqueue(
                encoder.encode(
                  corrupt(3) + corrupt(4) + corrupt(5) + corrupt(6),
                ),
              );
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    mountReact(<Probe provider={provider} />);
    await flushReact();

    // The corrupt-run detection, resync fetch and merge each dispatch on
    // their own macrotask; give the act batcher one wall-clock boundary to
    // settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The budget trip resyncs: the transcript is re-read, the cursor moves
    // past the whole corrupt run, and the event behind it renders.
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2, 7]),
    );
    expect(latest?.error).toBeUndefined();
    expect(transcriptCalls).toBe(2);
    expect(streamCursors).toEqual([2, 7]);
  });

  it('surfaces an error when repeated resyncs cannot advance the cursor', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith('/sessions/get')) {
        return new Response(javaSessionPayload(2), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/transcript/query')) {
        // The transcript head never advances past the corrupt run.
        return new Response(
          JSON.stringify({
            items: [],
            events: [
              JSON.parse(javaDelta(1, 'one')),
              JSON.parse(javaDelta(2, 'two')),
            ],
            coveredSequence: 0,
            hasMore: false,
            lastSequence: 2,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path.endsWith('/events/stream')) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(corrupt(3) + corrupt(4) + corrupt(5) + corrupt(6)),
            );
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    mountReact(<Probe provider={provider} />);
    await flushReact();

    try {
      // The first stall resubscribes after one 3s pause; each further stall
      // takes another. The third consecutive stall surfaces the error.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      // The error must not fire on the first two stalls...
      expect(latest?.error).toBeUndefined();
      // ...and fires on exactly the third: one more 3s cadence, no slack.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toMatch(/not advancing/);
      // The error is the only user-visible signal of the stall: it must
      // persist while the condition persists, not flash for one cadence.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(latest?.error).toMatch(/not advancing/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the stall error once a resync advances the cursor', async () => {
    vi.useFakeTimers();
    let snapshotCalls = 0;
    let subscribeCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(() => {
      snapshotCalls += 1;
      // The fifth call is the fourth gap's resync: it finally advances.
      return Promise.resolve(
        snapshotCalls <= 4
          ? { events: [event(1), event(2)], lastEventId: 2 }
          : { events: [event(1), event(2), event(3)], lastEventId: 3 },
      );
    });
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls <= 4) {
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    try {
      // Three consecutive stalls surface the error.
      for (let round = 0; round < 8 && latest?.error === undefined; round++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
      }
      expect(latest?.error).toMatch(/not advancing/);
      expect(latest?.stoppedReason).toBeUndefined();

      // An advancing resync retires the stream leg's own record.
      for (let round = 0; round < 8 && latest?.error !== undefined; round++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
      }
      expect(latest?.error).toBeUndefined();
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a transient recovery error once a resync succeeds', async () => {
    vi.useFakeTimers();
    let snapshotCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(() => {
      snapshotCalls += 1;
      if (snapshotCalls === 2) {
        // The first gap's recovery fetch fails transiently.
        return Promise.reject(
          new TypeError('Recovery temporarily unavailable'),
        );
      }
      return Promise.resolve({
        events: [event(1), event(2)],
        lastEventId: 2,
      });
    });
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 2) {
          yield { ...event(2), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    mountReact(<Probe provider={provider} />);
    await flushReact();

    try {
      // The first gap's recovery fetch rejects during the initial microtask
      // chain — before any timer fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toMatch(/Recovery temporarily unavailable/);
      // The next gap's resync succeeds (same head — no progress): the
      // transient error must clear even though the stall guard did not fire.
      for (let round = 0; round < 6 && latest?.error !== undefined; round++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
      }
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires a stale resync verdict when a later resync fulfills the transcript read', async () => {
    vi.useFakeTimers();
    const restoreBackoff = deterministicBackoff();
    try {
      let snapshotCalls = 0;
      let subscribeCalls = 0;
      let sessionCalls = 0;
      const provider = {
        getSession: vi.fn(() => {
          sessionCalls += 1;
          return sessionCalls <= 2
            ? Promise.resolve({ sessionId: 'session-1' })
            : Promise.reject(
                Object.assign(new Error('server busy'), { status: 500 }),
              );
        }),
        getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(() => {
          snapshotCalls += 1;
          return snapshotCalls === 2
            ? Promise.reject(
                Object.assign(new Error('history pruned'), { status: 404 }),
              )
            : Promise.resolve(transcript(1));
        }),
        async *subscribeEvents(
          _sessionId: string,
          request: { lastEventId?: number },
        ) {
          subscribeCalls += 1;
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
        },
      } as unknown as ManagedAgentProvider;
      mountReact(<Probe provider={provider} />);
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.stoppedReason).toBe('history pruned');
      expect(latest?.stoppedLeg).toBe('transcript');
      // The next resync settles [session 500, transcript ok]: the
      // fulfilled transcript read is its own leg's success evidence and
      // must retire the stale verdict before the session-leg throw
      // discards it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      expect(subscribeCalls).toBe(2);
      expect(latest?.stoppedReason).toBeUndefined();
      expect(latest?.stoppedLeg).toBeUndefined();
      expect(latest?.error).toBe('server busy');
    } finally {
      restoreBackoff();
      vi.useRealTimers();
    }
  });

  it('restores a pending action whose streamed frame was corrupt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let transcriptCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/sessions/get')) {
        return new Response(javaSessionPayload(2), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/transcript/query')) {
        transcriptCalls += 1;
        return new Response(
          JSON.stringify(
            transcriptCalls === 1
              ? {
                  items: [],
                  events: [
                    JSON.parse(javaDelta(1, 'one')),
                    JSON.parse(javaDelta(2, 'two')),
                  ],
                  coveredSequence: 0,
                  hasMore: false,
                  lastSequence: 2,
                }
              : {
                  items: [],
                  events: [
                    JSON.parse(javaDelta(1, 'one')),
                    JSON.parse(javaDelta(2, 'two')),
                    {
                      sequence: 3,
                      eventId: 'evt_3',
                      sessionId: 'session-1',
                      turnId: 'turn-1',
                      type: 'action.updated',
                      createdAt: 3,
                      data: { actionId: 'act-1', state: 'requested' },
                      terminal: false,
                    },
                    JSON.parse(javaDelta(4, 'four')),
                  ],
                  coveredSequence: 0,
                  hasMore: false,
                  lastSequence: 4,
                },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path.endsWith('/events/stream')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (body['afterSequence'] === 2) {
              // The persisted action.updated frame at sequence 3 is corrupt.
              controller.enqueue(
                encoder.encode(
                  'id: 3\r\nevent: action.updated\r\ndata: {"sequence":3,"eventId":"evt_3"\r\n\r\n',
                ),
              );
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    mountReact(<Probe provider={provider} />);
    await flushReact();

    // The corrupt action frame triggers a resync instead of a silent skip:
    // the transcript is re-read and the action event is restored.
    await vi.waitFor(() => expect(transcriptCalls).toBe(2));
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2, 3, 4]),
    );
    expect(latest?.events[2]?.type).toBe('action_updated');
    expect(latest?.error).toBeUndefined();
  });

  it('skips a corrupt streamed frame and keeps rendering later events', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const streamBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/sessions/get')) {
        return new Response(javaSessionPayload(2), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/transcript/query')) {
        return new Response(
          JSON.stringify({
            items: [],
            events: [
              JSON.parse(javaDelta(1, 'one')),
              JSON.parse(javaDelta(2, 'two')),
            ],
            coveredSequence: 2,
            hasMore: false,
            lastSequence: 2,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path.endsWith('/events/stream')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        streamBodies.push(body);
        // The persisted frame at sequence 3 is corrupt; a valid frame sits
        // behind it at sequence 4. Later resubscribes get an empty stream.
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (body['afterSequence'] === 2) {
              controller.enqueue(
                encoder.encode(
                  'id: 3\r\nevent: item.output_text.delta\r\ndata: {"sequence":3,"eventId":"evt_3"\r\n\r\n' +
                    sseFrame(4, 'after-corrupt'),
                ),
              );
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    mountReact(<Probe provider={provider} />);
    await flushReact();

    // The corrupt frame is skipped: the valid event behind it renders, and
    // the panel is not wedged on an error.
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2, 4]),
    );
    expect(latest?.error).toBeUndefined();
    // The single stream request started from the snapshot cursor.
    expect(streamBodies).toHaveLength(1);
    expect(streamBodies[0]?.['afterSequence']).toBe(2);
  });
});
