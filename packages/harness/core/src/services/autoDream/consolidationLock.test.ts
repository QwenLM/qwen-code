/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  markConsolidationComplete,
  readLastConsolidatedAt,
  tryAcquireConsolidationLock,
} from './consolidationLock.js';

const tempDirs: string[] = [];

async function makeMemoryDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-dream-lock-'));
  tempDirs.push(dir);
  return dir;
}

describe('consolidationLock', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.splice(0).map((dir) =>
        fs.rm(dir, {
          recursive: true,
          force: true,
        }),
      ),
    );
  });

  it('clears the live holder after successful consolidation', async () => {
    const memoryDir = await makeMemoryDir();

    expect(await tryAcquireConsolidationLock(memoryDir)).toBe(0);
    expect(await tryAcquireConsolidationLock(memoryDir)).toBeNull();

    await markConsolidationComplete(memoryDir);

    const priorMtime = await tryAcquireConsolidationLock(memoryDir);
    expect(priorMtime).toEqual(expect.any(Number));
    expect(priorMtime).toBeGreaterThan(0);
  });

  it('reclaims an exited holder before exposing the time-gate watermark', async () => {
    const memoryDir = await makeMemoryDir();
    const filePath = path.join(memoryDir, '.consolidate-lock');
    const exitedPid = 424242;
    await fs.writeFile(filePath, String(exitedPid), 'utf8');
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === exitedPid) {
        throw Object.assign(new Error('process does not exist'), { code: 'ESRCH' });
      }
      return true;
    });

    await expect(readLastConsolidatedAt(memoryDir)).resolves.toBe(0);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an active holder as a time-gate suppression signal', async () => {
    const memoryDir = await makeMemoryDir();
    const filePath = path.join(memoryDir, '.consolidate-lock');
    await fs.writeFile(filePath, String(process.pid), 'utf8');

    await expect(readLastConsolidatedAt(memoryDir)).resolves.toBeGreaterThan(0);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(String(process.pid));
  });
});
