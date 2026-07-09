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
  const releases: Array<() => void> = [];
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
    /** Settle the oldest unresolved request. */
    release: async () => {
      releases.shift()?.();
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

  it('lets the final flush overwrite a pending mid-stream payload, keeping is_final', async () => {
    const { bus, sent, release } = createControlledBus();
    const dispatcher = createDispatcher(bus);

    dispatcher.addChunk('partial ', PAST_DEBOUNCE); // in flight
    dispatcher.addChunk('more ', 2 * PAST_DEBOUNCE); // pending
    const finished = dispatcher.finish(); // overwrites pending, is_final wins
    await release();
    await release();
    await finished;

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      displayed_text: 'partial more ',
      is_final: true,
    });
  });

  it('finish() resolves only once every enqueued payload has been delivered', async () => {
    const { bus, sent, release } = createControlledBus();
    const dispatcher = createDispatcher(bus);

    dispatcher.addChunk('text', PAST_DEBOUNCE); // in flight
    let finishResolved = false;
    const finished = dispatcher.finish().then(() => {
      finishResolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(finishResolved).toBe(false); // mid-stream payload still in flight

    await release(); // mid-stream delivered -> final goes out
    expect(finishResolved).toBe(false); // final still in flight
    expect(sent).toHaveLength(2);

    await release();
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
    const warn = vi.fn();
    const sent: SentPayload[] = [];
    const request = vi.fn((message: { input: SentPayload }) => {
      sent.push(message.input);
      return message.input.is_final
        ? Promise.resolve({})
        : Promise.reject(new Error('hook process failed'));
    });
    const dispatcher = createDispatcher({ request } as unknown as MessageBus, {
      warn,
    });

    dispatcher.addChunk('text', PAST_DEBOUNCE); // this delivery fails
    await dispatcher.finish();

    expect(warn).toHaveBeenCalledWith(
      `MessageDisplay hook failed [${dispatcher.messageId}]: Error: hook process failed`,
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ displayed_text: 'text', is_final: true });
  });

  it('gives up waiting on drain after the timeout and warns, while delivery keeps running in the background', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const { bus, sent, release } = createControlledBus();
      const dispatcher = createDispatcher(bus, { warn });

      dispatcher.addChunk('text', PAST_DEBOUNCE); // in flight, never released
      let finishResolved = false;
      const finished = dispatcher.finish().then(() => {
        finishResolved = true;
      });

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

      // finish() stopped waiting, but the in-flight delivery itself is still
      // running and completes normally once released.
      expect(sent).toHaveLength(1);
      await release();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatchObject({ displayed_text: 'text', is_final: true });
    } finally {
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
