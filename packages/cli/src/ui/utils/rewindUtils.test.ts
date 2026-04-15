/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { buildRewindEntries, formatCodeSummary } from './rewindUtils.js';

describe('rewindUtils', () => {
  let tempDir: string;
  let checkpointsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rewind-utils-test-'));
    checkpointsDir = path.join(tempDir, 'checkpoints');
    await fs.mkdir(checkpointsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('formats code summaries for zero, one, and many files', () => {
    expect(formatCodeSummary([])).toEqual({
      hasChanges: false,
      summaryText: 'No code changes',
      detailText: 'The code will be unchanged.',
      changes: [],
    });

    expect(
      formatCodeSummary([{ path: 'a.ts', additions: 3, deletions: 1 }]),
    ).toEqual({
      hasChanges: true,
      summaryText: 'a.ts +3 -1',
      detailText: 'The code will be restored +3 -1 in a.ts.',
      changes: [{ path: 'a.ts', additions: 3, deletions: 1 }],
    });

    expect(
      formatCodeSummary([
        { path: 'a.ts', additions: 3, deletions: 1 },
        { path: 'b.ts', additions: 2, deletions: 4 },
      ]),
    ).toEqual({
      hasChanges: true,
      summaryText: '2 files changed +5 -5',
      detailText: 'The code will be restored across 2 files (+5 -5).',
      changes: [
        { path: 'a.ts', additions: 3, deletions: 1 },
        { path: 'b.ts', additions: 2, deletions: 4 },
      ],
    });
  });

  it('builds rewind entries with checkpoint summaries and current item', async () => {
    await fs.writeFile(
      path.join(checkpointsDir, 'cp-1.json'),
      JSON.stringify({
        sessionId: 'session-1',
        createdAt: '2025-01-01T00:02:30.000Z',
        commitHash: 'snap-1',
      }),
    );
    await fs.writeFile(
      path.join(checkpointsDir, 'cp-other.json'),
      JSON.stringify({
        sessionId: 'other-session',
        createdAt: '2025-01-01T00:00:40.000Z',
        commitHash: 'snap-other',
      }),
    );

    const getSnapshotDiffSummary = vi
      .fn()
      .mockResolvedValueOnce([{ path: 'test.py', additions: 10, deletions: 2 }])
      .mockResolvedValueOnce([
        { path: 'test.py', additions: 10, deletions: 2 },
      ]);
    const config = {
      getCheckpointingEnabled: () => true,
      getSessionId: () => 'session-1',
      getResumedSessionData: () => undefined,
      storage: {
        getProjectTempCheckpointsDir: () => checkpointsDir,
      },
      getSessionService: () => ({
        loadSession: vi.fn().mockResolvedValue({
          conversation: {
            sessionId: 'session-1',
            projectHash: 'project-1',
            startTime: '2025-01-01T00:00:00.000Z',
            lastUpdated: '2025-01-01T00:01:00.000Z',
            messages: [
              {
                uuid: 'u1',
                parentUuid: null,
                sessionId: 'session-1',
                timestamp: '2025-01-01T00:00:00.000Z',
                type: 'user',
                message: { role: 'user', parts: [{ text: 'hi' }] },
                cwd: '/tmp/project',
                version: '1.0.0',
              },
              {
                uuid: 'u2',
                parentUuid: 'a1',
                sessionId: 'session-1',
                timestamp: '2025-01-01T00:01:00.000Z',
                type: 'user',
                message: { role: 'user', parts: [{ text: 'how are you?' }] },
                cwd: '/tmp/project',
                version: '1.0.0',
              },
              {
                uuid: 'u3',
                parentUuid: 'a2',
                sessionId: 'session-1',
                timestamp: '2025-01-01T00:02:00.000Z',
                type: 'user',
                message: {
                  role: 'user',
                  parts: [{ text: 'create a python file' }],
                },
                cwd: '/tmp/project',
                version: '1.0.0',
              },
              {
                uuid: 'tool-1',
                parentUuid: 'u3',
                sessionId: 'session-1',
                timestamp: '2025-01-01T00:02:30.000Z',
                type: 'tool_result',
                message: { role: 'user', parts: [] },
                cwd: '/tmp/project',
                version: '1.0.0',
                toolCallResult: {
                  status: 'success',
                  resultDisplay: {
                    fileName: 'test.py',
                    diffStat: {
                      model_added_lines: 10,
                      model_removed_lines: 2,
                    },
                  },
                },
              },
            ],
          },
          filePath: '/tmp/project/chats/session-1.jsonl',
          lastCompletedUuid: 'tool-1',
        }),
      }),
      getGitService: vi.fn().mockResolvedValue({
        getSnapshotDiffSummary,
      }),
    } as unknown as Config;

    const entries = await buildRewindEntries(config, 'session-1');

    expect(entries).toEqual([
      expect.objectContaining({
        key: 'u1',
        label: 'hi',
        codeSummary: expect.objectContaining({
          hasChanges: false,
          summaryText: 'No code changes',
        }),
        restoreCodeSummary: expect.objectContaining({
          hasChanges: true,
          summaryText: 'test.py +10 -2',
          checkpointCommitHash: 'snap-1',
        }),
      }),
      expect.objectContaining({
        key: 'u2',
        label: 'how are you?',
        codeSummary: expect.objectContaining({
          hasChanges: false,
          summaryText: 'No code changes',
        }),
        restoreCodeSummary: expect.objectContaining({
          hasChanges: true,
          summaryText: 'test.py +10 -2',
          checkpointCommitHash: 'snap-1',
        }),
      }),
      expect.objectContaining({
        key: 'u3',
        label: 'create a python file',
        codeSummary: expect.objectContaining({
          hasChanges: true,
          summaryText: 'test.py +10 -2',
        }),
        restoreCodeSummary: expect.objectContaining({
          hasChanges: true,
          summaryText: 'test.py +10 -2',
          checkpointCommitHash: 'snap-1',
        }),
      }),
      expect.objectContaining({
        key: 'current',
        kind: 'current',
        label: '(current)',
      }),
    ]);
    expect(getSnapshotDiffSummary).toHaveBeenCalledTimes(1);
    expect(getSnapshotDiffSummary).toHaveBeenCalledWith('snap-1');
  });

  it('skips checkpoint loading when checkpointing is disabled', async () => {
    const config = {
      getCheckpointingEnabled: () => false,
      getSessionId: () => 'session-1',
      getResumedSessionData: () => undefined,
      storage: {
        getProjectTempCheckpointsDir: () => checkpointsDir,
      },
      getSessionService: () => ({
        loadSession: vi.fn().mockResolvedValue({
          conversation: {
            sessionId: 'session-1',
            projectHash: 'project-1',
            startTime: '2025-01-01T00:00:00.000Z',
            lastUpdated: '2025-01-01T00:00:00.000Z',
            messages: [
              {
                uuid: 'u1',
                parentUuid: null,
                sessionId: 'session-1',
                timestamp: '2025-01-01T00:00:00.000Z',
                type: 'user',
                message: { role: 'user', parts: [{ text: 'hi' }] },
                cwd: '/tmp/project',
                version: '1.0.0',
              },
            ],
          },
          filePath: '/tmp/project/chats/session-1.jsonl',
          lastCompletedUuid: 'u1',
        }),
      }),
      getGitService: vi.fn(),
    } as unknown as Config;

    const entries = await buildRewindEntries(config, 'session-1');

    expect(entries[0]).toEqual(
      expect.objectContaining({
        key: 'u1',
        codeSummary: expect.objectContaining({
          hasChanges: false,
          summaryText: 'No code changes',
        }),
      }),
    );
    expect(config.getGitService).not.toHaveBeenCalled();
  });

  it('prefers the active resumed branch over the latest persisted leaf', async () => {
    const getSnapshotDiffSummary = vi.fn().mockResolvedValue([]);
    const config = {
      getCheckpointingEnabled: () => true,
      getSessionId: () => 'session-1',
      getResumedSessionData: () => ({
        conversation: {
          sessionId: 'session-1',
          projectHash: 'project-1',
          startTime: '2025-01-01T00:00:00.000Z',
          lastUpdated: '2025-01-01T00:02:00.000Z',
          messages: [
            {
              uuid: 'u1',
              parentUuid: null,
              sessionId: 'session-1',
              timestamp: '2025-01-01T00:00:00.000Z',
              type: 'user',
              message: { role: 'user', parts: [{ text: 'hello' }] },
              cwd: '/tmp/project',
              version: '1.0.0',
            },
          ],
        },
        filePath: '/tmp/project/chats/session-1.jsonl',
        lastCompletedUuid: 'u1',
      }),
      storage: {
        getProjectTempCheckpointsDir: () => checkpointsDir,
      },
      getSessionService: () => ({
        loadSession: vi.fn().mockResolvedValue({
          conversation: {
            sessionId: 'session-1',
            projectHash: 'project-1',
            startTime: '2025-01-01T00:00:00.000Z',
            lastUpdated: '2025-01-01T00:01:00.000Z',
            messages: [
              {
                uuid: 'u1',
                parentUuid: null,
                sessionId: 'session-1',
                timestamp: '2025-01-01T00:00:00.000Z',
                type: 'user',
                message: { role: 'user', parts: [{ text: 'hello' }] },
                cwd: '/tmp/project',
                version: '1.0.0',
              },
              {
                uuid: 'u2',
                parentUuid: 'a1',
                sessionId: 'session-1',
                timestamp: '2025-01-01T00:01:00.000Z',
                type: 'user',
                message: { role: 'user', parts: [{ text: 'old branch' }] },
                cwd: '/tmp/project',
                version: '1.0.0',
              },
            ],
          },
          filePath: '/tmp/project/chats/session-1.jsonl',
          lastCompletedUuid: 'u2',
        }),
      }),
      getGitService: vi.fn().mockResolvedValue({
        getSnapshotDiffSummary,
      }),
    } as unknown as Config;

    const entries = await buildRewindEntries(config, 'session-1');

    expect(entries.map((entry) => entry.label)).toEqual(['hello', '(current)']);
  });

  it('falls back to newer persisted history after additional turns', async () => {
    const config = {
      getCheckpointingEnabled: () => false,
      getSessionId: () => 'session-1',
      getResumedSessionData: () => ({
        conversation: {
          sessionId: 'session-1',
          projectHash: 'project-1',
          startTime: '2025-01-01T00:00:00.000Z',
          lastUpdated: '2025-01-01T00:02:00.000Z',
          messages: [
            {
              uuid: 'u1',
              parentUuid: null,
              sessionId: 'session-1',
              timestamp: '2025-01-01T00:00:00.000Z',
              type: 'user',
              message: { role: 'user', parts: [{ text: 'hello' }] },
              cwd: '/tmp/project',
              version: '1.0.0',
            },
          ],
        },
        filePath: '/tmp/project/chats/session-1.jsonl',
        lastCompletedUuid: 'u1',
      }),
      storage: {
        getProjectTempCheckpointsDir: () => checkpointsDir,
      },
      getSessionService: () => ({
        loadSession: vi.fn().mockResolvedValue({
          conversation: {
            sessionId: 'session-1',
            projectHash: 'project-1',
            startTime: '2025-01-01T00:00:00.000Z',
            lastUpdated: '2025-01-01T00:03:00.000Z',
            messages: [
              {
                uuid: 'u1',
                parentUuid: null,
                sessionId: 'session-1',
                timestamp: '2025-01-01T00:00:00.000Z',
                type: 'user',
                message: { role: 'user', parts: [{ text: 'hello' }] },
                cwd: '/tmp/project',
                version: '1.0.0',
              },
              {
                uuid: 'u2',
                parentUuid: 'a1',
                sessionId: 'session-1',
                timestamp: '2025-01-01T00:02:30.000Z',
                type: 'user',
                message: { role: 'user', parts: [{ text: 'who are you ?' }] },
                cwd: '/tmp/project',
                version: '1.0.0',
              },
            ],
          },
          filePath: '/tmp/project/chats/session-1.jsonl',
          lastCompletedUuid: 'u2',
        }),
      }),
      getGitService: vi.fn(),
    } as unknown as Config;

    const entries = await buildRewindEntries(config, 'session-1');

    expect(entries.map((entry) => entry.label)).toEqual([
      'hello',
      'who are you ?',
      '(current)',
    ]);
  });
});
