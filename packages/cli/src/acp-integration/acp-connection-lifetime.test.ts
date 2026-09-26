/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { bindAcpConnectionLifetime } from './acp-connection-lifetime.js';

describe('bindAcpConnectionLifetime', () => {
  it.each(['requestPermission', 'extMethod', 'readTextFile', 'writeTextFile'])(
    'ends a pending %s on disconnect and rejects new dispatches',
    async (method) => {
      const lifetime = new AbortController();
      const request = vi.fn(() => new Promise<unknown>(() => {}));
      const connection = { [method]: request };
      const bound = bindAcpConnectionLifetime(
        connection as unknown as AgentSideConnection,
        lifetime.signal,
      ) as unknown as Record<string, () => Promise<unknown>>;
      const result = bound[method]().catch((error: unknown) => error);
      lifetime.abort();
      expect(await result).toMatchObject({ message: 'ACP connection closed' });
      await expect(bound[method]()).rejects.toThrow('ACP connection closed');
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it('preserves receiver identity, results, errors and notification behavior', async () => {
    class Connection {
      #value = 'reply';
      async extMethod() {
        return this.#value;
      }
      async sessionUpdate() {
        return this.#value;
      }
      async readTextFile() {
        throw new Error(this.#value);
      }
    }
    const lifetime = new AbortController();
    const removeListener = vi.spyOn(lifetime.signal, 'removeEventListener');
    const bound = bindAcpConnectionLifetime(
      new Connection() as unknown as AgentSideConnection,
      lifetime.signal,
    );
    await expect(bound.extMethod('method', {})).resolves.toBe('reply');
    await expect(
      bound.readTextFile({ sessionId: 's', path: '/file' }),
    ).rejects.toThrow('reply');
    expect(removeListener).toHaveBeenCalledTimes(2);
    lifetime.abort();
    await expect(
      bound.sessionUpdate({
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'message' },
        },
      }),
    ).resolves.toBe('reply');
  });
});
