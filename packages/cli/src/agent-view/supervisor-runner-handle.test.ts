/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mocked at the client seam so the options each handle entry passes are
// observable without a socket; the rest of the module stays real.
const { callAgentViewSupervisor, requestAgentViewSupervisor } = vi.hoisted(
  () => ({
    callAgentViewSupervisor: vi.fn(),
    requestAgentViewSupervisor: vi.fn(),
  }),
);

vi.mock('./supervisor-client.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./supervisor-client.js')>();
  return {
    ...actual,
    callAgentViewSupervisor: (...args: unknown[]) =>
      callAgentViewSupervisor(...args),
    requestAgentViewSupervisor: (...args: unknown[]) =>
      requestAgentViewSupervisor(...args),
  };
});

const { connectExistingAgentViewSupervisor } = await import(
  './supervisor-runner.js'
);

describe('supervisor handle timeouts', () => {
  beforeEach(() => {
    callAgentViewSupervisor.mockReset().mockResolvedValue({ ok: true });
    requestAgentViewSupervisor.mockReset().mockResolvedValue({ ok: true });
  });

  async function connect() {
    const handle = await connectExistingAgentViewSupervisor({
      globalDir: '/nonexistent-qwen-home',
    });
    if (!handle) throw new Error('expected a reachable supervisor');
    return handle;
  }

  // The server serializes per-session ops behind the host-setup lock a
  // launch holds for its whole worker-ready budget (15 s), so a handle
  // entry left at the client's 5 s default reports a stop as timed out
  // while the supervisor then completes it.
  it.each(['peek', 'stop'] as const)(
    '%s waits past the worker-ready budget instead of the 5 s default',
    async (op) => {
      const handle = await connect();
      await handle[op]('sess-1');
      const options = callAgentViewSupervisor.mock.calls[0]?.[3] as
        | { timeoutMs?: number }
        | undefined;
      expect(options?.timeoutMs).toBeGreaterThanOrEqual(15_000);
    },
  );
});
