/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ConversationRuntimeActivityGate } from './conversation-runtime-activity.js';

describe('ConversationRuntimeActivityGate', () => {
  it('waits for admitted work and rejects work after sealing', async () => {
    const gate = new ConversationRuntimeActivityGate();
    let finish!: () => void;
    const task = gate.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const drain = gate.sealAndWait();

    await expect(gate.run(async () => undefined)).rejects.toMatchObject({
      code: 'daemon_draining',
    });
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finish();
    await task;
    await drain;
    expect(drained).toBe(true);
  });

  it('releases activity when a task fails', async () => {
    const gate = new ConversationRuntimeActivityGate();

    await expect(
      gate.run(async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    await expect(gate.sealAndWait()).resolves.toBeUndefined();
  });
});
