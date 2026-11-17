/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Query } from '../../src/query/Query.js';
import type { Transport } from '../../src/transport/Transport.js';
import type { SDKUserMessage } from '../../src/types/protocol.js';
import type { PermissionResult } from '../../src/types/types.js';
import { Stream } from '../../src/utils/Stream.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class ReadyTransport implements Transport {
  readonly messages = new Stream<unknown>();
  readonly replies: Array<{
    request_id: string;
    response: Record<string, unknown>;
  }> = [];
  readonly permission = deferred<Record<string, unknown>>();
  isReady = true;
  exitError = null;

  write(line: string): void {
    const message = JSON.parse(line) as {
      type: string;
      request_id: string;
      request: { subtype: string };
      response: { request_id: string; response: Record<string, unknown> };
    };
    if (message.type === 'control_request') {
      this.messages.enqueue({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response:
            message.request.subtype === 'get_available_models'
              ? { models: ['example'] }
              : {},
        },
      });
    } else if (message.type === 'control_response') {
      this.replies.push(message.response);
      this.permission.resolve(message.response.response);
    }
  }

  requestPermission(): void {
    this.messages.enqueue({
      type: 'control_request',
      request_id: 'permission',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'read_file',
        input: {},
        permission_suggestions: null,
      },
    });
  }

  async *readMessages(): AsyncGenerator<unknown> {
    yield* this.messages;
  }
  async close(): Promise<void> {
    this.messages.done();
  }
  async waitForExit(): Promise<void> {}
  endInput(): void {}
}

const allow: PermissionResult = { behavior: 'allow', updatedInput: {} };

describe('incoming SDK control request responsiveness', () => {
  afterEach(() => vi.useRealTimers());

  it('reads control replies while a permission callback awaits a public query method', async () => {
    const transport = new ReadyTransport();
    const query = new Query(transport, {
      timeout: { controlRequest: 30, canUseTool: 100 },
      canUseTool: async () => {
        expect(await query.getAvailableModels()).toEqual({
          models: ['example'],
        });
        return allow;
      },
    });
    try {
      await query.initialized;
      transport.requestPermission();
      expect(await transport.permission.promise).toEqual(allow);
    } finally {
      await query.close();
    }
  });

  it.each(['cancel', 'close', 'EOF'] as const)(
    'stops a pending permission wait on %s without sending a late reply',
    async (shutdown) => {
      const transport = new ReadyTransport();
      const callback = deferred<PermissionResult>();
      const entered = deferred<AbortSignal>();
      const query = new Query(transport, {
        canUseTool: async (_name, _input, { signal }) => {
          entered.resolve(signal);
          return callback.promise;
        },
      });
      try {
        await query.initialized;
        vi.useFakeTimers();
        transport.requestPermission();
        const signal = await entered.promise;
        if (shutdown === 'cancel') {
          transport.messages.enqueue({
            type: 'control_cancel_request',
            request_id: 'permission',
          });
        } else if (shutdown === 'EOF') {
          transport.messages.done();
        } else {
          await query.close();
        }
        await vi.advanceTimersByTimeAsync(0);

        expect(signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        expect(transport.replies).toEqual([]);
        callback.resolve(allow);
        await vi.advanceTimersByTimeAsync(0);
        expect(transport.replies).toEqual([]);
      } finally {
        callback.resolve(allow);
        await vi.advanceTimersByTimeAsync(0);
        await query.close();
      }
    },
  );

  it('preserves SDK message order while a permission callback is pending', async () => {
    const transport = new ReadyTransport();
    const callback = deferred<PermissionResult>();
    const query = new Query(transport, {
      canUseTool: async () => callback.promise,
    });
    const user = (text: string): SDKUserMessage => ({
      type: 'user',
      session_id: 'session-a',
      parent_tool_use_id: null,
      message: { role: 'user', content: text },
    });
    const expected = [user('first'), user('second')];
    const observed: unknown[] = [];
    let reading: Promise<void> | undefined;
    try {
      await query.initialized;
      transport.messages.enqueue(expected[0]);
      transport.requestPermission();
      transport.messages.enqueue(expected[1]);
      reading = (async () => {
        observed.push((await query.next()).value);
        observed.push((await query.next()).value);
      })();
      await nextTurn();
      expect(observed).toEqual(expected);
    } finally {
      callback.resolve(allow);
      await reading;
      await query.close();
    }
  });
});
