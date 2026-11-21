/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonSessionClient } from '../../src/daemon/DaemonSessionClient.js';

describe('session replay cursor across event-bus epochs', () => {
  it.each([
    { seed: 'old', epoch: 'new', id: 2, expected: '2' },
    { seed: 'old', epoch: 'new', id: undefined, expected: '0' },
    { seed: 'old', epoch: 'old', id: 2, expected: '100' },
    { seed: undefined, epoch: 'new', id: 2, expected: '100' },
  ])(
    'reconnects with a cursor belonging to $epoch',
    async ({ seed, epoch, id, expected }) => {
      const requests: Headers[] = [];
      const fetch: typeof globalThis.fetch = async (_input, init) => {
        requests.push(new Headers(init?.headers));
        const frames =
          requests.length === 1 && id !== undefined
            ? `id: ${id}\nevent: session_update\ndata: ${JSON.stringify({ id, v: 1, type: 'session_update', data: 'message' })}\n\n`
            : '';
        return new Response(frames, {
          headers: {
            'content-type': 'text/event-stream',
            'x-qwen-event-epoch': epoch,
          },
        });
      };
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const session = new DaemonSessionClient({
        client,
        session: {
          sessionId: 'session',
          workspaceCwd: '/work',
          attached: true,
        },
        lastEventId: 100,
        eventEpoch: seed,
      });

      for await (const _event of session.events()) {
        // Consume the entire first stream, including the final cursor update.
      }
      for await (const _event of session.events()) {
        // The second subscription must pair the new epoch with its own cursor.
      }

      expect(requests[0]?.get('last-event-id')).toBe('100');
      expect(requests[0]?.get('x-qwen-event-epoch')).toBe(seed ?? null);
      expect(requests[1]?.get('last-event-id')).toBe(expected);
      expect(session.eventEpoch).toBe(epoch);
    },
  );
});
