/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { loadPty, type PtyProcess } from '../utils/getPty.js';
import {
  getPtyInputQueueBytes,
  type PtyInputQueueInternals,
} from './pty-input-queue.js';

describe('native PTY input queue', () => {
  it.skipIf(process.platform === 'win32')(
    'measures pending bytes on a real POSIX backend',
    async (context) => {
      const { impl } = await loadPty();
      if (impl === null) {
        context.skip();
        return;
      }

      // A sleeping process never consumes input; exec keeps cleanup to one PID.
      const pty = impl.module.spawn('/bin/sh', ['-c', 'exec sleep 60'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env,
      }) as PtyProcess & PtyInputQueueInternals & { write(data: Buffer): void };
      const exited = new Promise<void>((resolve) => {
        pty.onExit(() => resolve());
      });
      pty.onData(() => {});

      try {
        expect(getPtyInputQueueBytes(pty)).toBe(0);
        pty.write(Buffer.alloc(512 * 1024, 'x'));
        const pendingBytes = getPtyInputQueueBytes(pty);
        expect(typeof pendingBytes).toBe('number');
        expect(pendingBytes).toBeGreaterThan(0);
      } finally {
        pty.kill('SIGKILL');
        await exited;
      }
    },
  );
});
