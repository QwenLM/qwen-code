/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readOnlyManagedSessionSnapshot } from './http-managed-session-store.js';
import { inspectOriginalCsiRetirementBoundary as inspect } from './original-csi-retirement-boundary.js';
import {
  csiFileSession,
  csiFileInventoryFromSnapshot,
  closeCsiFileFixtures,
} from './__tests__/csi-file-session.js';

afterEach(closeCsiFileFixtures);

async function fixture(
  name = 'write_file',
  status: 'success' | 'error' = 'success',
) {
  const f = await csiFileSession(name, status);
  await f.harness.consumeRuntimeResults();
  const snapshot = await f.snapshot();
  const settledInventory = csiFileInventoryFromSnapshot(snapshot, [
    f.originalExecution,
  ]);
  const before = await readOnlyManagedSessionSnapshot(snapshot).journal.read();
  return {
    ...f,
    before,
    settledInventory,
    input: async () => ({
      format: 'qwen-csi-session-retirement-boundary/1',
      settledInventory,
      terminalSnapshot: await f.snapshot(),
    }),
  };
}

describe('original native CSI retirement boundary observation', () => {
  it.each(['read_file', 'write_file', 'edit'])(
    'observes the real original %s release boundary without granting retirement authority',
    async (name) => {
      const f = await fixture(name);
      await f.session.releaseActivation();
      const input = await f.input();
      const result = await inspect(input);
      expect(result).toMatchObject({
        status: 'observed',
        stage: 'original_native_boundary',
        sessionKey: input.terminalSnapshot.sessionKey,
        activation: { ...f.session.activation, workerId: 'owner' },
        settledHead: f.settledInventory.sessionSnapshots[0].head,
        terminalHead: input.terminalSnapshot.head,
      });
      expect(await inspect(input)).toEqual(result);
      for (const field of ['drained', 'releasable', 'cut', 'finalization'])
        expect(result).not.toHaveProperty(field);
    },
  );

  it('keeps a fully represented file error eligible for native boundary observation', async () => {
    const f = await fixture('write_file', 'error');
    await f.session.releaseActivation();
    expect(await inspect(await f.input())).toMatchObject({
      status: 'observed',
    });
  });

  it('can inspect a sealed terminal head without claiming an immutable cut', async () => {
    const f = await fixture();
    await f.session.releaseActivation();
    const input = await f.input();
    input.terminalSnapshot.head.state = 'SEALED';
    expect(await inspect(input)).toMatchObject({
      status: 'observed',
      terminalHead: { state: 'SEALED' },
    });
  });

  it.each(['missing', 'renewal', 'replacement', 'later-work'])(
    'refuses a %s terminal suffix generated through the native APIs',
    async (kind) => {
      const f = await fixture();
      if (kind === 'renewal')
        await f.session.authority.renewActivation({ leaseDurationMs: 300000 });
      if (kind === 'replacement') await f.session.replaceActivation();
      if (kind === 'later-work') {
        await f.session.sink.write({
          uuid: 'later-record',
          parentUuid: f.before.lastRecordUuid,
          sessionId: f.before.header!.sessionKey.sessionId,
          timestamp: new Date().toISOString(),
          type: 'user',
          cwd: '.',
          version: 'test',
          message: { role: 'user', parts: [{ text: 'uncovered work' }] },
        });
        await f.session.releaseActivation();
      }
      expect(await inspect(await f.input())).toMatchObject({
        status: 'unresolved',
      });
    },
  );

  it.each(['sequence', 'uuid', 'activation', 'epoch', 'extra', 'kind'])(
    'rejects a valid native transaction with a semantically wrong boundary %s',
    async (damage) => {
      const f = await fixture();
      const original = f.before.activation!;
      const body: Record<string, unknown> = {
        version: 1,
        activationId: original.activationId,
        epoch: original.epoch,
        committedSequence: f.before.committed,
        lastRecordUuid: f.before.lastRecordUuid,
      };
      if (damage === 'sequence')
        body['committedSequence'] = f.before.committed - 1;
      if (damage === 'uuid')
        body['lastRecordUuid'] = 'last-event-is-not-last-record';
      if (damage === 'activation') body['activationId'] = 'other-activation';
      if (damage === 'epoch') body['epoch'] = 2;
      if (damage === 'extra') body['allSettled'] = true;
      const boundaryRef = await f.resources.publish(
        damage === 'kind'
          ? 'managed-other-boundary'
          : 'managed-activation-boundary',
        Buffer.from(JSON.stringify(body)),
      );
      await f.session.authority.appendExecutionEvent(
        {
          operation: 'releaseActivation',
          commandId: `${original.activationId}:released`,
          sessionKey: f.before.header!.sessionKey,
          contentDigest: f.before.header!.definitionRef.digest,
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `activation:${original.activationId}:released`,
          sessionKey: f.before.header!.sessionKey,
          kind: 'activation.changed',
          occurredAt: Date.now(),
          payload: {
            activationId: original.activationId,
            epoch: original.epoch,
            workerId: original.workerId,
            subject: {
              type: 'activation',
              scopeId: original.activationId,
              activationId: original.activationId,
              epoch: original.epoch,
            },
            phase: 'released',
            leaseDurationMs: null,
            expiresAt: original.expiresAt,
            installRef: null,
            boundaryRef,
          },
        }),
        { class: 'coordinator' },
      );
      const input = await f.input();
      // Parsing succeeds: the refusal must come from the boundary's semantics.
      expect(
        await readOnlyManagedSessionSnapshot(
          input.terminalSnapshot,
        ).journal.read(),
      ).toMatchObject({ activation: { phase: 'released' } });
      expect(await inspect(input)).toEqual({
        status: 'unresolved',
        reason:
          damage === 'kind'
            ? 'boundary_resource_not_qualified'
            : 'boundary_body_prefix_conflict',
      });
    },
  );

  it.each([
    'unknown-work',
    'released-session',
    'second-session',
    'wrong-csi',
    'wrong-writer',
    'extra-field',
    'resource-revision',
  ])(
    'refuses %s evidence even after a real native boundary',
    async (damage) => {
      const f = await fixture();
      await f.session.releaseActivation();
      const input = await f.input();
      if (damage === 'unknown-work')
        input.settledInventory.executions[0]['state'] = 'UNKNOWN';
      if (damage === 'released-session')
        input.settledInventory.runtimeSessions[0].sessionState = 'RELEASED';
      if (damage === 'second-session')
        input.settledInventory.runtimeSessions.push({
          ...input.settledInventory.runtimeSessions[0],
          runtimeSessionId: 'second-runtime',
        });
      if (damage === 'wrong-csi')
        input.terminalSnapshot.originalCSI.bindingId = 'other-binding';
      if (damage === 'wrong-writer')
        input.terminalSnapshot.head.writerGeneration = 2;
      if (damage === 'extra-field') Object.assign(input, { allSettled: true });
      if (damage === 'resource-revision')
        input.terminalSnapshot.resources[0].referencedRevisions.push(
          input.terminalSnapshot.head.journalRevision,
        );
      expect(await inspect(input)).toMatchObject({ status: 'unresolved' });
    },
  );
});
