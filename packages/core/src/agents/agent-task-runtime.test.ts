/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import {
  deleteAgentTaskRecord,
  loadAgentTaskRecords,
  readAgentTaskRecord,
  reconcileAgentTaskRecords,
  registerAgentTask,
  updateAgentTaskRecord,
  type AgentTaskRecord,
} from './agent-task-runtime.js';

const warnMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/runLogger.js', () => ({
  runLogger: {
    warn: warnMock,
    log: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => '{}'),
  readdir: vi.fn(async () => []),
  rm: vi.fn(async () => undefined),
}));

const PROJECT_ROOT = '/workspace/project';
const SESSION_ID = 'session-1';
const TASK_ID = 'task-1';

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: file access failed`), { code });
}

function existingRecord(): AgentTaskRecord {
  return {
    taskId: TASK_ID,
    sessionId: SESSION_ID,
    agentId: 'agent-1',
    agentType: 'Explore',
    description: 'Inspect the repository',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('agent task persistence access failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the in-memory record when the initial write is denied', async () => {
    vi.mocked(fs.writeFile).mockRejectedValueOnce(errnoError('EACCES'));

    const record = await registerAgentTask({
      projectRoot: PROJECT_ROOT,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      agentId: 'agent-1',
      agentType: 'Explore',
      resolvedModel: 'auto',
      description: 'Inspect the repository',
    });

    expect(record).toMatchObject({
      taskId: TASK_ID,
      status: 'running',
      resolvedModel: 'auto',
    });
    expect(warnMock).toHaveBeenCalledWith(
      '[agent.task] persistence unavailable',
      'operation=write',
      expect.stringContaining(`task-${TASK_ID}.json`),
      expect.objectContaining({ code: 'EACCES' }),
    );
  });

  it('treats a record denied by the operating system as unavailable', async () => {
    vi.mocked(fs.readFile).mockRejectedValueOnce(errnoError('EPERM'));

    await expect(
      readAgentTaskRecord(PROJECT_ROOT, SESSION_ID, TASK_ID),
    ).resolves.toBeNull();
  });

  it('does not hide unrelated read failures', async () => {
    vi.mocked(fs.readFile).mockRejectedValueOnce(errnoError('EIO'));

    await expect(
      readAgentTaskRecord(PROJECT_ROOT, SESSION_ID, TASK_ID),
    ).rejects.toThrow('EIO');
  });

  it('returns the in-memory update when an updated record cannot be persisted', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify(existingRecord()),
    );
    vi.mocked(fs.writeFile).mockRejectedValueOnce(errnoError('EROFS'));

    await expect(
      updateAgentTaskRecord(PROJECT_ROOT, SESSION_ID, TASK_ID, {
        status: 'completed',
      }),
    ).resolves.toMatchObject({ status: 'completed' });
  });

  it('reconciles an inactive task in memory when the directory becomes read-only', async () => {
    vi.mocked(fs.readdir).mockResolvedValueOnce([
      `task-${TASK_ID}.json`,
    ] as never);
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({
        ...existingRecord(),
        executionId: 'inactive-execution',
      }),
    );
    vi.mocked(fs.writeFile).mockRejectedValueOnce(errnoError('EROFS'));

    await expect(
      reconcileAgentTaskRecords(PROJECT_ROOT, SESSION_ID),
    ).resolves.toEqual([
      expect.objectContaining({
        taskId: TASK_ID,
        status: 'interrupted',
      }),
    ]);
  });

  it('returns no recoverable records when directory access is denied', async () => {
    vi.mocked(fs.readdir).mockRejectedValueOnce(errnoError('EACCES'));

    await expect(
      loadAgentTaskRecords(PROJECT_ROOT, SESSION_ID),
    ).resolves.toEqual([]);
  });

  it('tolerates a denied cleanup', async () => {
    vi.mocked(fs.rm).mockRejectedValueOnce(errnoError('EPERM'));

    await expect(
      deleteAgentTaskRecord(PROJECT_ROOT, SESSION_ID, TASK_ID),
    ).resolves.toBeUndefined();
  });
});
