/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getFreePort } from './freePort.js';
import { createServer } from 'node:net';

describe('getFreePort', () => {
  it('returns a port that can be bound', async () => {
    const port = await getFreePort();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const s = createServer().listen(port, '127.0.0.1', () =>
        s.close(() => resolve()),
      );
      s.on('error', reject);
    });
  });

  it('returns distinct ports across calls', async () => {
    const a = await getFreePort();
    const b = await getFreePort();
    expect(a).not.toBe(b);
  });
});
