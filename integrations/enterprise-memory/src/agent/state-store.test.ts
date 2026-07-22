/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
  it('rejects unsafe lock wait windows', () => {
    expect(() => new AgentStateStore('/tmp/unused-memory-state', 49)).toThrow(
      'lock timeout is invalid',
    );
    expect(
      () => new AgentStateStore('/tmp/unused-memory-state', 5_001),
    ).toThrow('lock timeout is invalid');
    expect(
      () =>
        new AgentStateStore('/tmp/unused-memory-state', 250, new Uint8Array()),
    ).toThrow('operation key is invalid');
  });

  it('keeps operation IDs stable when local state is lost', async () => {
    const key = randomBytes(32);
    const first = await fixture();
    const second = await fixture();
    const input = ['proposal', { summary: 'Use the release checklist' }];

    const firstId = await new AgentStateStore(
      first.directory,
      250,
      key,
    ).beginOperation('mcp', input);
    const secondId = await new AgentStateStore(
      second.directory,
      250,
      key,
    ).beginOperation('mcp', input);

    expect(secondId).toBe(firstId);
    await expect(
      stat(path.join(first.directory, '.operation-key')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes state files with restricted permissions', async () => {
    const { directory, store } = await fixture();
    const sessionId = 'session-a';

    await store.beginOperation(sessionId, ['request-a']);

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(sessionPath(directory, sessionId))).mode & 0o777).toBe(
      0o600,
    );
    expect(
      (await stat(path.join(directory, '.operation-key'))).mode & 0o777,
    ).toBe(0o600);
  });

  it('serializes operation-key initialization across processes', async () => {
    const { directory } = await fixture();
    const first = new AgentStateStore(directory);
    const second = new AgentStateStore(directory);

    const [firstId, secondId] = await Promise.all([
      first.beginOperation('session-a', ['same-request']),
      second.beginOperation('session-a', ['same-request']),
    ]);

    expect(secondId).toBe(firstId);
    expect((await stat(path.join(directory, '.operation-key'))).size).toBe(32);
  });

  it('recovers a stale lock left by an exited hook process', async () => {
    const { directory, store } = await fixture();
    const sessionId = 'session-a';
    await store.read(sessionId);
    const lockPath = `${sessionPath(directory, sessionId)}.lock`;
    await mkdir(lockPath, { mode: 0o700 });
    const stale = new Date(Date.now() - 30_000);
    await utimes(lockPath, stale, stale);

    await expect(
      store.beginOperation(sessionId, ['request-a']),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries operation-key initialization after transient lock contention', async () => {
    const { directory } = await fixture();
    const store = new AgentStateStore(directory, 50);
    const lockPath = path.join(directory, '.operation-key.lock');
    await mkdir(lockPath, { mode: 0o700 });

    await expect(
      store.beginOperation('session-a', ['request-a']),
    ).rejects.toThrow('Timed out waiting for agent session lock');
    await rm(lockPath, { recursive: true });

    await expect(
      store.beginOperation('session-a', ['request-a']),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('retries state-directory initialization after a transient failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'qwen-memory-state-root-'));
    directories.push(root);
    const directory = path.join(root, 'state');
    await writeFile(directory, 'temporary obstruction');
    const store = new AgentStateStore(directory, 250, randomBytes(32));

    await expect(store.read('session-a')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await rm(directory);
    await mkdir(directory);

    await expect(store.read('session-a')).resolves.toEqual({
      sessionId: 'session-a',
      recentOperations: [],
    });
  });

  it('clears only the operation that is still pending', async () => {
    const { store } = await fixture();
    const first = await store.beginOperation('session-a', ['request-a']);
    const second = await store.beginOperation('session-a', ['request-b']);

    await store.completeOperation('session-a', first);
    expect((await store.read('session-a')).pendingOperationId).toBe(second);
    await store.completeOperation('session-a', second);
    expect((await store.read('session-a')).pendingOperationId).toBeUndefined();
  });

  it('reuses operation metadata for an exact retry after completion', async () => {
    const { directory, store } = await fixture();
    const turnId = 'ea09a5be-4e32-48cb-b76d-d513492d9c82';
    await store.update('session-a', (state) => ({ ...state, turnId }));
    const first = await store.beginOperationWithState('session-a', [
      'request-a',
    ]);
    await store.completeOperation('session-a', first.operationId);
    await store.update('session-a', (state) => ({
      ...state,
      turnId: '8d39189f-cb3d-4a18-bd43-52f7bf9014e9',
    }));

    const retry = await new AgentStateStore(directory).beginOperationWithState(
      'session-a',
      ['request-a'],
    );

    expect(retry.operationId).toBe(first.operationId);
    expect(retry.turnId).toBe(turnId);
    expect(retry.occurredAt).toBe(first.occurredAt);
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
