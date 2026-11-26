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
import type { Message } from '../../protocol/transcript/message.js';
import { SessionStateStore } from '../session-state-store.js';
import {
  AUTO_MEMORY_INCREMENTAL_STATE_SEGMENT_KEY,
  commitAutoMemoryIncrementalState,
  getMessagesAfterCommittedCursor,
  loadAutoMemoryIncrementalState,
} from './incremental-state.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })),
  );
});

describe('incremental memory state', () => {
  it('persists only cursor and previous memory in an encrypted segment', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'auto-memory-incremental-state-'),
    );
    tempDirs.push(tempDir);
    const store = new SessionStateStore({
      projectRoot: tempDir,
      sessionId: 'session-1',
      configHomeDir: tempDir,
    });

    await commitAutoMemoryIncrementalState(store, {
      committed_message_uuid: 'message-2',
      previous_generated_memories: [
        { filePath: '/memory/preference.md', content: 'remember this' },
      ],
    });

    expect(await loadAutoMemoryIncrementalState(store)).toEqual({
      committed_message_uuid: 'message-2',
      previous_generated_memories: [
        { filePath: '/memory/preference.md', content: 'remember this' },
      ],
    });
    const raw = JSON.parse(
      await fs.readFile(store.getSessionStatePath(), 'utf8'),
    ) as { data: Record<string, unknown>; items: Record<string, unknown> };
    expect(raw.data[AUTO_MEMORY_INCREMENTAL_STATE_SEGMENT_KEY]).toBeUndefined();
    expect(raw.items[AUTO_MEMORY_INCREMENTAL_STATE_SEGMENT_KEY]).toBeDefined();
    expect(JSON.stringify(raw)).not.toContain('remember this');
  });

  it('returns every raw lineage message after the committed UUID', () => {
    const messages = [
      { uuid: 'message-1', type: 'user' },
      { uuid: 'message-2', type: 'assistant' },
      { uuid: 'message-3', type: 'user' },
    ] as Message[];

    expect(getMessagesAfterCommittedCursor(messages, 'message-1')).toEqual([
      messages[1],
      messages[2],
    ]);
    expect(getMessagesAfterCommittedCursor(messages, 'missing')).toEqual(
      messages,
    );
  });
});
