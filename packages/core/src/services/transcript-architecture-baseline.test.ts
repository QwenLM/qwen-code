/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UserMessage } from '../protocol/transcript/message.js';
import { TranscriptStore } from './transcript/store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createTempTranscriptPath(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'transcript-architecture-baseline-'),
  );
  tempDirs.push(dir);
  return path.join(dir, 'session.jsonl');
}

function makeUserMessage(uuid: string, content: string): UserMessage {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-07-10T00:00:00.000Z',
    message: {
      role: 'user',
      content,
    },
  };
}

function createWriter(filePath: string, store: TranscriptStore) {
  return store.acquireSessionWriter({
    filePath,
    sessionId: 'session-baseline',
    cwd: '/workspace/project',
    entrypoint: 'cli',
    version: '1.0.0',
  });
}

async function readJsonLines(filePath: string): Promise<unknown[]> {
  const content = await fs.readFile(filePath, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe('transcript architecture behavior baseline', () => {
  it('deduplicates one UUID across independent handles for the same session path', async () => {
    const filePath = await createTempTranscriptPath();
    const store = new TranscriptStore({ coordinatorOptions: { flushIntervalMs: 0 } });
    const firstWriter = await createWriter(filePath, store);
    const secondWriter = await createWriter(filePath, store);
    const sharedMessage = makeUserMessage(
      '00000000-0000-4000-8000-000000000001',
      'shared message',
    );

    await Promise.all([
      firstWriter.recordMessages([sharedMessage]),
      secondWriter.recordMessages([sharedMessage]),
    ]);
    await Promise.all([firstWriter.close(), secondWriter.close()]);

    const entries = (await readJsonLines(filePath)) as Array<{
      uuid?: string;
    }>;
    expect(
      entries.filter((entry) => entry.uuid === sharedMessage.uuid),
    ).toHaveLength(1);
    await store.close();
  });

  it('rejects append after the writer handle closes', async () => {
    const filePath = await createTempTranscriptPath();
    const store = new TranscriptStore({ coordinatorOptions: { flushIntervalMs: 0 } });
    const writer = await createWriter(filePath, store);

    await writer.recordMessages([
      makeUserMessage('00000000-0000-4000-8000-000000000002', 'before close'),
    ]);
    await writer.close();
    expect(() =>
      writer.recordMessages([
        makeUserMessage(
          '00000000-0000-4000-8000-000000000003',
          'after close',
        ),
      ]),
    ).toThrow('TranscriptWriterHandle is closed');

    const entries = (await readJsonLines(filePath)) as Array<{
      uuid?: string;
    }>;
    expect(entries.filter((entry) => entry.uuid !== undefined)).toHaveLength(1);
    await store.close();
  });

  it('repairs a valid final line without LF before appending', async () => {
    const filePath = await createTempTranscriptPath();
    const existing = {
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: '/workspace/project',
      sessionId: 'session-baseline',
      version: '1.0.0',
      ...makeUserMessage(
        '00000000-0000-4000-8000-000000000004',
        'existing entry',
      ),
    };
    await fs.writeFile(filePath, JSON.stringify(existing), 'utf8');

    const store = new TranscriptStore({ coordinatorOptions: { flushIntervalMs: 0 } });
    const writer = await createWriter(filePath, store);
    await writer.recordMessages([
      makeUserMessage('00000000-0000-4000-8000-000000000005', 'new entry'),
    ]);
    await writer.close();

    const entries = (await readJsonLines(filePath)) as Array<{ uuid?: string }>;
    expect(entries.filter((entry) => entry.uuid !== undefined)).toHaveLength(2);
    await store.close();
  });
});
