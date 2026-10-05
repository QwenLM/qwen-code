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
  ExternalIntakeUnknownContextError,
  attachExternalSession,
  completeExternalSubmission,
  getExternalCallerFilePath,
  getExternalTaskForCaller,
  listExternalTasksForCaller,
  readExternalCallerFile,
  recordExternalTaskResult,
  reserveExternalSubmission,
  type ExternalSubmission,
} from './external-intake.js';

const PROJECT_ROOT = '/external-intake-test';
const SESSION = '11111111-2222-4333-8444-555555555555';

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'external-intake-'));
  Storage.setRuntimeBaseDir(runtimeDir);
});

afterEach(async () => {
  Storage.setRuntimeBaseDir(null);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

const submission: ExternalSubmission = {
  callerId: 'share_1',
  targetAgentId: 'ag_lead',
  messageId: 'msg-1',
  text: 'Why is the build slow?',
};

/** Reserve → session → run, as an accepted submission goes through. */
async function accept(
  input: ExternalSubmission,
  taskId: string,
  sessionId = SESSION,
) {
  const reservation = await reserveExternalSubmission(PROJECT_ROOT, input);
  if (!reservation.entry.sessionId) {
    await attachExternalSession(
      PROJECT_ROOT,
      input.callerId,
      reservation.entry.key,
      sessionId,
    );
  }
  return completeExternalSubmission(
    PROJECT_ROOT,
    input.callerId,
    reservation.entry.key,
    taskId,
  );
}

describe('external intake', () => {
  it('treats a retried submission as the same request', async () => {
    const first = await accept(submission, 'sr_1');
    const retry = await reserveExternalSubmission(PROJECT_ROOT, submission);

    expect(retry).toMatchObject({
      outcome: 'duplicate',
      entry: { taskId: 'sr_1', sessionId: SESSION, key: first.key },
    });
  });

  it('resumes a reservation whose run was never recorded', async () => {
    // A crash after the session was made but before the run was recorded:
    // the retry must continue in that session, not create another.
    const first = await reserveExternalSubmission(PROJECT_ROOT, submission);
    await attachExternalSession(
      PROJECT_ROOT,
      'share_1',
      first.entry.key,
      SESSION,
    );
    const retry = await reserveExternalSubmission(PROJECT_ROOT, submission);

    expect(retry).toMatchObject({
      outcome: 'reserved',
      entry: { sessionId: SESSION },
    });
    expect(
      (await readExternalCallerFile(PROJECT_ROOT, 'share_1')).tasks,
    ).toHaveLength(1);
  });

  it('refuses a reused key with different content', async () => {
    await accept(submission, 'sr_1');

    const reused = reserveExternalSubmission(PROJECT_ROOT, {
      ...submission,
      text: 'Something else entirely.',
    });
    await expect(reused).rejects.toBeInstanceOf(ExternalIntakeConflictError);
    await expect(reused).rejects.toMatchObject({ existingTaskId: 'sr_1' });
    // The same message id into another session is different content too.
    await expect(
      reserveExternalSubmission(PROJECT_ROOT, {
        ...submission,
        contextId: SESSION,
      }),
    ).rejects.toBeInstanceOf(ExternalIntakeConflictError);
  });

  it('continues only a context this caller was given for this agent', async () => {
    await accept(submission, 'sr_1');
    const next = { ...submission, messageId: 'msg-2', contextId: SESSION };

    await expect(
      reserveExternalSubmission(PROJECT_ROOT, next),
    ).resolves.toMatchObject({
      outcome: 'reserved',
      entry: { sessionId: SESSION },
    });
    await expect(
      reserveExternalSubmission(PROJECT_ROOT, { ...next, callerId: 'share_2' }),
    ).rejects.toBeInstanceOf(ExternalIntakeUnknownContextError);
    await expect(
      reserveExternalSubmission(PROJECT_ROOT, {
        ...next,
        targetAgentId: 'ag_other',
      }),
    ).rejects.toBeInstanceOf(ExternalIntakeUnknownContextError);
  });

  it("hides one caller's task from another", async () => {
    await accept(submission, 'sr_1');

    await expect(
      getExternalTaskForCaller(PROJECT_ROOT, 'share_1', 'sr_1'),
    ).resolves.toMatchObject({ taskId: 'sr_1' });
    await expect(
      getExternalTaskForCaller(PROJECT_ROOT, 'share_2', 'sr_1'),
    ).resolves.toBeUndefined();
    await expect(
      getExternalTaskForCaller(PROJECT_ROOT, '../share_1', 'sr_1'),
    ).resolves.toBeUndefined();
  });

  it('lists a run shared by coalesced messages once', async () => {
    await accept(submission, 'sr_1');
    await accept(
      { ...submission, messageId: 'msg-2', contextId: SESSION },
      'sr_1',
    );
    await accept(
      { ...submission, messageId: 'msg-3', contextId: SESSION },
      'sr_2',
    );

    const tasks = await listExternalTasksForCaller(
      PROJECT_ROOT,
      'share_1',
      'ag_lead',
    );
    expect(tasks.map((entry) => entry.taskId)).toEqual(['sr_1', 'sr_2']);
    await expect(
      listExternalTasksForCaller(PROJECT_ROOT, 'share_1', 'ag_other'),
    ).resolves.toEqual([]);
  });

  it('keeps the first terminal result', async () => {
    await accept(submission, 'sr_1');
    await accept(
      { ...submission, messageId: 'msg-2', contextId: SESSION },
      'sr_1',
    );

    const first = await recordExternalTaskResult(
      PROJECT_ROOT,
      'share_1',
      'sr_1',
      { state: 'TASK_STATE_COMPLETED', at: 1, answer: 'Done.' },
    );
    const second = await recordExternalTaskResult(
      PROJECT_ROOT,
      'share_1',
      'sr_1',
      { state: 'TASK_STATE_CANCELED', at: 2 },
    );

    expect(first).toEqual(second);
    const file = await readExternalCallerFile(PROJECT_ROOT, 'share_1');
    expect(file.tasks.map((entry) => entry.result?.answer)).toEqual([
      'Done.',
      'Done.',
    ]);
  });

  it('writes the caller file owner-only and refuses a damaged one', async () => {
    await accept(submission, 'sr_1');
    const filePath = getExternalCallerFilePath(PROJECT_ROOT, 'share_1');
    if (process.platform !== 'win32') {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }

    await fs.writeFile(filePath, '{"schemaVersion":1,"callerId":"share_1"}');
    // Treating it as empty would forget every idempotency key in it.
    await expect(
      reserveExternalSubmission(PROJECT_ROOT, submission),
    ).rejects.toThrow('Malformed A2A caller file');
    expect(() => getExternalCallerFilePath(PROJECT_ROOT, '../x')).toThrow(
      'Invalid caller id',
    );
  });
});
