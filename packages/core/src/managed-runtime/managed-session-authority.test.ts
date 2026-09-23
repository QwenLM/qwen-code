/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSessionExecutionEngine } from '../services/session-execution-engine.js';
import { readSessionTranscriptSnapshot } from '../services/session-transcript-reader.js';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { Storage } from '../config/storage.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import {
  assertManagedSessionRestoreBundle,
  LocalManagedSessionAuthority,
  ManagedSessionConflictError,
  ManagedSessionUncommittedTailError,
  type ManagedSessionCommand,
  type ManagedSessionRestoreBundle,
} from './managed-session-authority.js';
import {
  createInitialHarnessCheckpoint,
  createNextTurnReadyHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  HARNESS_TURN_COMPLETE_BOUNDARY,
  parseHarnessCheckpointV1,
} from './managed-harness-checkpoint.js';
import {
  ManagedSessionRecordError,
  MANAGED_SESSION_FORMAT_VERSION,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';

const DIGEST = 'b'.repeat(64);
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function ref(kind = 'managed-test'): ManagedSessionDurableRef {
  return {
    resourceId: 'res-1',
    kind,
    schemaVersion: 1,
    byteLength: 4,
    digest: DIGEST,
  };
}

interface Fixture {
  runtimeBaseDir: string;
  transcriptPath: string;
  sessionId: string;
}

async function createFixture(sessionId = 'managed-session'): Promise<Fixture> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-managed-authority-'),
  );
  temporaryDirectories.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  /* Sealing records the transcript path relative to the runtime base
     directory, so the transcript has to live under it, as it does in a real
     workspace. */
  const transcriptPath = path.join(
    new Storage(projectRoot, runtimeBaseDir).getProjectDir(),
    'chats',
    `${sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  return { runtimeBaseDir, transcriptPath, sessionId };
}

function sessionKeyFor(fixture: Fixture) {
  return {
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    sessionId: fixture.sessionId,
  };
}

interface OpenedAuthority {
  authority: LocalManagedSessionAuthority;
  release(): Promise<void>;
}

async function openAuthority(
  fixture: Fixture,
  options: { create?: boolean } = {},
): Promise<OpenedAuthority> {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: fixture.runtimeBaseDir,
    sessionId: fixture.sessionId,
    transcriptPath: fixture.transcriptPath,
  });
  try {
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey: sessionKeyFor(fixture),
      cwd: '/workspace',
      version: 'test',
      ...(options.create === false
        ? {}
        : {
            create: {
              definitionRef: ref('managed-definition'),
              rootSnapshotRef: ref('managed-root'),
              createdBy: 'daemon',
            },
          }),
    });
    return { authority, release: () => lease.release() };
  } catch (error) {
    await lease.release().catch(() => undefined);
    throw error;
  }
}

function inputCommand(
  fixture: Fixture,
  overrides: Partial<ManagedSessionCommand> = {},
): ManagedSessionCommand {
  return {
    operation: 'submitInput',
    commandId: 'cmd-1',
    sessionKey: sessionKeyFor(fixture),
    contentDigest: DIGEST,
    ...overrides,
  };
}

const inputRequest = {
  inputId: 'in-1',
  turnId: 'turn-1',
  source: 'web_shell',
  contentRef: ref(),
  deadline: null,
  admissionRef: ref(),
  wakeReason: 'input',
};

async function readLines(fixture: Fixture): Promise<string[]> {
  const text = await fs.readFile(fixture.transcriptPath, 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

async function readRecords(
  fixture: Fixture,
): Promise<Array<Record<string, unknown>>> {
  const lines = await readLines(fixture);
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readBodies(
  fixture: Fixture,
): Promise<Array<Record<string, unknown>>> {
  const records = await readRecords(fixture);
  return records
    .filter((record) => record['managedSession'] !== undefined)
    .map((record) => record['managedSession'] as Record<string, unknown>);
}

function indexOfSubtype(lines: string[], subtype: string): number {
  const index = lines.findIndex((line) =>
    line.includes(`"subtype":"${subtype}"`),
  );
  if (index < 0) throw new Error(`no ${subtype} record in the log`);
  return index;
}

async function rewrite(fixture: Fixture, lines: string[]): Promise<void> {
  await fs.writeFile(fixture.transcriptPath, `${lines.join('\n')}\n`, 'utf8');
}

describe('managed session authority', () => {
  it('writes a header once and accepts input without a live harness', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    const receipt = await opened.authority.submitInput(
      inputCommand(fixture),
      inputRequest,
    );
    await opened.release();

    expect(receipt.firstSequence).toBe(1);
    expect(receipt.lastSequence).toBe(2);
    expect(receipt.committedSequence).toBe(2);
    expect(receipt.replayed).toBe(false);

    const records = await readRecords(fixture);
    expect(records.map((record) => record['subtype'])).toEqual([
      'session_execution_engine',
      'managed_session_header_v1',
      'managed_session_event_v1',
      'managed_session_event_v1',
      'managed_session_commit_v1',
    ]);
    expect(records.every((record) => record['type'] === 'system')).toBe(true);
    expect(
      records.every((record) => record['sessionId'] === fixture.sessionId),
    ).toBe(true);
  });

  it('persists the input and the wake intent in one transaction', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();

    const bodies = await readBodies(fixture);
    expect(bodies[1]['kind']).toBe('input.accepted');
    expect(bodies[2]['kind']).toBe('wake.requested');
    expect(bodies[3]['eventCount']).toBe(2);
    expect(bodies[3]['firstSequence']).toBe(1);
    expect(bodies[3]['lastSequence']).toBe(2);
    expect(bodies[3]['previousCommitDigest']).toBeNull();
  });

  it('reads the committed prefix back from a cold reopen', async () => {
    const fixture = await createFixture();
    const first = await openAuthority(fixture);
    await first.authority.submitInput(inputCommand(fixture), inputRequest);
    await first.release();

    const second = await openAuthority(fixture, { create: false });
    expect(second.authority.committedSequence).toBe(2);
    expect(second.authority.readEvents().map((event) => event.kind)).toEqual([
      'input.accepted',
      'wake.requested',
    ]);
    await second.release();

    const records = await readRecords(fixture);
    expect(
      records.filter(
        (record) => record['subtype'] === 'managed_session_header_v1',
      ),
    ).toHaveLength(1);
  });

  it('returns the original receipt for a repeated command id', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    const first = await opened.authority.submitInput(
      inputCommand(fixture),
      inputRequest,
    );
    const replay = await opened.authority.submitInput(
      inputCommand(fixture),
      inputRequest,
    );
    await opened.release();

    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.replayed).toBe(true);
    expect(replay.lastSequence).toBe(first.lastSequence);
    expect(await readLines(fixture)).toHaveLength(5);
  });

  it('survives a repeated command id across a cold reopen', async () => {
    const fixture = await createFixture();
    const first = await openAuthority(fixture);
    const original = await first.authority.submitInput(
      inputCommand(fixture),
      inputRequest,
    );
    await first.release();

    const second = await openAuthority(fixture, { create: false });
    const replay = await second.authority.submitInput(
      inputCommand(fixture),
      inputRequest,
    );
    await second.release();

    expect(replay.transactionId).toBe(original.transactionId);
    expect(replay.replayed).toBe(true);
    expect(await readLines(fixture)).toHaveLength(5);
  });

  it('rejects the same command id carrying different content', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await expect(
      opened.authority.submitInput(
        inputCommand(fixture, { contentDigest: 'c'.repeat(64) }),
        inputRequest,
      ),
    ).rejects.toThrow(ManagedSessionConflictError);
    await opened.release();
    expect(await readLines(fixture)).toHaveLength(5);
  });

  it('rejects a command for another workspace', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await expect(
      opened.authority.submitInput(
        inputCommand(fixture, {
          sessionKey: { ...sessionKeyFor(fixture), workspaceId: 'workspace-2' },
        }),
        inputRequest,
      ),
    ).rejects.toThrow(/does not match this session/);
    await opened.release();
    expect(await readLines(fixture)).toHaveLength(2);
  });

  it('rejects a stale expectedSequence', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await expect(
      opened.authority.submitInput(
        inputCommand(fixture, { commandId: 'cmd-2', expectedSequence: 0 }),
        { ...inputRequest, inputId: 'in-2' },
      ),
    ).rejects.toThrow(/does not match the committed sequence 2/);
    await opened.release();
  });

  it('chains each commit marker to the previous one', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.authority.submitInput(
      inputCommand(fixture, { commandId: 'cmd-2' }),
      { ...inputRequest, inputId: 'in-2' },
    );
    await opened.release();

    const markers = (await readBodies(fixture)).filter(
      (body) => body['transactionId'] !== undefined,
    );
    expect(markers).toHaveLength(2);
    expect(markers[0]['previousCommitDigest']).toBeNull();
    expect(markers[1]['previousCommitDigest']).toMatch(/^[0-9a-f]{64}$/);
    expect(markers[1]['firstSequence']).toBe(3);
  });

  it('bounds a page read and continues from the cursor', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.authority.submitInput(
      inputCommand(fixture, { commandId: 'cmd-2' }),
      { ...inputRequest, inputId: 'in-2' },
    );

    const firstPage = opened.authority.readEvents({ limit: 3 });
    expect(firstPage.map((event) => event.sequence)).toEqual([1, 2, 3]);
    const secondPage = opened.authority.readEvents({
      afterSequence: firstPage[firstPage.length - 1].sequence,
      limit: 3,
    });
    expect(secondPage.map((event) => event.sequence)).toEqual([4]);
    expect(() => opened.authority.readEvents({ limit: 0 })).toThrow(
      /limit must be positive/,
    );
    await opened.release();
  });
});

describe('managed session authority activation fences', () => {
  function activationEvent(
    fixture: Fixture,
    options: {
      sequence: number;
      activationId: string;
      epoch: number;
      phase: string;
    },
  ) {
    const closed = options.phase === 'released' || options.phase === 'revoked';
    return {
      v: 1,
      sequence: options.sequence,
      eventId: `evt-${options.activationId}-${options.phase}`,
      sessionKey: sessionKeyFor(fixture),
      kind: 'activation.changed',
      occurredAt: 1,
      payload: {
        activationId: options.activationId,
        epoch: options.epoch,
        workerId: 'worker-1',
        subject: {
          type: 'activation',
          scopeId: 'scope-1',
          activationId: options.activationId,
          epoch: options.epoch,
        },
        phase: options.phase,
        leaseDurationMs: 60_000,
        expiresAt: 2,
        installRef: ref(),
        boundaryRef: closed ? ref() : null,
      },
    };
  }

  function modelAttempt(
    fixture: Fixture,
    sequence: number,
    activationId: string,
    epoch: number,
  ) {
    return {
      v: 1,
      sequence,
      eventId: `evt-model-${activationId}-${sequence}`,
      sessionKey: sessionKeyFor(fixture),
      kind: 'model.attempt',
      occurredAt: 1,
      subject: {
        type: 'activation',
        scopeId: 'scope-1',
        activationId,
        epoch,
      },
      payload: {
        attemptId: `att-${sequence}`,
        routeRef: ref(),
        inputCheckpointRef: null,
        state: 'started',
        usageRef: null,
      },
    };
  }

  async function withActivation(fixture: Fixture): Promise<OpenedAuthority> {
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.authority.appendExecution(
      inputCommand(fixture, {
        operation: 'claimActivation',
        commandId: 'cmd-act-1',
      }),
      [
        activationEvent(fixture, {
          sequence: 3,
          activationId: 'act-1',
          epoch: 1,
          phase: 'active',
        }),
      ],
      { class: 'coordinator' },
    );
    return opened;
  }

  const holds = (activationId: string, epoch: number) =>
    ({ class: 'harness', activation: { activationId, epoch } }) as const;

  it('tracks the committed activation', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    expect(opened.authority.currentActivation).toEqual({
      activationId: 'act-1',
      epoch: 1,
      workerId: 'worker-1',
      phase: 'active',
      expiresAt: 2,
      renewalSeq: 0,
      installRef: ref(),
    });
    await opened.release();
  });

  it('recovers the committed activation from a cold reopen', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    await opened.release();

    const reopened = await openAuthority(fixture, { create: false });
    expect(reopened.authority.currentActivation).toEqual({
      activationId: 'act-1',
      epoch: 1,
      workerId: 'worker-1',
      phase: 'active',
      expiresAt: 2,
      renewalSeq: 0,
      installRef: ref(),
    });
    await reopened.release();
  });

  it('refuses a harness append when no activation is committed', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await expect(
      opened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'appendExecution',
          commandId: 'cmd-unproven',
        }),
        [modelAttempt(fixture, 3, 'act-999', 999)],
        holds('act-999', 999),
      ),
    ).rejects.toThrow(/no activation is committed/);
    await opened.release();
  });

  it('accepts an append from the committed activation', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    const receipt = await opened.authority.appendExecution(
      inputCommand(fixture, {
        operation: 'appendExecution',
        commandId: 'cmd-current',
        expectedSequence: 3,
      }),
      [modelAttempt(fixture, 4, 'act-1', 1)],
      holds('act-1', 1),
    );
    expect(receipt.committedSequence).toBe(4);
    await opened.release();
  });

  it('refuses an append from a superseded activation', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    await opened.authority.appendExecution(
      inputCommand(fixture, {
        operation: 'claimActivation',
        commandId: 'cmd-act-2',
      }),
      [
        activationEvent(fixture, {
          sequence: 4,
          activationId: 'act-2',
          epoch: 2,
          phase: 'active',
        }),
      ],
      { class: 'coordinator' },
    );
    await expect(
      opened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'appendExecution',
          commandId: 'cmd-stale',
        }),
        [modelAttempt(fixture, 5, 'act-1', 1)],
        holds('act-1', 1),
      ),
    ).rejects.toThrow(/is not the committed activation act-2\/2/);
    await opened.release();
  });

  it('refuses an append once the activation is released', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    await opened.authority.appendExecution(
      inputCommand(fixture, {
        operation: 'releaseActivation',
        commandId: 'cmd-release',
      }),
      [
        activationEvent(fixture, {
          sequence: 4,
          activationId: 'act-1',
          epoch: 1,
          phase: 'released',
        }),
      ],
      { class: 'coordinator' },
    );
    await expect(
      opened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'appendExecution',
          commandId: 'cmd-after-release',
        }),
        [modelAttempt(fixture, 5, 'act-1', 1)],
        holds('act-1', 1),
      ),
    ).rejects.toThrow(/is released and may not append/);
    await opened.release();
  });

  it('refuses an epoch the authority would not assign', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    await expect(
      opened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'claimActivation',
          commandId: 'cmd-jump',
        }),
        [
          activationEvent(fixture, {
            sequence: 4,
            activationId: 'act-9',
            epoch: 9,
            phase: 'active',
          }),
        ],
        { class: 'coordinator' },
      ),
    ).rejects.toThrow(/must use epoch 2, not 9/);
    await expect(
      opened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'releaseActivation',
          commandId: 'cmd-rewrite-epoch',
        }),
        [
          activationEvent(fixture, {
            sequence: 4,
            activationId: 'act-1',
            epoch: 5,
            phase: 'released',
          }),
        ],
        { class: 'coordinator' },
      ),
    ).rejects.toThrow(/is at epoch 1 and cannot change to 5/);
    await opened.release();
  });

  it('refuses a harness append whose subject names another activation', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    await expect(
      opened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'appendExecution',
          commandId: 'cmd-mismatch',
        }),
        [modelAttempt(fixture, 4, 'act-2', 1)],
        holds('act-1', 1),
      ),
    ).rejects.toThrow(/does not match the activation the harness holds/);
    await opened.release();
  });

  it('requires a harness to present the activation it holds', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    await expect(
      opened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'appendExecution',
          commandId: 'cmd-none',
        }),
        [modelAttempt(fixture, 4, 'act-1', 1)],
        { class: 'harness' },
      ),
    ).rejects.toThrow(/must present the activation it holds/);
    await opened.release();
  });

  it('leaves no partial records behind a rejected append', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    const before = await readLines(fixture);
    await expect(
      opened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'appendExecution',
          commandId: 'cmd-rejected',
        }),
        [modelAttempt(fixture, 4, 'act-2', 2)],
        holds('act-2', 2),
      ),
    ).rejects.toThrow(ManagedSessionConflictError);
    expect(await readLines(fixture)).toEqual(before);
    await opened.release();
  });

  describe('activation renewal', () => {
    async function openRenewable(fixture: Fixture, now: () => number) {
      const lease = await SessionWriterLease.acquire({
        runtimeBaseDir: fixture.runtimeBaseDir,
        sessionId: fixture.sessionId,
        transcriptPath: fixture.transcriptPath,
      });
      try {
        const authority = await LocalManagedSessionAuthority.open({
          lease,
          sessionKey: sessionKeyFor(fixture),
          cwd: '/workspace',
          version: 'test',
          now,
          resources: LocalManagedSessionResourceStore.create({
            runtimeBaseDir: fixture.runtimeBaseDir,
            sessionKey: sessionKeyFor(fixture),
          }),
          create: {
            definitionRef: ref('managed-definition'),
            rootSnapshotRef: ref('managed-root'),
            createdBy: 'daemon',
          },
        });
        return { authority, release: () => lease.release() };
      } catch (error) {
        await lease.release().catch(() => undefined);
        throw error;
      }
    }

    it('extends the horizon without changing the activation identity', async () => {
      const fixture = await createFixture();
      let now = 1_000_000;
      const opened = await openRenewable(fixture, () => now);
      const installed = await opened.authority.installActivation({
        activationId: 'act-renew',
        workerId: 'worker-1',
        leaseDurationMs: 60_000,
      });
      expect(opened.authority.currentActivation).toMatchObject({
        activationId: 'act-renew',
        epoch: installed.epoch,
        phase: 'active',
        expiresAt: 1_060_000,
        renewalSeq: 0,
      });

      now = 1_050_000;
      const renewed = await opened.authority.renewActivation({
        leaseDurationMs: 60_000,
      });
      expect(renewed).toMatchObject({
        activationId: 'act-renew',
        epoch: installed.epoch,
        phase: 'active',
        expiresAt: 1_110_000,
        renewalSeq: 1,
      });

      now = 1_100_000;
      await opened.authority.renewActivation({ leaseDurationMs: 60_000 });
      expect(opened.authority.currentActivation).toMatchObject({
        activationId: 'act-renew',
        epoch: installed.epoch,
        expiresAt: 1_160_000,
        renewalSeq: 2,
      });
      await opened.release();
    });

    it('recovers the renewed horizon from a cold reopen', async () => {
      const fixture = await createFixture();
      let now = 1_000_000;
      const opened = await openRenewable(fixture, () => now);
      await opened.authority.installActivation({
        activationId: 'act-renew',
        workerId: 'worker-1',
        leaseDurationMs: 60_000,
      });
      now = 1_050_000;
      await opened.authority.renewActivation({ leaseDurationMs: 60_000 });
      await opened.release();

      const reopened = await openAuthority(fixture, { create: false });
      expect(reopened.authority.currentActivation).toMatchObject({
        activationId: 'act-renew',
        phase: 'active',
        expiresAt: 1_110_000,
        renewalSeq: 1,
      });
      await reopened.release();
    });

    it('does not renew a released activation', async () => {
      const fixture = await createFixture();
      const opened = await openRenewable(fixture, () => 1_000_000);
      await opened.authority.installActivation({
        activationId: 'act-renew',
        workerId: 'worker-1',
        leaseDurationMs: 60_000,
      });
      await opened.authority.releaseActivation();

      await expect(
        opened.authority.renewActivation({ leaseDurationMs: 60_000 }),
      ).resolves.toBeUndefined();
      expect(opened.authority.currentActivation?.phase).toBe('released');
      await opened.release();
    });

    it('does not renew when no activation was ever installed', async () => {
      const fixture = await createFixture();
      const opened = await openRenewable(fixture, () => 1_000_000);
      await expect(
        opened.authority.renewActivation({ leaseDurationMs: 60_000 }),
      ).resolves.toBeUndefined();
      await opened.release();
    });
  });

  it('records a tool_call request and recovers the trusted decision', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    const request = {
      requestId: 'req-1',
      kind: 'permission',
      inputRevision: 1,
      optionsRef: null,
    };
    await expect(
      opened.authority.requestToolAction(
        inputCommand(fixture, {
          operation: 'requestToolAction',
          commandId: 'cmd-action-trusted',
        }),
        request,
        { class: 'trusted_entry' },
      ),
    ).rejects.toThrow(/only the current harness/);
    await expect(
      opened.authority.resolveAction(
        inputCommand(fixture, {
          operation: 'resolveAction',
          commandId: 'cmd-action-early',
        }),
        { requestId: 'req-1', state: 'decided', decisionRef: ref() },
      ),
    ).rejects.toThrow(/has not been requested/);

    const requested = await opened.authority.requestToolAction(
      inputCommand(fixture, {
        operation: 'requestToolAction',
        commandId: 'cmd-action-request',
      }),
      request,
      holds('act-1', 1),
    );
    expect(requested.state).toBe('requested');
    expect(
      await opened.authority.requestToolAction(
        inputCommand(fixture, {
          operation: 'requestToolAction',
          commandId: 'cmd-action-request-again',
        }),
        request,
        holds('act-1', 1),
      ),
    ).toEqual(requested);

    const decided = await opened.authority.resolveAction(
      inputCommand(fixture, {
        operation: 'resolveAction',
        commandId: 'cmd-action-decide',
      }),
      { requestId: 'req-1', state: 'decided', decisionRef: ref() },
    );
    expect(decided.state).toBe('decided');
    expect(decided.decisionRef).toEqual(ref());
    expect(
      await opened.authority.resolveAction(
        inputCommand(fixture, {
          operation: 'resolveAction',
          commandId: 'cmd-action-decide-again',
        }),
        { requestId: 'req-1', state: 'decided', decisionRef: ref() },
      ),
    ).toEqual(decided);

    await expect(
      opened.authority.resolveAction(
        inputCommand(fixture, {
          operation: 'resolveAction',
          commandId: 'cmd-action-cancel',
        }),
        { requestId: 'req-1', state: 'cancelled', decisionRef: null },
      ),
    ).rejects.toThrow(/already decided/);
    await expect(
      opened.authority.requestToolAction(
        inputCommand(fixture, {
          operation: 'requestToolAction',
          commandId: 'cmd-action-after',
        }),
        request,
        holds('act-1', 1),
      ),
    ).rejects.toThrow(/already decided/);
    await opened.release();

    const reopened = await openAuthority(fixture, { create: false });
    expect(reopened.authority.action('req-1')).toMatchObject({
      requestId: 'req-1',
      state: 'decided',
    });
    expect(reopened.authority.action('req-1')?.decisionRef).toEqual(ref());
    await reopened.release();
  });
});

describe('managed session authority log integrity', () => {
  it('blocks opening when a transaction has no commit marker', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();

    const lines = await readLines(fixture);
    lines.pop();
    await rewrite(fixture, lines);

    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      ManagedSessionUncommittedTailError,
    );
  });

  it('blocks opening after a crash between the events and the marker', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.release();

    // Append events the way a crashed transaction would leave them: through
    // the lease, so the transcript proof stays consistent, but with no marker.
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    await lease.appendJsonLine({
      uuid: 'orphan-1',
      parentUuid: null,
      sessionId: fixture.sessionId,
      timestamp: new Date().toISOString(),
      type: 'system',
      subtype: 'managed_session_event_v1',
      cwd: '/workspace',
      version: 'test',
      managedSession: {
        v: 1,
        sequence: 1,
        eventId: 'orphan-event',
        sessionKey: sessionKeyFor(fixture),
        kind: 'input.accepted',
        occurredAt: 1,
        payload: {
          inputId: 'in-orphan',
          turnId: 'turn-orphan',
          source: 'web_shell',
          contentRef: ref(),
          deadline: null,
          admissionRef: ref(),
        },
      },
    });
    await lease.release();

    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      ManagedSessionUncommittedTailError,
    );
  });

  it('refuses a marker whose events were altered', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();

    const lines = await readLines(fixture);
    const at = indexOfSubtype(lines, 'managed_session_event_v1');
    const record = JSON.parse(lines[at]) as Record<string, unknown>;
    const body = record['managedSession'] as Record<string, unknown>;
    const payload = body['payload'] as Record<string, unknown>;
    payload['source'] = 'tampered';
    lines[at] = JSON.stringify(record);
    await rewrite(fixture, lines);

    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      /does not match the preceding event content/,
    );
  });

  it('refuses a log whose records precede the header', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();

    const lines = await readLines(fixture);
    lines.splice(indexOfSubtype(lines, 'managed_session_header_v1'), 1);
    await rewrite(fixture, lines);

    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      /precedes the Managed header/,
    );
  });

  it('refuses a header belonging to another session', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.release();

    const lines = await readLines(fixture);
    const at = indexOfSubtype(lines, 'managed_session_header_v1');
    const record = JSON.parse(lines[at]) as Record<string, unknown>;
    const body = record['managedSession'] as Record<string, unknown>;
    body['sessionKey'] = {
      tenantId: 'tenant-1',
      workspaceId: 'workspace-2',
      sessionId: fixture.sessionId,
    };
    lines[at] = JSON.stringify(record);
    await rewrite(fixture, lines);

    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      /belongs to a different session/,
    );
  });

  it('refuses to adopt a transcript that already holds other records', async () => {
    const fixture = await createFixture();
    await rewrite(fixture, [
      JSON.stringify({
        uuid: 'legacy-1',
        parentUuid: null,
        sessionId: fixture.sessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
      }),
    ]);

    await expect(openAuthority(fixture)).rejects.toThrow(
      /history import is not supported yet/,
    );
  });

  it('requires creation parameters for an empty transcript', async () => {
    const fixture = await createFixture();
    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      ManagedSessionRecordError,
    );
  });

  it('stops accepting work once an append has failed', async () => {
    const fixture = await createFixture();
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey: sessionKeyFor(fixture),
      cwd: '/workspace',
      version: 'test',
      create: {
        definitionRef: ref('managed-definition'),
        rootSnapshotRef: ref('managed-root'),
        createdBy: 'daemon',
      },
    });

    // Releasing the lease under the authority makes the next append fail for
    // real rather than through an injected stub.
    await lease.release();
    await expect(
      authority.submitInput(inputCommand(fixture), inputRequest),
    ).rejects.toThrow();

    await expect(
      authority.submitInput(
        inputCommand(fixture, { commandId: 'cmd-after-failure' }),
        { ...inputRequest, inputId: 'in-2' },
      ),
    ).rejects.toThrow(/writes stopped after an earlier failure/);
  });
});

describe('managed session authority serialisation', () => {
  it('serialises concurrent transactions into one increasing sequence', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);

    /* Started together, so neither can observe the other's committed
       sequence before choosing its own. */
    const [first, second] = await Promise.all([
      opened.authority.submitInput(inputCommand(fixture), inputRequest),
      opened.authority.submitInput(
        inputCommand(fixture, { commandId: 'cmd-2' }),
        { ...inputRequest, inputId: 'in-2' },
      ),
    ]);
    await opened.release();

    expect([
      first.firstSequence,
      first.lastSequence,
      second.firstSequence,
      second.lastSequence,
    ]).toEqual([1, 2, 3, 4]);

    const bodies = await readBodies(fixture);
    const eventSequences = bodies
      .filter((body) => body['sequence'] !== undefined)
      .map((body) => body['sequence']);
    expect(eventSequences).toEqual([1, 2, 3, 4]);

    const reopened = await openAuthority(fixture, { create: false });
    expect(reopened.authority.committedSequence).toBe(4);
    await reopened.release();
  });

  it('refuses to reuse an event id under a different command id', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await expect(
      opened.authority.submitInput(
        inputCommand(fixture, { commandId: 'cmd-different' }),
        inputRequest,
      ),
    ).rejects.toThrow(/event id in-1:accepted is already committed/);
    await opened.release();
    expect(await readLines(fixture)).toHaveLength(5);
  });

  it('refuses an event id repeated inside one transaction', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    const duplicate = {
      v: 1,
      sequence: 1,
      eventId: 'evt-same',
      sessionKey: sessionKeyFor(fixture),
      kind: 'cancel.requested',
      occurredAt: 1,
      payload: {
        requestId: 'req-1',
        target: { turnId: 'turn-1' },
        reason: 'user',
        requestedBy: 'web_shell',
      },
    };
    await expect(
      opened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'requestCancel',
          commandId: 'cmd-dup',
        }),
        [duplicate, { ...duplicate, sequence: 2 }],
        { class: 'trusted_entry' },
      ),
    ).rejects.toThrow(/must not repeat an event id/);
    await opened.release();
  });
});

describe('managed session authority scan strictness', () => {
  it('refuses an unknown record after the header', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();

    const lines = await readLines(fixture);
    lines.splice(
      2,
      0,
      JSON.stringify({
        uuid: 'intruder',
        parentUuid: null,
        sessionId: fixture.sessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
      }),
    );
    await rewrite(fixture, lines);

    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      /unknown subtype undefined after the Managed header/,
    );
  });

  it('refuses a blank line inside the log', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();

    const lines = await readLines(fixture);
    lines.splice(2, 0, '');
    await rewrite(fixture, lines);

    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      /is blank/,
    );
  });
});

describe('managed session uncommitted tail recovery', () => {
  async function seedTornTail(fixture: Fixture): Promise<number> {
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();
    const committedBytes = (await fs.stat(fixture.transcriptPath)).size;

    /* Append an event through a lease with no marker, the way a crash between
       the records and the marker would leave it. */
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    await lease.appendJsonLine({
      uuid: 'orphan-1',
      parentUuid: null,
      sessionId: fixture.sessionId,
      timestamp: new Date().toISOString(),
      type: 'system',
      subtype: 'managed_session_event_v1',
      cwd: '/workspace',
      version: 'test',
      managedSession: {
        v: 1,
        sequence: 3,
        eventId: 'orphan-event',
        sessionKey: sessionKeyFor(fixture),
        kind: 'cancel.requested',
        occurredAt: 1,
        payload: {
          requestId: 'req-orphan',
          target: { turnId: 'turn-1' },
          reason: 'user',
          requestedBy: 'web_shell',
        },
      },
    });
    await lease.release();
    return committedBytes;
  }

  it('discards the tail and reopens on the committed prefix', async () => {
    const fixture = await createFixture();
    const committedBytes = await seedTornTail(fixture);
    const before = await readLines(fixture);
    expect(before).toHaveLength(6);

    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    await expect(
      LocalManagedSessionAuthority.open({
        lease,
        sessionKey: sessionKeyFor(fixture),
        cwd: '/workspace',
        version: 'test',
      }),
    ).rejects.toThrow(ManagedSessionUncommittedTailError);

    const recovered = await LocalManagedSessionAuthority.recoverUncommittedTail(
      { lease, sessionKey: sessionKeyFor(fixture) },
    );
    expect(recovered.discardedBytes).toBeGreaterThan(0);

    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey: sessionKeyFor(fixture),
      cwd: '/workspace',
      version: 'test',
    });
    expect(authority.committedSequence).toBe(2);
    expect(authority.readEvents().map((event) => event.kind)).toEqual([
      'input.accepted',
      'wake.requested',
    ]);

    /* The writer stays usable: its pinned proof was rebuilt, so the next
       transaction continues from the recovered tail. */
    const receipt = await authority.submitInput(
      inputCommand(fixture, { commandId: 'cmd-after-recovery' }),
      { ...inputRequest, inputId: 'in-after' },
    );
    expect(receipt.firstSequence).toBe(3);
    await lease.release();

    expect((await fs.stat(fixture.transcriptPath)).size).toBeGreaterThan(
      committedBytes,
    );
    const after = await readLines(fixture);
    expect(after.filter((line) => line.includes('orphan-event'))).toHaveLength(
      0,
    );

    const reopened = await openAuthority(fixture, { create: false });
    expect(reopened.authority.committedSequence).toBe(4);
    await reopened.release();
  });

  it('keeps the discarded bytes for diagnosis', async () => {
    const fixture = await createFixture();
    await seedTornTail(fixture);
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    const recovered = await LocalManagedSessionAuthority.recoverUncommittedTail(
      { lease, sessionKey: sessionKeyFor(fixture) },
    );
    await lease.release();

    const kept = await fs.readFile(recovered.diagnosticPath, 'utf8');
    expect(kept).toContain('orphan-event');
    expect(Buffer.byteLength(kept, 'utf8')).toBe(recovered.discardedBytes);
  });

  it('refuses to recover a log with nothing uncommitted', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();

    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    await expect(
      LocalManagedSessionAuthority.recoverUncommittedTail({
        lease,
        sessionKey: sessionKeyFor(fixture),
      }),
    ).rejects.toThrow(/no uncommitted tail to discard/);
    await lease.release();
  });

  it('refuses a truncation past the end of the transcript', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();

    const size = (await fs.stat(fixture.transcriptPath)).size;
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    await expect(lease.truncateTo(size + 1)).rejects.toThrow();
    await expect(lease.truncateTo(-1)).rejects.toThrow();
    expect((await fs.stat(fixture.transcriptPath)).size).toBe(size);
    await lease.release();
  });
});

describe('managed session engine ownership', () => {
  it('records managed ownership so legacy-only operations refuse the session', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();

    const snapshot = await readSessionTranscriptSnapshot(
      fixture.transcriptPath,
      fixture.sessionId,
    );
    expect(snapshot?.executionEngine).toMatchObject({
      status: 'verified',
      engine: 'managed',
      recorded: true,
    });

    /* Without this record the reader reports a verified legacy session, and
       fork, rename and the config guards would all operate on it. */
    expect(() =>
      assertSessionExecutionEngine(
        snapshot?.executionEngine,
        fixture.sessionId,
        'legacy',
      ),
    ).toThrow(/belongs to managed/);
    expect(() =>
      assertSessionExecutionEngine(
        snapshot?.executionEngine,
        fixture.sessionId,
        'managed',
      ),
    ).not.toThrow();
  });

  it('completes a create interrupted between the engine record and the header', async () => {
    const fixture = await createFixture();
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    await lease.appendJsonLine({
      uuid: 'engine-only',
      parentUuid: null,
      sessionId: fixture.sessionId,
      timestamp: new Date().toISOString(),
      type: 'system',
      subtype: 'session_execution_engine',
      cwd: '/workspace',
      version: 'test',
      systemPayload: { version: 1, engine: 'managed' },
    });
    await lease.release();

    const opened = await openAuthority(fixture);
    expect(opened.authority.sessionHeader.engine).toBe('managed');
    await opened.release();

    const subtypes = (await readRecords(fixture)).map(
      (record) => record['subtype'],
    );
    expect(subtypes).toEqual([
      'session_execution_engine',
      'managed_session_header_v1',
    ]);
  });
});

describe('managed session first transaction recovery', () => {
  it('retains the header when the first transaction never committed', async () => {
    const fixture = await createFixture();
    const created = await openAuthority(fixture);
    await created.release();
    const prefixSize = (await fs.stat(fixture.transcriptPath)).size;

    /* No commit marker exists yet, so the committed sequence is still zero.
       Truncating to that offset would delete the header and leave a session
       that can never be opened again. */
    const crashed = await SessionWriterLease.acquire({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    await crashed.appendJsonLine({
      uuid: 'first-orphan',
      parentUuid: null,
      sessionId: fixture.sessionId,
      timestamp: new Date().toISOString(),
      type: 'system',
      subtype: 'managed_session_event_v1',
      cwd: '/workspace',
      version: 'test',
      managedSession: {
        v: 1,
        sequence: 1,
        eventId: 'first-orphan-event',
        sessionKey: sessionKeyFor(fixture),
        kind: 'input.accepted',
        occurredAt: 1,
        payload: {
          inputId: 'in-orphan',
          turnId: 'turn-orphan',
          source: 'web_shell',
          contentRef: ref(),
          deadline: null,
          admissionRef: ref(),
        },
      },
    });
    await crashed.release();

    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    const recovered = await LocalManagedSessionAuthority.recoverUncommittedTail(
      { lease, sessionKey: sessionKeyFor(fixture) },
    );
    expect(recovered.discardedBytes).toBeGreaterThan(0);

    expect((await fs.stat(fixture.transcriptPath)).size).toBe(prefixSize);
    expect((await readRecords(fixture)).map((r) => r['subtype'])).toEqual([
      'session_execution_engine',
      'managed_session_header_v1',
    ]);

    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey: sessionKeyFor(fixture),
      cwd: '/workspace',
      version: 'test',
    });
    expect(authority.committedSequence).toBe(0);
    expect(authority.sessionHeader.engine).toBe('managed');
    const receipt = await authority.submitInput(
      inputCommand(fixture),
      inputRequest,
    );
    expect(receipt.firstSequence).toBe(1);
    await lease.release();
  });

  it('refuses recovery when there is no prefix to retain', async () => {
    const fixture = await createFixture();
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    await lease.appendJsonLine({
      uuid: 'headerless',
      parentUuid: null,
      sessionId: fixture.sessionId,
      timestamp: new Date().toISOString(),
      type: 'system',
      subtype: 'managed_session_commit_v1',
      cwd: '/workspace',
      version: 'test',
      managedSession: {
        transactionId: 'tx-1',
        commandId: 'cmd-1',
        operation: 'submitInput',
        contentDigest: DIGEST,
        firstSequence: 1,
        lastSequence: 1,
        eventCount: 1,
        eventsDigest: DIGEST,
        previousCommitDigest: null,
      },
    });
    await expect(
      LocalManagedSessionAuthority.recoverUncommittedTail({
        lease,
        sessionKey: sessionKeyFor(fixture),
      }),
    ).rejects.toThrow(/precedes the Managed header/);
    await lease.release();
  });
});

describe('managed session write barrier at rest', () => {
  async function seedSealedSession(fixture: Fixture): Promise<void> {
    const lease = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey: sessionKeyFor(fixture),
      cwd: '/workspace',
      version: 'test',
      create: {
        definitionRef: ref('managed-definition'),
        rootSnapshotRef: ref('managed-root'),
        createdBy: 'daemon',
      },
    });
    await authority.submitInput(inputCommand(fixture), inputRequest);
    await authority.close();
  }

  it('declines a writer that cannot take over the seal', async () => {
    const fixture = await createFixture();
    await seedSealedSession(fixture);

    /* Releasing would have removed the lock outright, letting any writer
       acquire the transcript and append legacy records into the authoritative
       log -- after which the authority could not reopen it at all. */
    await expect(
      SessionWriterLease.acquire({
        runtimeBaseDir: fixture.runtimeBaseDir,
        sessionId: fixture.sessionId,
        transcriptPath: fixture.transcriptPath,
      }),
    ).rejects.toThrow(/conflict|in use|another/i);

    expect(await readLines(fixture)).toHaveLength(5);
  });

  it('lets the managed writer take over its own seal and continue', async () => {
    const fixture = await createFixture();
    await seedSealedSession(fixture);

    const lease = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey: sessionKeyFor(fixture),
      cwd: '/workspace',
      version: 'test',
    });
    expect(authority.committedSequence).toBe(2);
    const receipt = await authority.submitInput(
      inputCommand(fixture, { commandId: 'cmd-after-seal' }),
      { ...inputRequest, inputId: 'in-after-seal' },
    );
    expect(receipt.firstSequence).toBe(3);
    await authority.close();

    const reopenLease = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    const reopened = await LocalManagedSessionAuthority.open({
      lease: reopenLease,
      sessionKey: sessionKeyFor(fixture),
      cwd: '/workspace',
      version: 'test',
    });
    expect(reopened.committedSequence).toBe(4);
    await reopened.close();
  });

  it('refuses a takeover when the sealed transcript was altered', async () => {
    const fixture = await createFixture();
    await seedSealedSession(fixture);

    await fs.appendFile(
      fixture.transcriptPath,
      `${JSON.stringify({
        uuid: 'intruder',
        parentUuid: null,
        sessionId: fixture.sessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
      })}\n`,
      'utf8',
    );

    await expect(
      LocalManagedSessionAuthority.acquireWriter({
        runtimeBaseDir: fixture.runtimeBaseDir,
        sessionId: fixture.sessionId,
        transcriptPath: fixture.transcriptPath,
      }),
    ).rejects.toThrow();
  });
});

describe('managed session checkpoints', () => {
  const HOLDS = {
    class: 'harness',
    activation: { activationId: 'act-1', epoch: 1 },
  } as const;

  interface CheckpointHarness {
    fixture: Fixture;
    authority: LocalManagedSessionAuthority;
    store: LocalManagedSessionResourceStore;
    close(): Promise<void>;
  }

  async function openWithResources(
    fixture: Fixture,
    options: { create?: boolean } = {},
  ): Promise<CheckpointHarness> {
    const store = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionKey: sessionKeyFor(fixture),
    });
    const lease = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey: sessionKeyFor(fixture),
      cwd: '/workspace',
      version: 'test',
      resources: store,
      ...(options.create === false
        ? {}
        : {
            create: {
              definitionRef: ref('managed-definition'),
              rootSnapshotRef: ref('managed-root'),
              createdBy: 'daemon',
            },
          }),
    });
    return {
      fixture,
      authority,
      store,
      close: () => authority.close(),
    };
  }

  async function activate(
    harness: CheckpointHarness,
    sequence: number,
  ): Promise<void> {
    await harness.authority.appendExecution(
      inputCommand(harness.fixture, {
        operation: 'claimActivation',
        commandId: `cmd-act-${sequence}`,
      }),
      [
        {
          v: 1,
          sequence,
          eventId: `evt-act-${sequence}`,
          sessionKey: sessionKeyFor(harness.fixture),
          kind: 'activation.changed',
          occurredAt: 1,
          payload: {
            activationId: 'act-1',
            epoch: 1,
            workerId: 'worker-1',
            subject: {
              type: 'activation',
              scopeId: 'act-1',
              activationId: 'act-1',
              epoch: 1,
            },
            phase: 'active',
            leaseDurationMs: 60_000,
            expiresAt: 2,
            installRef: ref(),
            boundaryRef: null,
          },
        },
      ],
      { class: 'coordinator' },
    );
  }

  function modelAttempt(fixture: Fixture, sequence: number) {
    return {
      v: 1,
      sequence,
      eventId: `evt-model-${sequence}`,
      sessionKey: sessionKeyFor(fixture),
      kind: 'model.attempt',
      occurredAt: 1,
      subject: {
        type: 'activation',
        scopeId: 'act-1',
        activationId: 'act-1',
        epoch: 1,
      },
      payload: {
        attemptId: `att-${sequence}`,
        routeRef: ref(),
        inputCheckpointRef: null,
        state: 'started',
        usageRef: null,
      },
    };
  }

  it('treats a session with no execution as an initial basis', async () => {
    const harness = await openWithResources(await createFixture());
    expect(harness.authority.restoreBasis()).toBe('initial');
    expect(harness.authority.latestCheckpoint).toBeUndefined();
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    /* Accepted input is not execution continuation. */
    expect(harness.authority.restoreBasis()).toBe('initial');
    await expect(harness.authority.restoreBundle()).resolves.toMatchObject({
      formatVersion: MANAGED_SESSION_FORMAT_VERSION,
      sessionKey: sessionKeyFor(harness.fixture),
      engine: 'managed',
      restoreBasis: 'initial',
      checkpointRef: null,
      restoreProofRef: null,
      recoveryStatus: 'ok',
    });
    await harness.close();
  });

  it('blocks recovery when execution ran without a checkpoint', async () => {
    const harness = await openWithResources(await createFixture());
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await activate(harness, 3);
    await harness.authority.appendExecution(
      inputCommand(harness.fixture, {
        operation: 'appendExecution',
        commandId: 'cmd-model',
      }),
      [modelAttempt(harness.fixture, 4)],
      HOLDS,
    );
    expect(harness.authority.restoreBasis()).toBe('blocked');
    await expect(harness.authority.restoreBundle()).resolves.toMatchObject({
      restoreBasis: null,
      checkpointRef: null,
      restoreProofRef: null,
      recoveryStatus: 'blocked',
    });
    await harness.close();
  });

  it('commits a checkpoint and reads its state back', async () => {
    const harness = await openWithResources(await createFixture());
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await activate(harness, 3);

    const state = Buffer.from('{"turn":1,"pending":[]}', 'utf8');
    const committed = await harness.authority.commitCheckpoint(
      inputCommand(harness.fixture, {
        operation: 'commitCheckpoint',
        commandId: 'cmd-ckpt-1',
      }),
      { state, boundary: null },
      HOLDS,
    );
    expect(committed.checkpoint.coveredSequence).toBe(3);
    expect(committed.checkpoint.previousCheckpointId).toBeNull();
    expect(committed.checkpoint.boundary).toBeNull();
    expect(harness.authority.restoreBasis()).toBe('checkpoint');
    expect(await harness.authority.readCheckpointState()).toEqual(state);
    await harness.close();
  });

  it('chains each checkpoint and recovers the newest after a cold reopen', async () => {
    const fixture = await createFixture();
    const first = await openWithResources(fixture);
    await first.authority.submitInput(inputCommand(fixture), inputRequest);
    await activate(first, 3);
    const one = await first.authority.commitCheckpoint(
      inputCommand(fixture, {
        operation: 'commitCheckpoint',
        commandId: 'cmd-ckpt-1',
      }),
      { state: Buffer.from('first', 'utf8'), boundary: null },
      HOLDS,
    );
    const two = await first.authority.commitCheckpoint(
      inputCommand(fixture, {
        operation: 'commitCheckpoint',
        commandId: 'cmd-ckpt-2',
      }),
      { state: Buffer.from('second', 'utf8'), boundary: 'before_model' },
      HOLDS,
    );
    expect(two.checkpoint.previousCheckpointId).toBe(
      one.checkpoint.checkpointId,
    );
    await first.close();

    const reopened = await openWithResources(fixture, { create: false });
    expect(reopened.authority.restoreBasis()).toBe('checkpoint');
    expect(reopened.authority.latestCheckpoint?.checkpointId).toBe(
      two.checkpoint.checkpointId,
    );
    expect(reopened.authority.latestCheckpoint?.boundary).toBe('before_model');
    expect(await reopened.authority.readCheckpointState()).toEqual(
      Buffer.from('second', 'utf8'),
    );
    await reopened.close();
  });

  it('lets only the current harness commit a checkpoint', async () => {
    const harness = await openWithResources(await createFixture());
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await activate(harness, 3);
    await expect(
      harness.authority.commitCheckpoint(
        inputCommand(harness.fixture, {
          operation: 'commitCheckpoint',
          commandId: 'cmd-ckpt-entry',
        }),
        { state: Buffer.from('x', 'utf8'), boundary: null },
        { class: 'trusted_entry' },
      ),
    ).rejects.toThrow(/only the current harness/);
    await expect(
      harness.authority.commitCheckpoint(
        inputCommand(harness.fixture, {
          operation: 'commitCheckpoint',
          commandId: 'cmd-ckpt-stale',
        }),
        { state: Buffer.from('x', 'utf8'), boundary: null },
        { class: 'harness', activation: { activationId: 'act-9', epoch: 1 } },
      ),
    ).rejects.toThrow(/is not the committed activation/);
    await harness.close();
  });

  it('surfaces a missing checkpoint body instead of an empty state', async () => {
    const harness = await openWithResources(await createFixture());
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await activate(harness, 3);
    const committed = await harness.authority.commitCheckpoint(
      inputCommand(harness.fixture, {
        operation: 'commitCheckpoint',
        commandId: 'cmd-ckpt-1',
      }),
      { state: Buffer.from('state', 'utf8'), boundary: null },
      HOLDS,
    );
    await fs.rm(
      path.join(
        harness.store.sessionRoot,
        committed.checkpoint.stateRef.kind,
        committed.checkpoint.stateRef.resourceId,
      ),
    );
    await expect(harness.authority.readCheckpointState()).rejects.toThrow(
      /is not present for session/,
    );
    await expect(harness.authority.harnessRunAuthorization()).resolves.toEqual({
      status: 'blocked',
      reason: 'missing_state',
      message: expect.stringMatching(/is not present for session/),
    });
    await expect(harness.authority.restoreBundle()).resolves.toMatchObject({
      restoreBasis: 'checkpoint',
      checkpointRef: committed.checkpoint.stateRef,
      restoreProofRef: null,
      recoveryStatus: 'blocked',
    });
    await harness.close();
  });

  function initialV1State(
    fixture: Fixture,
    overrides: Partial<
      Parameters<typeof createInitialHarnessCheckpoint>[0]
    > = {},
  ) {
    return encodeHarnessCheckpointV1(
      createInitialHarnessCheckpoint({
        sessionKey: sessionKeyFor(fixture),
        checkpointId: 'ckpt-4',
        coveredSequence: 3,
        activationId: 'act-1',
        turnId: 'turn-1',
        promptId: null,
        definitionRevision: 'def-1',
        configRevision: 'cfg-1',
        inputDigest: DIGEST,
        previousCheckpointId: null,
        ...overrides,
      }),
    );
  }

  it('does not treat an opaque checkpoint blob as runnable', async () => {
    const harness = await openWithResources(await createFixture());
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await activate(harness, 3);
    await harness.authority.commitCheckpoint(
      inputCommand(harness.fixture, {
        operation: 'commitCheckpoint',
        commandId: 'cmd-ckpt-opaque',
      }),
      { state: Buffer.from('first', 'utf8'), boundary: null },
      HOLDS,
    );
    expect(harness.authority.restoreBasis()).toBe('checkpoint');
    await expect(harness.authority.harnessRunAuthorization()).resolves.toEqual({
      status: 'blocked',
      reason: 'opaque_state',
      message: expect.stringMatching(/JSON/),
    });
    await expect(harness.authority.restoreBundle()).resolves.toMatchObject({
      restoreBasis: 'checkpoint',
      restoreProofRef: null,
      recoveryStatus: 'blocked',
    });
    expect(
      (await harness.authority.restoreBundle()).checkpointRef,
    ).not.toBeNull();
    await harness.close();
  });

  it('authorizes a matching nine-group v1 checkpoint as runnable', async () => {
    const harness = await openWithResources(await createFixture());
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await activate(harness, 3);
    const checkpoint = createInitialHarnessCheckpoint({
      sessionKey: sessionKeyFor(harness.fixture),
      checkpointId: 'ckpt-4',
      coveredSequence: 3,
      activationId: 'act-1',
      turnId: 'turn-1',
      promptId: null,
      definitionRevision: 'def-1',
      configRevision: 'cfg-1',
      inputDigest: DIGEST,
      previousCheckpointId: null,
    });
    const committed = await harness.authority.commitCheckpoint(
      inputCommand(harness.fixture, {
        operation: 'commitCheckpoint',
        commandId: 'cmd-ckpt-v1',
      }),
      { state: encodeHarnessCheckpointV1(checkpoint), boundary: null },
      HOLDS,
    );
    expect(committed.checkpoint.checkpointId).toBe('ckpt-4');
    expect(committed.checkpoint.coveredSequence).toBe(3);
    expect(harness.authority.restoreBasis()).toBe('checkpoint');
    await expect(harness.authority.harnessRunAuthorization()).resolves.toEqual({
      status: 'runnable',
      checkpoint,
    });
    await expect(harness.authority.restoreBundle()).resolves.toMatchObject({
      restoreBasis: 'checkpoint',
      checkpointRef: committed.checkpoint.stateRef,
      restoreProofRef: null,
      recoveryStatus: 'ok',
    });
    await harness.close();
  });

  it('aligns stale v1 coverage to the assigned checkpoint identity', async () => {
    const harness = await openWithResources(await createFixture());
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await activate(harness, 3);
    const committed = await harness.authority.commitCheckpoint(
      inputCommand(harness.fixture, {
        operation: 'commitCheckpoint',
        commandId: 'cmd-ckpt-stale-coverage',
      }),
      {
        state: initialV1State(harness.fixture, {
          checkpointId: 'ckpt-99',
          coveredSequence: 0,
          previousCheckpointId: 'ckpt-1',
        }),
        boundary: null,
      },
      HOLDS,
    );
    expect(committed.checkpoint.checkpointId).toBe('ckpt-4');
    expect(committed.checkpoint.coveredSequence).toBe(3);
    expect(committed.checkpoint.previousCheckpointId).toBeNull();
    const parsed = parseHarnessCheckpointV1(
      (await harness.authority.readCheckpointState())!,
    );
    expect(parsed.identity.checkpointId).toBe('ckpt-4');
    expect(parsed.identity.coveredSequence).toBe(3);
    expect(parsed.identity.previousCheckpointId).toBeNull();
    expect(parsed.resume.throughSequence).toBe(3);
    await expect(
      harness.authority.harnessRunAuthorization(),
    ).resolves.toMatchObject({
      status: 'runnable',
      checkpoint: parsed,
    });
    await harness.close();
  });

  it('blocks a v1 checkpoint whose sessionKey does not match', async () => {
    const harness = await openWithResources(await createFixture());
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await activate(harness, 3);
    await harness.authority.commitCheckpoint(
      inputCommand(harness.fixture, {
        operation: 'commitCheckpoint',
        commandId: 'cmd-ckpt-mismatch',
      }),
      {
        state: initialV1State(harness.fixture, {
          sessionKey: {
            ...sessionKeyFor(harness.fixture),
            sessionId: 'other-session',
          },
        }),
        boundary: null,
      },
      HOLDS,
    );
    expect(harness.authority.restoreBasis()).toBe('checkpoint');
    await expect(
      harness.authority.harnessRunAuthorization(),
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: 'identity_mismatch',
    });
    await harness.close();
  });

  it('blocks a versioned but unparseable checkpoint as invalid_state', async () => {
    const harness = await openWithResources(await createFixture());
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await activate(harness, 3);
    await harness.authority.commitCheckpoint(
      inputCommand(harness.fixture, {
        operation: 'commitCheckpoint',
        commandId: 'cmd-ckpt-invalid',
      }),
      {
        state: Buffer.from(
          JSON.stringify({ identity: { schemaVersion: 1 } }),
          'utf8',
        ),
        boundary: null,
      },
      HOLDS,
    );
    expect(harness.authority.restoreBasis()).toBe('checkpoint');
    await expect(harness.authority.harnessRunAuthorization()).resolves.toEqual({
      status: 'blocked',
      reason: 'invalid_state',
      message: expect.stringMatching(/identity/),
    });
    await harness.close();
  });

  it('authorizes an unused session as initial, not runnable', async () => {
    const harness = await openWithResources(await createFixture());
    expect(harness.authority.restoreBasis()).toBe('initial');
    await expect(harness.authority.harnessRunAuthorization()).resolves.toEqual({
      status: 'initial',
    });
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await expect(harness.authority.harnessRunAuthorization()).resolves.toEqual({
      status: 'initial',
    });
    await harness.close();
  });

  it('blocks continuation without a checkpoint as missing_checkpoint', async () => {
    const harness = await openWithResources(await createFixture());
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await activate(harness, 3);
    await harness.authority.appendExecution(
      inputCommand(harness.fixture, {
        operation: 'appendExecution',
        commandId: 'cmd-model',
      }),
      [modelAttempt(harness.fixture, 4)],
      HOLDS,
    );
    expect(harness.authority.restoreBasis()).toBe('blocked');
    await expect(harness.authority.harnessRunAuthorization()).resolves.toEqual({
      status: 'blocked',
      reason: 'missing_checkpoint',
    });
    await harness.close();
  });

  it('commits turn.settled with the next-turn checkpoint in one transaction', async () => {
    const harness = await openWithResources(await createFixture());
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await activate(harness, 3);
    const first = createInitialHarnessCheckpoint({
      sessionKey: sessionKeyFor(harness.fixture),
      checkpointId: 'ckpt-4',
      coveredSequence: 3,
      activationId: 'act-1',
      turnId: null,
      promptId: null,
      definitionRevision: 'def-1',
      configRevision: 'cfg-1',
      inputDigest: DIGEST,
      previousCheckpointId: null,
    });
    await harness.authority.commitCheckpoint(
      inputCommand(harness.fixture, {
        operation: 'commitCheckpoint',
        commandId: 'cmd-ckpt-v1',
      }),
      { state: encodeHarnessCheckpointV1(first), boundary: null },
      HOLDS,
    );
    const resultRef = await harness.store.publish(
      'managed-turn-result',
      Buffer.from('{"state":"completed"}', 'utf8'),
    );
    const committed = await harness.authority.commitTurnComplete(
      inputCommand(harness.fixture, {
        operation: 'settleTurn',
        commandId: 'cmd-turn-1',
      }),
      {
        turn: {
          turnId: 'turn-1',
          outcome: 'completed',
          stopReason: 'end_turn',
          resultRef,
          occurredAt: 1,
          eventId: 'turn:turn-1',
        },
        boundary: HARNESS_TURN_COMPLETE_BOUNDARY,
        state: (identity, previous) =>
          encodeHarnessCheckpointV1(
            createNextTurnReadyHarnessCheckpoint({
              previous,
              ...identity,
              activationId: HOLDS.activation.activationId,
              turnId: 'turn-1',
              promptId: 'turn-1',
            }),
          ),
      },
      HOLDS,
    );

    expect(committed.receipt.firstSequence).toBe(5);
    expect(committed.receipt.lastSequence).toBe(6);
    expect(committed.checkpoint.checkpointId).toBe('ckpt-6');
    expect(committed.checkpoint.coveredSequence).toBe(4);
    expect(committed.checkpoint.previousCheckpointId).toBe('ckpt-4');
    expect(committed.checkpoint.boundary).toBe(HARNESS_TURN_COMPLETE_BOUNDARY);

    const events = harness.authority.readEvents();
    expect(events[4]?.kind).toBe('turn.settled');
    expect(events[5]?.kind).toBe('checkpoint.committed');
    expect(
      parseHarnessCheckpointV1(
        (await harness.authority.readCheckpointState())!,
      ),
    ).toMatchObject({
      continuation: { phase: 'before_model' },
      identity: {
        checkpointId: 'ckpt-6',
        coveredSequence: 4,
        previousCheckpointId: 'ckpt-4',
        turnId: 'turn-1',
      },
    });
    await expect(
      harness.authority.harnessRunAuthorization(),
    ).resolves.toMatchObject({ status: 'runnable' });
    await harness.close();
  });

  it('does not treat an opaque checkpoint as a turn-complete safety point', async () => {
    const harness = await openWithResources(await createFixture());
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await activate(harness, 3);
    await harness.authority.commitCheckpoint(
      inputCommand(harness.fixture, {
        operation: 'commitCheckpoint',
        commandId: 'cmd-ckpt-opaque',
      }),
      { state: Buffer.from('first', 'utf8'), boundary: null },
      HOLDS,
    );
    const before = harness.authority.committedSequence;
    await expect(
      harness.authority.commitTurnComplete(
        inputCommand(harness.fixture, {
          operation: 'settleTurn',
          commandId: 'cmd-turn-opaque',
        }),
        {
          turn: {
            turnId: 'turn-1',
            outcome: 'completed',
            stopReason: null,
            resultRef: ref(),
            occurredAt: 1,
            eventId: 'turn:turn-1',
          },
          boundary: HARNESS_TURN_COMPLETE_BOUNDARY,
          state: () => Buffer.from('healed', 'utf8'),
        },
        HOLDS,
      ),
    ).rejects.toThrow(/requires a runnable Harness checkpoint/);
    expect(harness.authority.committedSequence).toBe(before);
    expect(harness.authority.latestCheckpoint?.checkpointId).toBe('ckpt-4');
    expect(
      harness.authority
        .readEvents()
        .some((event) => event.kind === 'turn.settled'),
    ).toBe(false);
    await expect(harness.authority.harnessRunAuthorization()).resolves.toEqual({
      status: 'blocked',
      reason: 'opaque_state',
      message: expect.stringMatching(/JSON/),
    });
    await harness.close();
  });

  it('rejects a turn-complete body that is not a matching v1 checkpoint', async () => {
    const harness = await openWithResources(await createFixture());
    await harness.authority.submitInput(
      inputCommand(harness.fixture),
      inputRequest,
    );
    await activate(harness, 3);
    await harness.authority.commitCheckpoint(
      inputCommand(harness.fixture, {
        operation: 'commitCheckpoint',
        commandId: 'cmd-ckpt-v1',
      }),
      { state: initialV1State(harness.fixture), boundary: null },
      HOLDS,
    );
    const before = harness.authority.committedSequence;
    await expect(
      harness.authority.commitTurnComplete(
        inputCommand(harness.fixture, {
          operation: 'settleTurn',
          commandId: 'cmd-turn-bad-state',
        }),
        {
          turn: {
            turnId: 'turn-1',
            outcome: 'completed',
            stopReason: null,
            resultRef: ref(),
            occurredAt: 1,
            eventId: 'turn:turn-1',
          },
          boundary: HARNESS_TURN_COMPLETE_BOUNDARY,
          state: () => Buffer.from('healed', 'utf8'),
        },
        HOLDS,
      ),
    ).rejects.toThrow(/JSON/);
    expect(harness.authority.committedSequence).toBe(before);
    expect(harness.authority.latestCheckpoint?.checkpointId).toBe('ckpt-4');
    expect(
      harness.authority
        .readEvents()
        .some((event) => event.kind === 'turn.settled'),
    ).toBe(false);
    await harness.close();
  });
});

describe('assertManagedSessionRestoreBundle', () => {
  const sessionKey = {
    tenantId: 't1',
    workspaceId: 'w1',
    sessionId: 's1',
  };

  function bundle(
    overrides: Partial<ManagedSessionRestoreBundle>,
  ): ManagedSessionRestoreBundle {
    return {
      formatVersion: MANAGED_SESSION_FORMAT_VERSION,
      sessionKey,
      engine: 'managed',
      throughSequence: 0,
      checkpointRef: null,
      restoreBasis: 'initial',
      restoreProofRef: null,
      recoveryStatus: 'ok',
      ...overrides,
    };
  }

  it('accepts the legal initial, checkpoint, and history-maintenance combinations', () => {
    expect(() => assertManagedSessionRestoreBundle(bundle({}))).not.toThrow();
    expect(() =>
      assertManagedSessionRestoreBundle(
        bundle({
          restoreBasis: 'checkpoint',
          checkpointRef: ref(),
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertManagedSessionRestoreBundle(
        bundle({
          restoreBasis: 'checkpoint',
          checkpointRef: ref(),
          recoveryStatus: 'blocked',
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertManagedSessionRestoreBundle(
        bundle({
          restoreBasis: null,
          recoveryStatus: 'blocked',
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertManagedSessionRestoreBundle(
        bundle({
          restoreBasis: 'history_rewind',
          restoreProofRef: ref('managed-history-rewind'),
        }),
      ),
    ).not.toThrow();
  });

  it('rejects illegal restoreBasis/checkpointRef/restoreProofRef combinations', () => {
    expect(() =>
      assertManagedSessionRestoreBundle(bundle({ restoreBasis: 'checkpoint' })),
    ).toThrow(/checkpoint restore requires checkpointRef/);
    expect(() =>
      assertManagedSessionRestoreBundle(
        bundle({
          restoreBasis: 'checkpoint',
          checkpointRef: ref(),
          restoreProofRef: ref(),
        }),
      ),
    ).toThrow(/null restoreProofRef/);
    expect(() =>
      assertManagedSessionRestoreBundle(
        bundle({ restoreBasis: 'initial', checkpointRef: ref() }),
      ),
    ).toThrow(/initial restore requires both refs null/);
    expect(() =>
      assertManagedSessionRestoreBundle(
        bundle({ restoreBasis: 'initial', recoveryStatus: 'blocked' }),
      ),
    ).toThrow(/not a blocked downgrade/);
    expect(() =>
      assertManagedSessionRestoreBundle(
        bundle({ restoreBasis: 'history_copy' }),
      ),
    ).toThrow(/history_copy restore requires restoreProofRef/);
    expect(() =>
      assertManagedSessionRestoreBundle(
        bundle({
          restoreBasis: 'history_copy',
          checkpointRef: ref(),
          restoreProofRef: ref(),
        }),
      ),
    ).toThrow(/null checkpointRef/);
    expect(() =>
      assertManagedSessionRestoreBundle(
        bundle({ restoreBasis: null, recoveryStatus: 'ok' }),
      ),
    ).toThrow(/without restoreBasis must be blocked/);
  });
});
