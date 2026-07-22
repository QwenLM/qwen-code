/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStateStore } from './state-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  directory: string;
  store: AgentStateStore;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'qwen-memory-state-'));
  directories.push(directory);
  return { directory, store: new AgentStateStore(directory) };
}

function sessionPath(directory: string, sessionId: string): string {
  const name = createHash('sha256').update(sessionId).digest('hex');
  return path.join(directory, `${name}.json`);
}

describe('AgentStateStore', () => {
  it('writes state files with restricted permissions', async () => {
    const { directory, store } = await fixture();
    const sessionId = 'session-a';

    await store.beginOperation(sessionId);

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(sessionPath(directory, sessionId))).mode & 0o777).toBe(
      0o600,
    );
  });

  it('recovers a lock left by an exited hook process', async () => {
    const { directory, store } = await fixture();
    const sessionId = 'session-a';
    await store.read(sessionId);
    const lockPath = `${sessionPath(directory, sessionId)}.lock`;
    await writeFile(lockPath, '2147483647', { mode: 0o600 });

    await expect(store.beginOperation(sessionId)).resolves.toMatch(
      /^[0-9a-f-]{36}$/,
    );
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('clears only the operation that is still pending', async () => {
    const { store } = await fixture();
    const first = await store.beginOperation('session-a');
    const second = await store.beginOperation('session-a');

    await store.completeOperation('session-a', first);
    expect((await store.read('session-a')).pendingOperationId).toBe(second);
    await store.completeOperation('session-a', second);
    expect((await store.read('session-a')).pendingOperationId).toBeUndefined();
  });

  it('rejects malformed local state instead of forwarding it', async () => {
    const { directory, store } = await fixture();
    const sessionId = 'session-a';
    await store.read(sessionId);
    await writeFile(
      sessionPath(directory, sessionId),
      JSON.stringify({
        sessionId,
        turnId: 'not-a-uuid',
      }),
      { mode: 0o600 },
    );

    await expect(store.read(sessionId)).rejects.toThrow();
  });
});
