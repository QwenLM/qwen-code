/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { leaveStaleSocket } from '../test-utils/stale-socket.js';

const { isPidAlive } = vi.hoisted(() => ({
  isPidAlive: vi.fn<(pid: number) => boolean>(),
}));

vi.mock('../utils/process-liveness.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/process-liveness.js')>();
  return { ...actual, isPidAlive };
});

const { sweepOrphanSocketDirs, sweepOrphanSockets } = await import(
  './uds-inbox.js'
);

const DEAD_PID = 2_147_483_647;
const isWindows = process.platform === 'win32';
let tmpDir: string;

beforeEach(async () => {
  isPidAlive.mockReset();
  tmpDir = await fs.mkdtemp(
    isWindows ? path.join(os.tmpdir(), 'qsl-') : '/tmp/qsl-',
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.skipIf(isWindows)('orphan sweep liveness recheck', () => {
  it('keeps a socket when its PID revives after the probe', async () => {
    const dir = path.join(tmpDir, 'qwen-socks');
    const socketPath = path.join(dir, `${DEAD_PID}.sock`);
    await fs.mkdir(dir);
    await leaveStaleSocket(socketPath);
    isPidAlive.mockReturnValueOnce(false).mockReturnValueOnce(true);

    expect(
      await sweepOrphanSockets(dir, path.join(dir, `${DEAD_PID - 1}.sock`)),
    ).toBe(0);
    expect(isPidAlive).toHaveBeenCalledTimes(2);
    await expect(fs.stat(socketPath)).resolves.toBeDefined();
  });

  it('keeps a fallback directory when its PID revives after the probe', async () => {
    const dir = path.join(tmpDir, `qwen-socks-${'a'.repeat(16)}`);
    const socketPath = path.join(dir, `${DEAD_PID}.sock`);
    await fs.mkdir(dir);
    await leaveStaleSocket(socketPath);
    isPidAlive.mockReturnValueOnce(false).mockReturnValueOnce(true);

    expect(
      await sweepOrphanSocketDirs(
        tmpDir,
        path.join(tmpDir, `qwen-socks-${'b'.repeat(16)}`),
      ),
    ).toBe(0);
    expect(isPidAlive).toHaveBeenCalledTimes(2);
    await expect(fs.stat(dir)).resolves.toBeDefined();
  });
});
