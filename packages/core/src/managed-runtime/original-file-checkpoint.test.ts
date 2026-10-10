/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { inspectOriginalFileCheckpointCoverage } from './original-file-checkpoint.js';
import {
  parseHarnessCheckpointV1,
  encodeHarnessCheckpointV1,
  createNextTurnReadyHarnessCheckpoint,
} from './managed-harness-checkpoint.js';
import {
  csiFileSession as fixture,
  closeCsiFileFixtures,
} from './__tests__/csi-file-session.js';

afterEach(closeCsiFileFixtures);

describe('original native file settlement proof', () => {
  it.each(['success', 'error'] as const)(
    'pins the original Write %s outcome against a fixed response shape',
    async (status) => {
      const f = await fixture('write_file', status);
      expect(
        JSON.parse((await f.resources.read(f.outcomeRef)).toString('utf8')),
      ).toEqual({
        executionCallId: 'execution',
        functionResponse: {
          id: 'model-call',
          name: 'write_file',
          response:
            status === 'success'
              ? { output: 'full result', executionStatus: 'success' }
              : { error: 'full result', executionStatus: 'error' },
        },
      });
    },
  );
  it('accepts the native atomic turn-complete boundary after consumption', async () => {
    const f = await fixture('write_file');
    await f.harness.consumeRuntimeResults();
    await f.harness.settleConsumedRuntimeContinuation();
    const coveredSequence = f.session.authority.committedSequence;
    const resultRef = await f.resources.publish(
      'managed-turn-result',
      Buffer.from('{}'),
    );
    await f.session.authority.commitTurnComplete(
      {
        operation: 'settleTurn',
        commandId: 'turn-done',
        sessionKey: f.session.authority.sessionHeader.sessionKey,
        contentDigest: resultRef.digest,
      },
      {
        turn: {
          turnId: f.promptId,
          outcome: 'completed',
          stopReason: 'end_turn',
          resultRef,
          occurredAt: Date.now(),
          eventId: 'turn-done',
        },
        boundary: 'turn_complete',
        state: (identity, previous) =>
          encodeHarnessCheckpointV1(
            createNextTurnReadyHarnessCheckpoint({
              previous,
              ...identity,
              activationId: f.session.activation.activationId,
              turnId: f.promptId,
              promptId: f.promptId,
            }),
          ),
      },
      { class: 'harness', activation: f.session.activation },
    );
    expect(
      await inspectOriginalFileCheckpointCoverage(await f.snapshot()),
    ).toMatchObject({
      status: 'matched',
      coveredSequence,
      committedSequence: coveredSequence + 2,
    });
  });

  it.each([
    'assistant-name',
    'assistant-args',
    'unsupported-inline',
    'definition-name',
    'pending-history',
    'unsupported-history',
    'omitted-result',
  ] as const)(
    'rejects durable %s evidence even when the result checkpoint is consumed',
    async (damage) => {
      const f = await fixture('write_file', 'success', damage);
      await f.harness.consumeRuntimeResults();
      expect(
        await inspectOriginalFileCheckpointCoverage(await f.snapshot()),
      ).toMatchObject({ status: 'unresolved' });
    },
  );

  it.each(['read_file', 'write_file', 'edit'])(
    'matches %s only after consumed checkpoint and settled history',
    async (name) => {
      const f = await fixture(name);
      expect(
        await inspectOriginalFileCheckpointCoverage(await f.snapshot()),
      ).toMatchObject({
        status: 'unresolved',
        reason:
          name === 'read_file'
            ? 'file_result_not_consumed'
            : 'file_session_tail_not_settled',
      });
      await f.harness.consumeRuntimeResults();
      expect(
        await inspectOriginalFileCheckpointCoverage(await f.snapshot()),
      ).toMatchObject({
        status: 'matched',
        executionCallId: 'execution',
        outcomeDigest: f.outcomeRef.digest,
      });
    },
  );

  it('accepts the production file-path normalization without changing other arguments', async () => {
    const f = await fixture('write_file', 'success', 'normalized-path');
    await f.harness.consumeRuntimeResults();
    expect(
      await inspectOriginalFileCheckpointCoverage(await f.snapshot()),
    ).toMatchObject({ status: 'matched' });
  });

  it('rejects a model Edit replacement different from the runtime input', async () => {
    const f = await fixture('edit', 'success', 'assistant-args');
    await f.harness.consumeRuntimeResults();
    expect(
      await inspectOriginalFileCheckpointCoverage(await f.snapshot()),
    ).toMatchObject({
      status: 'unresolved',
      reason: 'file_model_arguments_conflict',
    });
  });

  it.each(['error', 'cancelled'] as const)(
    'matches an original complete %s result',
    async (status) => {
      const f = await fixture('read_file', status);
      await f.harness.consumeRuntimeResults();
      expect(
        await inspectOriginalFileCheckpointCoverage(await f.snapshot()),
      ).toMatchObject({ status: 'matched' });
    },
  );

  it.each([
    'wrong-result',
    'unknown',
    'abandoned',
    'wrong-binding',
    'wrong-runtime',
    'unauthorized',
    'unconsumed',
    'later-pending',
  ])('refuses %s evidence', async (damage) => {
    const f = await fixture();
    if (damage !== 'unconsumed') await f.harness.consumeRuntimeResults();
    if (damage === 'later-pending') {
      const previous = parseHarnessCheckpointV1(
        (await f.session.authority.readCheckpointState())!,
      );
      await f.session.authority.commitCheckpoint(
        {
          operation: 'pending',
          commandId: 'pending',
          sessionKey: previous.identity.sessionKey,
          contentDigest: f.outcomeRef.digest,
        },
        {
          boundary: null,
          state: encodeHarnessCheckpointV1({
            ...previous,
            continuation: {
              ...previous.continuation,
              pendingEventIds: ['pending'],
            },
          }),
        },
        { class: 'harness', activation: f.session.activation },
      );
    }
    const snapshot = await f.snapshot();
    if (damage === 'wrong-result')
      snapshot.originalExecution.result.responseParts = [{ text: 'forged' }];
    if (damage === 'unknown') snapshot.originalExecution.state = 'UNKNOWN';
    if (damage === 'abandoned') snapshot.originalExecution.state = 'ABANDONED';
    if (damage === 'wrong-binding')
      snapshot.originalExecution.bindingId = 'other';
    if (damage === 'wrong-runtime')
      snapshot.originalExecution.runtimeGeneration = '20';
    if (damage === 'unauthorized')
      snapshot.originalExecution.authorizedBindingVersion = '4';
    expect(await inspectOriginalFileCheckpointCoverage(snapshot)).toMatchObject(
      { status: 'unresolved' },
    );
  });
});
