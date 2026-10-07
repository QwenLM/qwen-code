/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as acpBridge from '@qwen-code/acp-bridge/bridge';
import { runQwenServe } from './run-qwen-serve.js';

// Records stdout 'error' listener counts at every boot write: the guard must
// be installed BEFORE the first stdout write, so moving it below the write
// turns the first recorded count red. This pins ordering in a fresh module
// registry — run-qwen-serve.test.ts cannot, because the guard's module-level
// once-flag means only the first boot in a registry ever attaches.
const counts = vi.hoisted(() => [] as number[]);

vi.mock('../utils/stdioHelpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/stdioHelpers.js')>();
  return {
    ...actual,
    writeStdoutLine: (
      ...args: Parameters<typeof actual.writeStdoutLine>
    ): ReturnType<typeof actual.writeStdoutLine> => {
      counts.push(process.stdout.listenerCount('error'));
      return actual.writeStdoutLine(...args);
    },
  };
});

describe('serve broken-pipe guard install order', () => {
  it('attaches the stdout/stderr EPIPE guard before the first stdout write', async () => {
    // A listen-only boot: the deferred runtime never creates a bridge here.
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() => {
      throw new Error('bridge must not be created during a listen-only boot');
    });
    const tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-broken-pipe-')),
    );
    const stdoutBefore = process.stdout.listenerCount('error');
    const stderrBefore = process.stderr.listenerCount('error');
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmp,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );
    try {
      expect(counts.length).toBeGreaterThan(0);
      for (const count of counts) {
        expect(count).toBe(stdoutBefore + 1);
      }
      expect(process.stdout.listenerCount('error')).toBe(stdoutBefore + 1);
      expect(process.stderr.listenerCount('error')).toBe(stderrBefore + 1);
    } finally {
      await handle.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
