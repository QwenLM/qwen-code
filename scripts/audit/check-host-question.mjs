// Run: node --import tsx scripts/audit/check-host-question.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../../packages/core/src/config/storage.ts';
import {
  createThread,
  readThread,
  writeThread,
  updateWorkspaceAgents,
} from '../../packages/core/src/agents/workspace-agents/store.ts';
import { postMessage } from '../../packages/core/src/agents/workspace-agents/thread-actions.ts';
import {
  pickupRunForHost,
  reportHostRunProgress,
  answerHostQuestion,
} from '../../packages/core/src/agents/workspace-agents/host-lease.ts';
import { HUMAN_AUTHOR_ID } from '../../packages/core/src/agents/workspace-agents/types.ts';

const dir = await mkdtemp(join(tmpdir(), 'host-question-check-'));
const root = '/host-question-check';
try {
  Storage.setRuntimeBaseDir(dir);
  await updateWorkspaceAgents(root, () => [
    {
      id: 'ag_alice',
      name: 'alice',
      createdAt: 1,
      execution: { mode: 'managed-host', hostIds: ['host_check'] },
    },
  ]);
  const { id } = await createThread(root, { title: 'Question check' });
  await postMessage(root, id, { from: HUMAN_AUTHOR_ID, text: '@alice ask' });
  const assignment = await pickupRunForHost(root, 'host_check');
  assert.ok(assignment);
  const input = {
    threadId: id,
    runId: assignment.runId,
    hostId: 'host_check',
    leaseId: assignment.lease.leaseId,
    attempt: assignment.attempt,
    sequence: 1,
    stage: 'waiting_input',
    detail: 'Choose',
  };
  const question = {
    requestId: 'request-1',
    submitOptionId: 'submit',
    questions: [
      {
        header: 'Target',
        question: 'Where?',
        options: [{ label: 'Staging', description: '' }],
      },
    ],
  };
  const read = () => readThread(root, id);
  const answer = (requestId, answers) =>
    answerHostQuestion(root, id, assignment.runId, requestId, answers);
  assert.equal(
    (await reportHostRunProgress(root, { ...input, question })).ok,
    true,
  );
  assert.equal((await read()).runs[0].progress.question.leaseId, input.leaseId);
  assert.equal(
    (await answer('wrong-request', { 0: 'Staging' })).reason,
    'question_expired',
  );
  assert.equal((await answer('request-1', {})).reason, 'invalid_answers');
  assert.equal((await answer('request-1', { 0: 'Staging' })).ok, true);
  assert.equal((await answer('request-1', { 0: 'Staging' })).ok, true);
  assert.equal(
    (await answer('request-1', { 0: 'Production' })).reason,
    'already_answered',
  );
  for (const sequence of [1, 2]) {
    const result = await reportHostRunProgress(root, {
      ...input,
      sequence,
      question,
    });
    assert.deepEqual(result.question.answers, { 0: 'Staging' });
    assert.deepEqual((await read()).runs[0].progress.question.answers, {
      0: 'Staging',
    });
  }
  const answered = await read();
  for (const change of [
    { status: 'completed' },
    { attempts: assignment.attempt + 1 },
    { lease: { ...assignment.lease, leaseId: 'new-lease' } },
    { lease: { ...assignment.lease, expiresAt: Date.now() - 1 } },
  ]) {
    await writeThread(root, {
      ...answered,
      runs: [{ ...answered.runs[0], ...change }],
    });
    assert.equal(
      (await answer('request-1', { 0: 'Staging' })).reason,
      'question_expired',
    );
  }
  await writeThread(root, { ...answered, status: 'done' });
  assert.equal(
    (await answer('request-1', { 0: 'Staging' })).reason,
    'question_expired',
  );
  await writeThread(root, answered);
  assert.equal(
    (
      await reportHostRunProgress(root, {
        ...input,
        sequence: 3,
        leaseId: 'wrong',
        question,
      })
    ).ok,
    false,
  );
  assert.deepEqual((await read()).runs[0].progress.question.answers, {
    0: 'Staging',
  });
  assert.equal(
    (
      await reportHostRunProgress(root, {
        ...input,
        sequence: 3,
        question: { ...question, requestId: 'request-2' },
      })
    ).ok,
    true,
  );
  assert.equal(
    (await answer('request-1', { 0: 'Staging' })).reason,
    'question_expired',
  );
  assert.equal((await read()).runs[0].progress.question.answers, undefined);
  assert.equal(
    (
      await reportHostRunProgress(root, {
        ...input,
        sequence: 4,
        question: null,
      })
    ).ok,
    true,
  );
  assert.equal((await read()).runs[0].progress.question, undefined);
  console.log(
    'PASS persisted question and answer; duplicate answer idempotent; changed answer refused; heartbeat retained answer; stale request/run/attempt/lease and terminal thread refused; replacement isolated; null cleared',
  );
} finally {
  Storage.setRuntimeBaseDir(null);
  await rm(dir, { recursive: true, force: true });
}
