/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentSideConnection } from '@agentclientprotocol/sdk';

const CLIENT_REQUESTS = new Set<PropertyKey>([
  'requestPermission',
  'extMethod',
  'readTextFile',
  'writeTextFile',
]);

// ACP SDK 0.14 leaves outstanding RPCs pending after transport closure.
export function bindAcpConnectionLifetime(
  connection: AgentSideConnection,
  signal: AbortSignal,
): AgentSideConnection {
  return new Proxy(connection, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!CLIENT_REQUESTS.has(property)) return value.bind(target);
      return (...args: unknown[]) =>
        new Promise<unknown>((resolve, reject) => {
          const onAbort = () => reject(new Error('ACP connection closed'));
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
          const finish = () => signal.removeEventListener('abort', onAbort);
          try {
            Promise.resolve(value.apply(target, args)).then(
              (result: unknown) => {
                finish();
                resolve(result);
              },
              (error: unknown) => {
                finish();
                reject(error);
              },
            );
          } catch (error) {
            finish();
            reject(error);
          }
        });
    },
  });
}
