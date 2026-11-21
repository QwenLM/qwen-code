/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonSessionClient } from '../../src/daemon/DaemonSessionClient.js';

vi.mock('../../src/daemon/DaemonClient.js', () => ({
  isNonBlockingAccepted: vi.fn(),
  matchTurnEvent: vi.fn(),
  normalizePendingPromptLimit: vi.fn((value: number) => value),
}));

describe('DaemonSessionClient event subscription cleanup', () => {
  it.each([
    'unstarted return',
    'return after rejected next',
    'unstarted throw',
  ])(
    'does not release the active subscription after %s',
    async (cleanupVariant) => {
      let connections = 0;
      const subscribeEvents = vi.fn(async function* () {
        connections++;
        try {
          yield {
            id: connections,
            v: 1,
            type: 'session_update',
            data: 'event',
          };
          await new Promise<void>(() => {});
        } finally {
          connections--;
        }
      });
      const client = {
        transport: { type: 'rest' },
        subscribeEvents,
      } as unknown as DaemonClient;
      const session = new DaemonSessionClient({
        client,
        session: {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
        },
        maxPendingPromptsPerSession: 10,
      });
      const original = session.events();
      const second = session.events();
      let third: ReturnType<DaemonSessionClient['events']> | undefined;

      try {
        await expect(original.next()).resolves.toMatchObject({
          done: false,
          value: { id: 1 },
        });
        expect(connections).toBe(1);

        if (cleanupVariant === 'unstarted return') {
          await second.return();
        } else if (cleanupVariant === 'unstarted throw') {
          await expect(second.throw(new Error('boom'))).rejects.toThrow('boom');
        } else {
          await expect(second.next()).rejects.toThrow('subscription active');
          await second.return();
        }

        third = session.events();
        await expect(third.next()).rejects.toThrow('subscription active');
        expect(subscribeEvents).toHaveBeenCalledTimes(1);
        expect(connections).toBe(1);
      } finally {
        await Promise.allSettled([
          third?.return(),
          second.return(),
          original.return(),
        ]);
      }
    },
  );
});
