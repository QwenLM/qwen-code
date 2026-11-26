/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptRepository } from './repository.js';
import { beginResumeRead } from './resume-read-budget.js';
import { createTestTranscriptWriter } from './testing/fixtures.js';
import { createUserMessage } from '../../protocol/transcript/conversions.js';
import { runLogger } from '../../utils/runLogger.js';

vi.mock('../../utils/runLogger.js', () => ({
  runLogger: {
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const directories: string[] = [];
const sessionId = 'legacy-session';
const repository = new TranscriptRepository();
const fields = {
  sessionId,
  timestamp: '2026-01-01T00:00:00.000Z',
  isSidechain: false,
};
const user = {
  ...fields,
  type: 'user',
  uuid: 'user',
  parentUuid: null,
  message: { role: 'user', content: 'question' },
};
const assistant = {
  ...fields,
  type: 'assistant',
  uuid: 'assistant',
  parentUuid: 'user',
  message: {
    id: 'answer-id',
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'answer' }],
  },
};
const marker = {
  type: 'active-leaf',
  sessionId,
  leafUuid: 'assistant',
  explicit: true,
  timestamp: 1,
};

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(entries: readonly unknown[]) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'transcript-compatibility-'),
  );
  directories.push(directory);
  const filePath = path.join(directory, `${sessionId}.jsonl`);
  await fs.writeFile(
    filePath,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
  return filePath;
}

async function resume(filePath: string, resumeSessionAt?: string) {
  const attempt = await beginResumeRead();
  try {
    return await repository.readForResume(filePath, {
      sessionId,
      attempt,
      resumeSessionAt,
    });
  } finally {
    attempt.finish();
  }
}

describe('historical transcript read compatibility', () => {
  it.each(['resume', 'bounded'] as const)(
    '%s ignores invalid content on inactive branches without losing graph identities',
    async (mode) => {
      const filePath = await fixture([
        user,
        assistant,
        {
          ...assistant,
          uuid: 'inactive-assistant',
          parentUuid: null,
          message: { ...assistant.message, id: 'inactive-id', content: null },
        },
        {
          ...user,
          uuid: 'inactive-user',
          parentUuid: null,
          message: { role: 'user', content: [null] },
        },
        {
          ...fields,
          type: 'system',
          uuid: 'inactive-system',
          parentUuid: null,
          subtype: 'informational',
          content: null,
        },
        marker,
      ]);
      const original = await fs.readFile(filePath, 'utf8');
      const result =
        mode === 'resume'
          ? await resume(filePath)
          : await repository.resolveBoundedSession(filePath, { sessionId });
      expect(result?.chain.map((entry) => entry.uuid)).toEqual([
        'user',
        'assistant',
      ]);
      const index = await repository.loadBoundedIndex(filePath);
      expect(index?.messagesByUuid.has('inactive-assistant')).toBe(true);
      expect(await fs.readFile(filePath, 'utf8')).toBe(original);
    },
  );

  it('normalizes legacy assistant text only in the projection and can append after recovery', async () => {
    const legacy = {
      ...assistant,
      message: { ...assistant.message, content: 'legacy answer' },
    };
    const filePath = await fixture([user, legacy, marker]);
    const original = await fs.readFile(filePath, 'utf8');
    const result = await resume(filePath);
    expect(result?.messages.at(-1)).toMatchObject({
      message: { content: [{ type: 'text', text: 'legacy answer' }] },
    });
    expect(result?.chain.at(-1)).toEqual(legacy);
    expect(result?.writerState.mainParentUuid).toBe('assistant');
    const { writer, store } = await createTestTranscriptWriter({
      filePath,
      sessionId,
      cwd: path.dirname(filePath),
      entrypoint: 'test',
    });
    const next = createUserMessage('continue');
    try {
      await writer.recordMessages([next], undefined, { immediate: true });
    } finally {
      await writer.close();
      await store.close();
    }
    const written = await fs.readFile(filePath, 'utf8');
    expect(written.startsWith(original)).toBe(true);
    const persisted = written
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(persisted.find((entry) => entry.uuid === next.uuid).parentUuid).toBe(
      'assistant',
    );
    expect((await resume(filePath))?.chain.map((entry) => entry.uuid)).toEqual([
      'user',
      'assistant',
      next.uuid,
    ]);
  });

  it('uses the last UUID version before inspecting content and does not resurrect overwritten data', async () => {
    const broken = {
      ...assistant,
      message: { ...assistant.message, content: null },
    };
    const filePath = await fixture([user, broken, assistant, marker]);
    expect((await resume(filePath))?.chain).toEqual([user, assistant]);
    await fs.appendFile(filePath, JSON.stringify(broken) + '\n');
    await expect(resume(filePath)).rejects.toMatchObject({
      code: 'RESUME_READ_UNSAFE',
    });
  });

  it('skips unusable optional snapshots and replacements without reviving stale snapshots', async () => {
    const replacement = {
      messageUuid: 'assistant',
      blockIndex: 0,
      originalType: 'text',
      stubContent: 'stub',
    };
    const filePath = await fixture([
      user,
      assistant,
      marker,
      {
        type: 'file-history-snapshot',
        messageId: 'assistant',
        isSnapshotUpdate: false,
        snapshot: { trackedFileBackups: {}, timestamp: '2026-01-01' },
      },
      // The latest invalid snapshot must not resurrect an older rollback state.
      {
        type: 'file-history-snapshot',
        messageId: 'assistant',
        isSnapshotUpdate: true,
        snapshot: { trackedFileBackups: { 'file.txt': null } },
      },
      {
        type: 'content-replacement',
        sessionId,
        replacements: [null, {}, replacement],
      },
    ]);
    const original = await fs.readFile(filePath, 'utf8');
    const result = await resume(filePath);
    expect(result?.fileHistorySnapshots).toEqual([]);
    expect(result?.contentReplacements.get(sessionId)).toEqual([replacement]);
    expect(result?.chain.map((entry) => entry.uuid)).toEqual(['user', 'assistant']);
    expect(runLogger.warn).toHaveBeenCalledWith(
      'transcript.resume.invalid_file_snapshot_skipped',
      { messageId: 'assistant' },
    );
    expect(await fs.readFile(filePath, 'utf8')).toBe(original);
  });

  it.each([null, [null]])(
    'reports the selected invalid content precisely without silently losing a message: %j',
    async (content) => {
      const filePath = await fixture([
        user,
        { ...assistant, message: { ...assistant.message, content } },
        marker,
      ]);
      const original = await fs.readFile(filePath, 'utf8');
      await expect(resume(filePath)).rejects.toMatchObject({
        code: 'RESUME_READ_UNSAFE',
        message: expect.stringContaining(
          'assistant assistant, message.content',
        ),
      });
      expect(await fs.readFile(filePath, 'utf8')).toBe(original);
    },
  );

  it('selects a historical resume point before projecting malformed future messages', async () => {
    const filePath = await fixture([
      user,
      { ...assistant, message: { ...assistant.message, content: null } },
      marker,
    ]);
    const result = await resume(filePath, 'user');
    expect(result?.chain.map((entry) => entry.uuid)).toEqual(['user']);
    expect(result?.writerState.mainParentUuid).toBe('user');
    await expect(resume(filePath, 'missing')).rejects.toMatchObject({
      code: 'RESUME_READ_UNSAFE',
    });
  });

});
