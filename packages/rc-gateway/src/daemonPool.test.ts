/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { DaemonPool } from './daemonPool.js';

function fakeClient(tag: string) {
  return { tag } as unknown as import('@qwen-code/sdk').DaemonClient;
}

function makePool(spawnLog: string[]) {
  return new DaemonPool({
    defaultDaemon: fakeClient('default'),
    defaultWorkspaceCwd: '/home/evan',
    spawn: async (cwd) => {
      spawnLog.push(cwd);
      return {
        client: fakeClient(cwd),
        stop: async () => {},
        workspaceCwd: cwd,
      };
    },
  });
}

describe('DaemonPool', () => {
  it('spawns one daemon per workspace and reuses it', async () => {
    const log: string[] = [];
    const pool = makePool(log);
    const a1 = await pool.getOrSpawn('/proj/a');
    const a2 = await pool.getOrSpawn('/proj/a');
    const b1 = await pool.getOrSpawn('/proj/b');
    expect(a1).toBe(a2); // reused
    expect(a1).not.toBe(b1);
    expect(log).toEqual(['/proj/a', '/proj/b']); // spawned once each
    expect(pool.size()).toBe(2);
  });

  it('returns the default daemon when cwd is omitted or the default workspace', async () => {
    const log: string[] = [];
    const pool = makePool(log);
    const d1 = await pool.getOrSpawn();
    const d2 = await pool.getOrSpawn('/home/evan');
    expect((d1 as unknown as { tag: string }).tag).toBe('default');
    expect((d2 as unknown as { tag: string }).tag).toBe('default');
    expect(log).toEqual([]); // never spawned
  });

  it('dedupes concurrent spawns for the same new workspace', async () => {
    const log: string[] = [];
    const pool = makePool(log);
    const [c1, c2] = await Promise.all([
      pool.getOrSpawn('/proj/c'),
      pool.getOrSpawn('/proj/c'),
    ]);
    expect(c1).toBe(c2);
    expect(log).toEqual(['/proj/c']);
    expect(pool.size()).toBe(1);
    expect(pool.workspaces()).toEqual(['/proj/c']);
  });
});
