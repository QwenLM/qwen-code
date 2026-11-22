/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { Query } from '../../src/query/Query.js';
import { Stream } from '../../src/utils/Stream.js';
import type { SDKUserMessage } from '../../src/types/protocol.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const userMessage: SDKUserMessage = {
  type: 'user',
  session_id: 's-1',
  parent_tool_use_id: null,
  message: { role: 'user', content: 'hello' },
};

class Transport {
  isReady = true;
  exitError: Error | null = null;
  messages = new Stream<unknown>();
  failure: Error | null = null;
  write(line: string) {
    const message = JSON.parse(line);
    if (message.type === 'control_request') {
      this.messages.enqueue({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: {},
        },
      });
    } else if (this.failure) throw this.failure;
  }
  async *readMessages() {
    yield* this.messages;
  }
  async close() {
    this.messages.done();
  }
  async waitForExit() {}
  endInput() {}
}

describe('input failure precedence after asynchronous transport teardown', () => {
  it.each(['fresh-error', 'transport-error', 'closed'] as const)(
    '%s preserves the first terminal state',
    async (kind) => {
      const transport = new Transport();
      const q = new Query(transport, { timeout: { streamClose: 5 } });
      await q.initialized;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* prompts() {
        await ready;
        yield userMessage;
      }
      const streaming = q
        .streamInput(prompts())
        .catch((error: unknown) => error);
      await tick();
      const writeError = new Error('Transport not ready for writing');
      const exitError = new Error('CLI process exited with code 1: boom');
      if (kind === 'transport-error') {
        transport.exitError = exitError;
        transport.messages.error(exitError);
        await tick();
      } else if (kind === 'closed') await q.close();
      transport.failure = writeError;
      release();
      await streaming;
      try {
        if (kind === 'closed')
          await expect(q.next()).resolves.toMatchObject({ done: true });
        else
          await expect(q.next()).rejects.toBe(
            kind === 'transport-error' ? exitError : writeError,
          );
      } finally {
        await q.close();
      }
    },
  );
});
