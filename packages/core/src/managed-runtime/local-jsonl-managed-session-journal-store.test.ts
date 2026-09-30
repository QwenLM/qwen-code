/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalJsonlManagedSessionJournalStore } from './local-jsonl-managed-session-journal-store.js';

const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = { tenantId: 't1', workspaceId: 'w1', sessionId };
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

async function workspace(): Promise<{
  runtimeBaseDir: string;
  transcriptPath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-store-'));
  temporaryDirectories.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(
    runtimeBaseDir,
    'projects',
    'test',
    'chats',
    `${sessionId}.jsonl`,
  );
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  return { runtimeBaseDir, transcriptPath };
}

describe('local JSONL Managed Session journal store', () => {
  it('preserves the historical JSONL encoding for a transaction batch', async () => {
    const paths = await workspace();
    const handle = await new LocalJsonlManagedSessionJournalStore({
      ...paths,
      sessionId,
    }).open({ sessionKey });
    const records = [
      {
        uuid: 'record-1',
        subtype: 'session_execution_engine',
        systemPayload: { version: 1, engine: 'managed' },
      },
      { uuid: 'record-2', subtype: 'pre-header-metadata', value: 1 },
    ];

    await handle.appendTransaction(records);

    expect(await fs.readFile(paths.transcriptPath, 'utf8')).toBe(
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
    await expect(handle.read()).resolves.toMatchObject({
      committed: 0,
      foreignRecords: 2,
      engineRecords: 1,
      lastRecordUuid: 'record-2',
    });
    await handle.seal({
      lastCommitSequence: 0,
      committedPrefixHash: '0'.repeat(64),
    });
  });

  it('releases a writer acquired by an aborted open', async () => {
    const paths = await workspace();
    const handle = await new LocalJsonlManagedSessionJournalStore({
      ...paths,
      sessionId,
    }).open({ sessionKey });

    await handle.abort();

    const successor = await SessionWriterLease.acquire({
      ...paths,
      sessionId,
    });
    await successor.release();
  });

  it('leaves an adopted writer with its owner when aborting', async () => {
    const paths = await workspace();
    const lease = await SessionWriterLease.acquire({
      ...paths,
      sessionId,
    });
    const handle = await new LocalJsonlManagedSessionJournalStore({
      ...paths,
      sessionId,
      lease,
    }).open({ sessionKey });

    await handle.abort();

    expect(lease.isReleased).toBe(false);
    await lease.release();
  });
});
