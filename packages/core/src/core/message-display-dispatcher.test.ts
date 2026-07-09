/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MessageDisplayDispatcher,
  MESSAGE_DISPLAY_DRAIN_TIMEOUT_MS,
} from './message-display-dispatcher.js';
import { MESSAGE_DISPLAY_DEBOUNCE_MS } from './message-display-buffer.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

interface SentPayload {
  message_id: string;
  displayed_text: string;
  is_final: boolean;
}

/**
 * A MessageBus stub whose `request` resolves only when the test releases it,
 * so tests can hold a hook execution "in flight" while more flushes arrive.
 */
function createControlledBus() {
  const sent: SentPayload[] = [];
  // Index-aligned with `sent`; entries are cleared (not removed) once
  // settled so positions stay stable.
  const releases: Array<(() => void) | undefined> = [];
  const request = vi.fn(
    (message: { input: SentPayload }) =>
      new Promise((resolve) => {
        sent.push(message.input);
        releases.push(() => resolve({}));
      }),
  );
  return {
    bus: { request } as unknown as MessageBus,
    request,
    sent,
    /**
     * Settle one unresolved request: the oldest by default, or the request
     * at `index` (position in `sent`) — so a test can settle the final
     * delivery while an older mid-stream one is still held in flight.
     */
    release: async (index?: number) => {
      const i = index ?? releases.findIndex((r) => r !== undefined);
      if (i >= 0) {
        releases[i]?.();
        releases[i] = undefined;
      }
      // Let the dispatcher's .then/.finally continuations run.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function createDispatcher(
  bus: MessageBus,
  opts: { signal?: AbortSignal; warn?: (message: string) => void } = {},
) {
  return new MessageDisplayDispatcher(
    bus,
    opts.signal ?? new AbortController().signal,
    opts.warn ?? (() => {}),
    0,
  );
}

const PAST_DEBOUNCE = MESSAGE_DISPLAY_DEBOUNCE_MS + 1;

describe('MessageDisplayDispatcher', () => {
  it('delivers a due mid-stream flush and then the final flush, sharing one message_id', async () => {
    const { bus, sent, release } = createControlledBus();
    const dispatcher = createDispatcher(bus);

    dispatcher.addChunk('Hello, ', PAST_DEBOUNCE);
    await release();
    const finished = dispatcher.finish();
    await release();
    await finished;

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      displayed_text: 'Hello, ',
      is_final: false,
    });
    expect(sent[1]).toMatchObject({
      displayed_text: 'Hello, ',
      is_final: true,
    });
    expect(sent[1].message_id).toBe(sent[0].message_id);
    expect(sent[0].message_id).toBe(dispatcher.messageId);
  });

  it('coalesces flushes that arrive while a hook is in flight, keeping only the newest', async () => {
    const { bus, sent, release } = createControlledBus();
    const dispatcher = createDispatcher(bus);

    // First due flush goes out and is held in flight.
    dispatcher.addChunk('one ', PAST_DEBOUNCE);
    expect(sent).toHaveLength(1);

    // Three more due flushes arrive while it's still running: each should
    // overwrite the single pending slot, not queue up behind one another.
    dispatcher.addChunk('two ', 2 * PAST_DEBOUNCE);
    dispatcher.addChunk('three ', 3 * PAST_DEBOUNCE);
    dispatcher.addChunk('four', 4 * PAST_DEBOUNCE);
    expect(sent).toHaveLength(1);

    await release(); // first request settles -> pending (newest only) goes out
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      displayed_text: 'one two three four',
      is_final: false,
    });

    await release();
    const finished = dispatcher.finish();
    await release();
    await finished;

    // Intermediate texts "one two " and "one two three " were superseded and
    // never delivered — lossless, since displayed_text is cumulative.
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({
      displayed_text: 'one two three four',
      is_final: true,
    });
  });

  it('lets the final flush supersede a pending mid-stream payload, keeping is_final', async () => {
    const { bus, sent, release } = createControlledBus();
    const dispatcher = createDispatcher(bus);

    dispatcher.addChunk('partial ', PAST_DEBOUNCE); // in flight
    dispatcher.addChunk('more ', 2 * PAST_DEBOUNCE); // pending
    const finished = dispatcher.finish(); // drops pending, dispatches is_final
    await release();
    await release();
    await finished;

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      displayed_text: 'partial more ',
      is_final: true,
    });
  });

  it('finish() resolves only once the final payload has been delivered', async () => {
    const { bus, sent, release } = createControlledBus();
    const dispatcher = createDispatcher(bus);

    dispatcher.addChunk('text', PAST_DEBOUNCE); // in flight
    let finishResolved = false;
    const finished = dispatcher.finish().then(() => {
      finishResolved = true;
    });
    expect(sent).toHaveLength(2); // final dispatched alongside the mid-stream one

    await Promise.resolve();
    await Promise.resolve();
    expect(finishResolved).toBe(false); // final delivery still in flight

    await release(); // mid-stream delivered; final still in flight
    expect(finishResolved).toBe(false);

    await release(); // final delivered
    await finished;
    expect(finishResolved).toBe(true);
  });

  it('finish() is idempotent — a second call neither re-fires is_final nor hangs', async () => {
    const { bus, sent, release } = createControlledBus();
    const dispatcher = createDispatcher(bus);

    dispatcher.addChunk('text', 0); // within debounce window: no mid-stream flush
    const first = dispatcher.finish();
    await release();
    await first;
    await dispatcher.finish();

    const finals = sent.filter((payload) => payload.is_final);
    expect(finals).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ displayed_text: 'text', is_final: true });
  });

  it('fires nothing on finish() when no text ever streamed', async () => {
    const { bus, request } = createControlledBus();
    const dispatcher = createDispatcher(bus);

    await dispatcher.finish();

    expect(request).not.toHaveBeenCalled();
  });

  it('suppresses the final flush and does not wait on in-flight delivery when aborted', async () => {
    const { bus, sent } = createControlledBus();
    const controller = new AbortController();
    const dispatcher = createDispatcher(bus, { signal: controller.signal });

    dispatcher.addChunk('text', PAST_DEBOUNCE); // in flight, never released
    controller.abort();

    // Resolves immediately despite the unsettled in-flight request.
    await dispatcher.finish();

    expect(sent).toHaveLength(1);
    expect(sent.filter((payload) => payload.is_final)).toHaveLength(0);
  });

  it('logs a failed delivery with the message_id and still delivers the final flush', async () => {
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    try {
      const warn = vi.fn();
      const sent: SentPayload[] = [];
      const request = vi.fn((message: { input: SentPayload }) => {
        sent.push(message.input);
        return message.input.is_final
          ? Promise.resolve({})
          : Promise.reject(new Error('hook process failed'));
      });
      const dispatcher = createDispatcher(
        { request } as unknown as MessageBus,
        { warn },
      );

      dispatcher.addChunk('text', PAST_DEBOUNCE); // this delivery fails
      // Let the failure settle while the message is still streaming — a
      // failure noticed only after finish() dispatched the final payload is
      // deliberately suppressed as superseded (see the next test).
      await Promise.resolve();
      await Promise.resolve();
      await dispatcher.finish();

      expect(warn).toHaveBeenCalledWith(
        `MessageDisplay hook failed [${dispatcher.messageId}]: Error: hook process failed`,
      );
      // The injected sink is typically the gated debug-file logger, so the
      // dispatcher itself mirrors every warning to the console — a broken
      // delivery must be visible by default, on every surface.
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        `MessageDisplay hook failed [${dispatcher.messageId}]: Error: hook process failed`,
      );
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatchObject({ displayed_text: 'text', is_final: true });
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('does not warn when a superseded mid-stream delivery fails after the final was dispatched', async () => {
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    try {
      const warn = vi.fn();
      const sent: SentPayload[] = [];
      let rejectMidStream!: (err: Error) => void;
      const request = vi.fn((message: { input: SentPayload }) => {
        sent.push(message.input);
        return message.input.is_final
          ? Promise.resolve({})
          : new Promise((_resolve, reject) => {
              rejectMidStream = reject;
            });
      });
      const dispatcher = createDispatcher(
        { request } as unknown as MessageBus,
        { warn },
      );

      dispatcher.addChunk('text', PAST_DEBOUNCE); // in flight, held
      await dispatcher.finish(); // final dispatched alongside, settles fine

      // The stale delivery's outcome no longer matters — the final payload
      // superseded it and was delivered. A late failure (e.g. the bus
      // request's own timeout) must not alarm anyone about a turn that
      // actually completed correctly.
      rejectMidStream(new Error('request timed out'));
      await Promise.resolve();
      await Promise.resolve();

      expect(warn).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('shares one drain budget across concurrent finish() calls', async () => {
    vi.useFakeTimers();
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    try {
      const warn = vi.fn();
      const { bus } = createControlledBus();
      const dispatcher = createDispatcher(bus, { warn });

      dispatcher.addChunk('text', PAST_DEBOUNCE); // in flight, never released
      const first = dispatcher.finish();
      const second = dispatcher.finish(); // concurrent, not sequential

      await vi.advanceTimersByTimeAsync(MESSAGE_DISPLAY_DRAIN_TIMEOUT_MS);
      await first;
      await second;

      // Both calls shared ONE timer and produced ONE warning — a concurrent
      // second call must not open a second timeout window of its own.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      consoleWarnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('gives up waiting on drain after the timeout and warns, while delivery keeps running in the background', async () => {
    vi.useFakeTimers();
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    try {
      const warn = vi.fn();
      const { bus, sent, release } = createControlledBus();
      const dispatcher = createDispatcher(bus, { warn });

      dispatcher.addChunk('text', PAST_DEBOUNCE); // in flight, never released
      let finishResolved = false;
      const finished = dispatcher.finish().then(() => {
        finishResolved = true;
      });

      // The final payload was dispatched immediately, alongside the stale
      // mid-stream delivery — the timeout bounds waiting for the hook to
      // finish executing, not whether it receives is_final.
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatchObject({ displayed_text: 'text', is_final: true });

      await vi.advanceTimersByTimeAsync(MESSAGE_DISPLAY_DRAIN_TIMEOUT_MS - 1);
      expect(finishResolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await finished;

      expect(finishResolved).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `MessageDisplay hook [${dispatcher.messageId}] still running after ${MESSAGE_DISPLAY_DRAIN_TIMEOUT_MS}ms`,
        ),
      );

      // finish() stopped waiting, but both deliveries are still running in
      // the background and settle normally once released.
      await release();
      await release();
      expect(sent).toHaveLength(2);

      // The drain-timeout warning also reaches the console: the injected
      // sink is typically the gated debug-file logger, and this is the
      // moment a documented guarantee is being relaxed.
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `MessageDisplay hook [${dispatcher.messageId}] still running after ${MESSAGE_DISPLAY_DRAIN_TIMEOUT_MS}ms`,
        ),
      );
    } finally {
      consoleWarnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('dispatches is_final immediately alongside a stale in-flight mid-stream delivery instead of queueing behind it', async () => {
    const { bus, sent } = createControlledBus();
    const dispatcher = createDispatcher(bus);

    dispatcher.addChunk('The quick', PAST_DEBOUNCE); // in flight, held
    dispatcher.addChunk(' brown fox', 2 * PAST_DEBOUNCE); // pending, superseded
    void dispatcher.finish();

    // The final payload must not wait for the stale in-flight delivery to
    // settle: it strictly supersedes it (cumulative text), and queueing
    // behind it is what dropped is_final in short-lived processes.
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      displayed_text: 'The quick brown fox',
      is_final: true,
    });
  });

  it('finish() resolves once the final delivery settles, even while a superseded mid-stream delivery is still running', async () => {
    const warn = vi.fn();
    const { bus, sent, release } = createControlledBus();
    const dispatcher = createDispatcher(bus, { warn });

    dispatcher.addChunk('stale', PAST_DEBOUNCE); // in flight, never released
    const finished = dispatcher.finish();

    expect(sent).toHaveLength(2); // final dispatched alongside the stale one
    await release(1); // settle ONLY the final delivery
    await finished; // must not wait on the stale delivery (or the timeout)

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not restart the drain budget when finish() is called again while delivery is still in flight', async () => {
    vi.useFakeTimers();
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    try {
      const warn = vi.fn();
      const { bus } = createControlledBus();
      const dispatcher = createDispatcher(bus, { warn });

      dispatcher.addChunk('text', PAST_DEBOUNCE); // in flight, never released
      const first = dispatcher.finish();
      await vi.advanceTimersByTimeAsync(MESSAGE_DISPLAY_DRAIN_TIMEOUT_MS);
      await first; // budget spent, one warning

      // The client.ts sequence: an explicit finish() before the Stop hook,
      // then a second from the outer finally. The second call must not buy
      // the hung delivery another full timeout — the ceiling is the
      // constant, not a multiple of it.
      let secondResolved = false;
      const second = dispatcher.finish().then(() => {
        secondResolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(secondResolved).toBe(true);
      await second;
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      consoleWarnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('ignores chunks that arrive after finish()', async () => {
    const { bus, sent, release } = createControlledBus();
    const dispatcher = createDispatcher(bus);

    dispatcher.addChunk('text', 0);
    const finished = dispatcher.finish();
    dispatcher.addChunk('late', 10 * PAST_DEBOUNCE);
    await release();
    await finished;

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ displayed_text: 'text', is_final: true });
  });
});
