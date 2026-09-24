/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../../config/storage.js';
import {
  ExternalIntakeConflictError,
  acceptExternalSubmission,
  getExternalThreadForCaller,
  listExternalThreadsForCaller,
  type ExternalSubmission,
} from './external-intake.js';
import { listThreads, updateWorkspaceAgents } from './store.js';

const PROJECT_ROOT = '/external-intake-test';

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'external-intake-'));
  Storage.setRuntimeBaseDir(runtimeDir);
  await updateWorkspaceAgents(PROJECT_ROOT, () => [
    { id: 'ag_lead', name: 'lead', createdAt: 1 },
  ]);
});

afterEach(async () => {
  Storage.setRuntimeBaseDir(null);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

const submission: ExternalSubmission = {
  callerId: 'share_1',
  targetAgentId: 'ag_lead',
  messageId: 'msg-1',
  title: 'Explain the build',
  body: 'Why is the build slow?',
};

describe('external intake', () => {
  it('treats a retried submission as the same request', async () => {
    const first = await acceptExternalSubmission(PROJECT_ROOT, submission);
    const retry = await acceptExternalSubmission(PROJECT_ROOT, submission);

    expect(first.outcome).toBe('accepted');
    expect(retry).toMatchObject({
      outcome: 'duplicate',
      thread: { id: first.thread.id },
    });
    const { threads } = await listThreads(PROJECT_ROOT);
    expect(threads).toHaveLength(1);
    // The retry does not post the message a second time.
    expect(threads[0]?.messages).toHaveLength(1);
  });

  it('refuses the same message id with different content', async () => {
    await acceptExternalSubmission(PROJECT_ROOT, submission);

    await expect(
      acceptExternalSubmission(PROJECT_ROOT, {
        ...submission,
        body: 'Something else entirely',
      }),
    ).rejects.toBeInstanceOf(ExternalIntakeConflictError);
  });

  it('shows each caller only its own threads', async () => {
    const { thread } = await acceptExternalSubmission(PROJECT_ROOT, submission);

    await expect(
      listExternalThreadsForCaller(PROJECT_ROOT, 'share_2'),
    ).resolves.toEqual([]);
    await expect(
      getExternalThreadForCaller(PROJECT_ROOT, 'share_2', thread.id),
    ).resolves.toBeUndefined();
    await expect(
      getExternalThreadForCaller(PROJECT_ROOT, 'share_1', thread.id),
    ).resolves.toMatchObject({ id: thread.id });
  });
});
