/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';
import { startDaemon } from './daemonSupervisor.js';

let stub: StubDaemon | undefined;
afterEach(async () => {
  if (stub) await stub.close();
  stub = undefined;
});

describe('daemonSupervisor', () => {
  it('waits for health then returns a usable DaemonClient', async () => {
    stub = await startStubDaemon();
    const stubUrl = stub.baseUrl;
    let killed = false;
    const handle = await startDaemon({
      // Injected spawner: ignore the real CLI, point at the stub.
      spawner: () => ({
        baseUrl: stubUrl,
        token: undefined,
        kill: () => {
          killed = true;
        },
      }),
    });
    const health = await handle.daemon.health();
    expect(health.status).toBe('ok');
    await handle.stop();
    expect(killed).toBe(true);
  });
});
