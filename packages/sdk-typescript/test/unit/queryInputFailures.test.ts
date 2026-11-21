/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../src/query/createQuery.js';
import type { Query } from '../../src/query/Query.js';
import type { SDKUserMessage } from '../../src/types/protocol.js';

const fixture = vi.hoisted(() => ({
  failure: new Error('input failed'),
  failWrite: false,
  closed: false,
}));

vi.mock('../../src/utils/cliPath.js', () => ({
  prepareSpawnInfo: () => undefined,
}));
vi.mock('../../src/transport/ProcessTransport.js', async () => {
  const { Stream } = await import('../../src/utils/Stream.js');
  return {
    ProcessTransport: class {
      isReady = true;
      exitError = null;
      messages = new Stream<unknown>();
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
        } else if (fixture.failWrite) {
          throw fixture.failure;
        }
      }
      async *readMessages() {
        yield* this.messages;
      }
      async close() {
        fixture.closed = true;
        this.messages.done();
      }
      async waitForExit() {}
      endInput() {}
    },
  };
});

describe('query prompt input failures', () => {
  const queries: Query[] = [];
  afterEach(async () => {
    await Promise.all(queries.splice(0).map((q) => q.close()));
  });

  it.each(['source', 'stream-write', 'single-write'] as const)(
    'surfaces a %s failure to the result iterator and closes the process',
    async (kind) => {
      fixture.failWrite = kind !== 'source';
      fixture.closed = false;
      const message: SDKUserMessage = {
        type: 'user',
        session_id: 'session',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      };
      async function* prompts() {
        yield message;
        if (kind === 'source') throw fixture.failure;
      }
      const q = query({
        prompt: kind === 'single-write' ? 'hello' : prompts(),
      });
      queries.push(q);
      let observed: unknown = 'pending';
      const next = q.next().then(
        (value) => {
          observed = value;
        },
        (error: unknown) => {
          observed = error;
        },
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      try {
        expect(observed).toBe(fixture.failure);
        expect(fixture.closed).toBe(true);
      } finally {
        await q.close();
        await next;
      }
    },
  );
});
