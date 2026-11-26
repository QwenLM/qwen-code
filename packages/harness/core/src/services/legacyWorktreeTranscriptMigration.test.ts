/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionTranscriptPath } from './transcript-paths.js';
import { migrateLegacyWorktreeTranscript } from './legacyWorktreeTranscriptMigration.js';
import { _resetConfigHomeDirCache } from '../utils/paths.js';
import { createTestTranscriptWriter } from './transcript/testing/fixtures.js';
import { createUserMessage } from '../protocol/index.js';
import {
  getSubagentTranscriptPath,
  readSubagentTranscript,
  createSubagentTranscriptRecorder,
} from './subagent-transcript.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { readAgentTaskRecord } from '../agents/agent-task-runtime.js';

describe('legacyWorktreeTranscriptMigration', () => {
  let tempHome: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'test-legacy-jsonl-'));
    originalCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'test-source-'));
    vi.stubEnv('HOME', tempHome);
    _resetConfigHomeDirCache();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    _resetConfigHomeDirCache();
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(originalCwd, { recursive: true, force: true });
  });

  it.each(['different-copy', 'same-inode'] as const)(
    'handles an existing destination without overwriting another transcript: %s',
    async (kind) => {
      const sessionId = 'session-conflict';
      const selectedPath = path.join(
        tempHome,
        'selected',
        `${sessionId}.jsonl`,
      );
      const targetPath = getSessionTranscriptPath(originalCwd, sessionId);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const { writer, store } = await createTestTranscriptWriter({
        filePath: selectedPath,
        sessionId,
        cwd: originalCwd,
        entrypoint: 'cli',
      });
      await writer.recordMessages([createUserMessage('selected history')]);
      await writer.flush();
      if (kind === 'same-inode') {
        await fs.link(selectedPath, targetPath);
      } else {
        await fs.writeFile(targetPath, 'existing');
      }

      await expect(
        migrateLegacyWorktreeTranscript({
          sessionId,
          selectedPath,
          originalCwd,
          relocate: (cwd) =>
            writer.relocate({
              filePath: targetPath,
              cwd,
              worktreeSession: null,
            }),
        }),
      ).resolves.toBeUndefined();
      try {
        if (kind === 'same-inode') {
          expect(writer.getSessionFilePath()).toBe(
            await fs.realpath(targetPath),
          );
          await expect(fs.stat(selectedPath)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(await fs.readFile(targetPath, 'utf8')).toContain(
            'selected history',
          );
        } else {
          expect(writer.getSessionFilePath()).toBe(
            await fs.realpath(selectedPath),
          );
          await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe(
            'existing',
          );
        }
      } finally {
        await writer.close();
        await store.close();
      }
    },
  );

  it('keeps the selected JSONL when exclusive relocation fails', async () => {
    const sessionId = 'session-io-failure';
    const selectedPath = path.join(tempHome, 'selected', `${sessionId}.jsonl`);

    await expect(
      migrateLegacyWorktreeTranscript({
        sessionId,
        selectedPath,
        originalCwd,
        relocate: vi.fn().mockRejectedValue(new Error('I/O failure')),
      }),
    ).resolves.toBeUndefined();
  });

  it('relocates to the original bucket after exclusive relocation succeeds', async () => {
    const sessionId = 'session-migrated';
    const selectedPath = path.join(tempHome, 'selected', `${sessionId}.jsonl`);
    const relocate = vi.fn().mockResolvedValue(undefined);

    await expect(
      migrateLegacyWorktreeTranscript({
        sessionId,
        selectedPath,
        originalCwd,
        relocate,
      }),
    ).resolves.toBeUndefined();
    expect(relocate).toHaveBeenCalledWith(originalCwd);
  });

  it.each(['empty-target', 'existing-task', 'different-transcript'] as const)(
    'keeps a legacy session and its subagents together without mixing copies (%s)',
    async (target) => {
      const existingTaskRecord = target !== 'empty-target';
      const sessionId = 'session-with-agent';
      const agentId = 'historical-agent';
      const selectedPath = getSessionTranscriptPath(tempHome, sessionId);
      const sourceAgentPath = getSubagentTranscriptPath(
        tempHome,
        sessionId,
        agentId,
      );
      const targetPath = getSessionTranscriptPath(originalCwd, sessionId);
      const main = await createTestTranscriptWriter({
        filePath: selectedPath,
        sessionId,
        cwd: tempHome,
        entrypoint: 'cli',
      });
      const child = await createTestTranscriptWriter({
        filePath: sourceAgentPath,
        sessionId,
        cwd: tempHome,
        entrypoint: 'cli',
      });
      const taskName = 'task-historical-agent.json';
      const targetTaskPath = path.join(
        path.dirname(
          getSubagentTranscriptPath(originalCwd, sessionId, agentId),
        ),
        taskName,
      );
      try {
        await main.writer.recordMessages([createUserMessage('main history')]);
        await child.writer.recordSidechainMessages(
          [createUserMessage('agent history')],
          agentId,
        );
        await child.writer.close();
        await fs.writeFile(
          path.join(path.dirname(sourceAgentPath), taskName),
          '{"status":"completed"}',
        );
        if (existingTaskRecord) {
          await fs.mkdir(path.dirname(targetTaskPath), { recursive: true });
          await fs.writeFile(targetTaskPath, '{"status":"running"}');
        }
        if (target === 'different-transcript') {
          await fs.writeFile(targetPath, 'another copy');
        }
        await migrateLegacyWorktreeTranscript({
          sessionId,
          selectedPath,
          originalCwd,
          relocate: (cwd) =>
            main.writer.relocate({
              filePath: targetPath,
              cwd,
              worktreeSession: null,
            }),
        });
        // 精确选择是关联产物的身份来源，不能从 originalCwd 的同 ID 副本混读。
        const config = makeFakeConfig({
          targetDir: originalCwd,
          cwd: originalCwd,
          sessionId,
          transcriptStore: main.store,
        });
        config.registerSessionRuntimeBinding({
          refreshRuntimeContext: async () => undefined,
          getTranscriptPath: () => main.writer.getSessionFilePath(),
        });
        const source = {
          sessionTranscriptPath: config.getActiveSessionTranscriptPath(),
        };
        expect(
          await readAgentTaskRecord(source, sessionId, 'historical-agent'),
        ).toMatchObject({ status: 'completed' });
        const transcript = await readSubagentTranscript(
          source,
          sessionId,
          agentId,
        );
        expect(transcript?.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({ content: 'agent history' }),
            }),
          ]),
        );
        expect(main.writer.getSessionFilePath()).toBe(
          await fs.realpath(selectedPath),
        );
        const recorder = await createSubagentTranscriptRecorder(
          config,
          agentId,
          'resumed-task',
          () => {},
        );
        await recorder.recordSidechainMessages(
          [createUserMessage('continued agent history')],
          agentId,
          transcript!.leafUuid,
        );
        await recorder.close();
        const continued = await readSubagentTranscript(
          source,
          sessionId,
          agentId,
        );
        expect(continued?.messages).toHaveLength(2);
        if (existingTaskRecord) {
          expect(await fs.readFile(targetTaskPath, 'utf8')).toBe(
            '{"status":"running"}',
          );
        } else {
          await expect(fs.stat(targetTaskPath)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
        if (target === 'different-transcript') {
          expect(await fs.readFile(targetPath, 'utf8')).toBe('another copy');
        }
        expect(
          await fs.readFile(
            path.join(path.dirname(sourceAgentPath), taskName),
            'utf8',
          ),
        ).toBe('{"status":"completed"}');
      } finally {
        await main.writer.close();
        await main.store.close();
        await child.store.close();
      }
    },
  );
});
