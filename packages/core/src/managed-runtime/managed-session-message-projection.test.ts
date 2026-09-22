/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../config/storage.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import {
  LocalManagedSessionAuthority,
  readManagedSessionLog,
} from './managed-session-authority.js';
import {
  ManagedSessionMessageProjection,
  projectManagedSessionTitleInfo,
  readManagedSessionRecords,
} from './managed-session-message-projection.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { ManagedSessionRecordSink } from './managed-session-record-sink.js';
import { managedSessionResourceRoot } from '../utils/sessionStorageUtils.js';
import {
  managedSessionEventsDigest,
  parseManagedSessionEvent,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';

const DIGEST = 'e'.repeat(64);
const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = { tenantId: 't1', workspaceId: 'w1', sessionId };
const HOLDS = {
  class: 'harness',
  activation: { activationId: 'act-1', epoch: 1 },
} as const;

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

function command(operation: string, commandId: string) {
  return { operation, commandId, sessionKey, contentDigest: DIGEST };
}

interface Harness {
  authority: LocalManagedSessionAuthority;
  projection: ManagedSessionMessageProjection;
  store: LocalManagedSessionResourceStore;
  transcriptPath: string;
  runtimeBaseDir: string;
  close(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-proj-'));
  temporaryDirectories.add(root);
  const projectRoot = path.join(root, 'project');
  const runtimeBaseDir = path.join(root, 'runtime');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  const transcriptPath = path.join(
    new Storage(projectRoot, runtimeBaseDir).getProjectDir(),
    'chats',
    `${sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });

  const store = LocalManagedSessionResourceStore.create({
    runtimeBaseDir,
    sessionKey,
  });
  const lease = await LocalManagedSessionAuthority.acquireWriter({
    runtimeBaseDir,
    sessionId,
    transcriptPath,
  });
  const authority = await LocalManagedSessionAuthority.open({
    lease,
    sessionKey,
    cwd: projectRoot,
    version: 'test',
    resources: store,
    create: {
      definitionRef: ref('managed-definition'),
      rootSnapshotRef: ref('managed-root'),
      createdBy: 'daemon',
    },
  });
  await authority.appendExecution(
    command('claimActivation', 'cmd-act-1'),
    [
      {
        v: 1,
        sequence: 1,
        eventId: 'evt-act-1',
        sessionKey,
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

  return {
    authority,
    projection: new ManagedSessionMessageProjection(authority, store),
    store,
    transcriptPath,
    runtimeBaseDir,
    close: () => authority.close(),
  };
}

/** Deliberately varied: a plain turn, model metadata, and a system subtype. */
const records: ChatRecord[] = [
  {
    uuid: 'rec-user-1',
    parentUuid: null,
    sessionId,
    timestamp: '2026-09-01T10:00:00.000Z',
    type: 'user',
    cwd: '/workspace',
    version: '1.2.3',
    message: { role: 'user', parts: [{ text: 'summarise the design docs' }] },
  },
  {
    uuid: 'rec-assistant-1',
    parentUuid: 'rec-user-1',
    sessionId,
    timestamp: '2026-09-01T10:00:05.000Z',
    type: 'assistant',
    cwd: '/workspace',
    version: '1.2.3',
    model: 'qwen3-coder-plus',
    contextWindowSize: 262144,
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45 },
    message: { role: 'model', parts: [{ text: 'Here is the summary.' }] },
  },
  {
    uuid: 'rec-system-1',
    parentUuid: 'rec-assistant-1',
    sessionId,
    timestamp: '2026-09-01T10:00:06.000Z',
    type: 'system',
    subtype: 'slash_command',
    cwd: '/workspace',
    version: '1.2.3',
  },
] as ChatRecord[];

function historicalCheckpoint(
  harness: Harness,
  stateRef: ManagedSessionDurableRef,
  id = 'branch-1',
  previous: string | null = null,
) {
  return parseManagedSessionEvent({
    v: 1,
    sequence: harness.authority.committedSequence + 1,
    eventId: `checkpoint:${id}`,
    sessionKey,
    kind: 'checkpoint.committed',
    occurredAt: 1,
    subject: { type: 'activation', scopeId: 'act-1', ...HOLDS.activation },
    payload: {
      checkpointId: id,
      coveredSequence: harness.authority.committedSequence,
      previousCheckpointId: previous,
      stateRef,
      boundary: null,
    },
  });
}

const branchRecord: ChatRecord = {
  ...records[2],
  uuid: 'branch-1',
  subtype: 'branch_checkpoint',
  systemPayload: {
    v: 1,
    startExclusiveRecordUuid: null,
    assistantRecordUuid: records[1].uuid,
  },
};

describe('managed session message projection', () => {
  it('assigns the message sequence after earlier queued commits', async () => {
    const harness = await createHarness();
    const publish = harness.store.publish.bind(harness.store);
    let releaseCheckpoint!: () => void;
    const checkpointReleased = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    let checkpointPublishStarted!: () => void;
    const checkpointPublishing = new Promise<void>((resolve) => {
      checkpointPublishStarted = resolve;
    });
    vi.spyOn(harness.store, 'publish').mockImplementation(
      async (kind, body) => {
        if (kind === 'managed-checkpoint') {
          checkpointPublishStarted();
          await checkpointReleased;
        }
        return publish(kind, body);
      },
    );
    const appendEvent = vi.spyOn(harness.authority, 'appendExecutionEvent');

    try {
      const checkpoint = harness.authority.commitCheckpoint(
        command('commitCheckpoint', 'queued-checkpoint'),
        { state: Buffer.from('checkpoint'), boundary: null },
        HOLDS,
      );
      await checkpointPublishing;
      const message = harness.projection.commit(
        command('commitMessage', 'queued-message'),
        { record: records[0] },
        HOLDS,
      );
      await vi.waitFor(() => expect(appendEvent).toHaveBeenCalledOnce());

      releaseCheckpoint();
      await expect(Promise.all([checkpoint, message])).resolves.toHaveLength(2);
      expect(harness.authority.committedSequence).toBe(3);
      await expect(harness.projection.project()).resolves.toEqual([records[0]]);
    } finally {
      releaseCheckpoint();
      await harness.close();
    }
  });

  it('assigns an activation transition after earlier queued commits', async () => {
    const harness = await createHarness();
    const publish = harness.store.publish.bind(harness.store);
    let releaseCheckpoint!: () => void;
    const checkpointReleased = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    let checkpointPublishStarted!: () => void;
    const checkpointPublishing = new Promise<void>((resolve) => {
      checkpointPublishStarted = resolve;
    });
    vi.spyOn(harness.store, 'publish').mockImplementation(
      async (kind, body) => {
        if (kind === 'managed-checkpoint') {
          checkpointPublishStarted();
          await checkpointReleased;
        }
        return publish(kind, body);
      },
    );
    const appendEvent = vi.spyOn(harness.authority, 'appendExecutionEvent');

    try {
      const checkpoint = harness.authority.commitCheckpoint(
        command('commitCheckpoint', 'queued-checkpoint'),
        { state: Buffer.from('checkpoint'), boundary: null },
        HOLDS,
      );
      await checkpointPublishing;
      const message = harness.projection.commit(
        command('commitMessage', 'queued-message'),
        { record: records[0] },
        HOLDS,
      );
      await vi.waitFor(() => expect(appendEvent).toHaveBeenCalledOnce());
      const release = harness.authority.releaseActivation();
      await vi.waitFor(() => expect(appendEvent).toHaveBeenCalledTimes(2));

      releaseCheckpoint();
      await expect(
        Promise.all([checkpoint, message, release]),
      ).resolves.toHaveLength(3);
      expect(
        harness.authority
          .readEvents()
          .map((event) => [event.sequence, event.kind]),
      ).toEqual([
        [1, 'activation.changed'],
        [2, 'checkpoint.committed'],
        [3, 'message.committed'],
        [4, 'activation.changed'],
      ]);
    } finally {
      releaseCheckpoint();
      await harness.close();
    }
  });

  it.each([
    [
      'JSON',
      Buffer.from(JSON.stringify({ continuation: { phase: 'before_model' } })),
    ],
    ['opaque bytes', Buffer.from([0, 255, 1, 2])],
  ])(
    'does not project a %s Harness checkpoint as a ChatRecord',
    async (_label, state) => {
      const harness = await createHarness();
      try {
        await harness.projection.commit(
          command('commitMessage', 'cmd-msg-0'),
          { record: records[0] },
          HOLDS,
        );
        await harness.authority.commitCheckpoint(
          command('commitCheckpoint', 'cmd-checkpoint'),
          { state, boundary: null },
          HOLDS,
        );
        await expect(
          readManagedSessionRecords({
            transcriptPath: harness.transcriptPath,
            runtimeBaseDir: harness.runtimeBaseDir,
            sessionKey,
          }),
        ).resolves.toEqual([records[0]]);
        expect(await harness.authority.readCheckpointState()).toEqual(state);
      } finally {
        await harness.close();
      }
    },
  );

  it('rejects an invalid timestamp in a durable reader-facing record', async () => {
    const harness = await createHarness();
    try {
      await harness.projection.commit(
        command('commitMessage', 'invalid-timestamp'),
        {
          record: {
            ...records[0],
            timestamp: 'not-a-timestamp',
          },
        },
        HOLDS,
      );
    } finally {
      await harness.close();
    }

    await expect(
      readManagedSessionRecords({
        transcriptPath: harness.transcriptPath,
        runtimeBaseDir: harness.runtimeBaseDir,
        sessionKey,
      }),
    ).rejects.toThrow(/invalid reader-facing record/);
  });

  it('projects the latest durable session title for cold restore', async () => {
    const harness = await createHarness();
    try {
      await harness.authority.commitDomainRecord(
        command('renameSession', 'title-1'),
        {
          domain: 'session_metadata',
          content: { title: 'First title', titleSource: 'auto' },
        },
        { class: 'trusted_entry' },
      );
      await harness.authority.commitDomainRecord(
        command('renameSession', 'title-2'),
        {
          domain: 'session_metadata',
          content: { title: 'Restored title', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
    } finally {
      await harness.close();
    }
    const scan = await readManagedSessionLog(
      harness.transcriptPath,
      sessionKey,
    );

    await expect(
      projectManagedSessionTitleInfo({ scan, resources: harness.store }),
    ).resolves.toEqual({ title: 'Restored title', source: 'manual' });
  });

  it.each(['none', 'before', 'after', 'both'] as const)(
    'reads historical branches, retries and resumes the state chain (state position: %s)',
    async (position) => {
      const withState = position !== 'none';
      const harness = await createHarness();
      const branch = branchRecord;
      const state = Buffer.from('Harness state');
      let checkpointId: string | undefined;
      try {
        for (const record of records.slice(0, 2)) {
          await harness.projection.commit(
            command('commitMessage', record.uuid),
            { record },
            HOLDS,
          );
        }
        if (position === 'before' || position === 'both') {
          const committed = await harness.authority.commitCheckpoint(
            command('commitCheckpoint', 'state-1'),
            { state, boundary: null },
            HOLDS,
          );
          checkpointId = committed.checkpoint.checkpointId;
        }
        const stateRef = await harness.store.publish(
          'managed-branch-checkpoint',
          Buffer.from(JSON.stringify(branch)),
        );
        await harness.authority.appendExecution(
          {
            ...command('commitBranchCheckpoint', `recorder:${branch.uuid}`),
            contentDigest: stateRef.digest,
          },
          [
            historicalCheckpoint(
              harness,
              stateRef,
              branch.uuid,
              checkpointId ?? null,
            ),
          ],
          HOLDS,
        );
        if (position === 'after' || position === 'both') {
          const stateAfter = await harness.store.publish(
            'managed-checkpoint',
            state,
          );
          checkpointId = 'state-after';
          await harness.authority.appendExecution(
            command('commitCheckpoint', checkpointId),
            [
              historicalCheckpoint(
                harness,
                stateAfter,
                checkpointId,
                branch.uuid,
              ),
            ],
            HOLDS,
          );
        }
        expect(harness.authority.latestCheckpoint?.checkpointId).toBe(
          checkpointId,
        );
        expect(await harness.projection.project()).toEqual([
          ...records.slice(0, 2),
          branch,
        ]);
      } finally {
        await harness.close();
      }
      const before = await fs.readFile(harness.transcriptPath);
      await expect(
        readManagedSessionRecords({
          transcriptPath: harness.transcriptPath,
          runtimeBaseDir: harness.runtimeBaseDir,
          sessionKey,
        }),
      ).resolves.toEqual([...records.slice(0, 2), branch]);
      const lease = await LocalManagedSessionAuthority.acquireWriter({
        runtimeBaseDir: harness.runtimeBaseDir,
        sessionId,
        transcriptPath: harness.transcriptPath,
      });
      const reopened = await LocalManagedSessionAuthority.open({
        lease,
        sessionKey,
        cwd: '/workspace',
        version: 'test',
        resources: harness.store,
      });
      try {
        expect(reopened.latestCheckpoint?.checkpointId).toBe(checkpointId);
        expect(reopened.restoreBasis()).toBe(
          withState ? 'checkpoint' : 'blocked',
        );
        expect(await reopened.readCheckpointState()).toEqual(
          withState ? state : undefined,
        );
        expect(await fs.readFile(harness.transcriptPath)).toEqual(before);
        const sink = new ManagedSessionRecordSink(
          reopened,
          harness.store,
          () => HOLDS,
        );
        await sink.write(branch);
        expect(await fs.readFile(harness.transcriptPath)).toEqual(before);
        await expect(
          sink.write({ ...branch, parentUuid: 'changed' }),
        ).rejects.toThrow(/different content/);
        const next = await reopened.commitCheckpoint(
          command('commitCheckpoint', 'next-state'),
          { state: Buffer.from('next'), boundary: null },
          HOLDS,
        );
        expect(next.checkpoint.previousCheckpointId).toBe(checkpointId ?? null);
        const newBranch = { ...branch, uuid: 'branch-new' };
        await sink.write(newBranch);
        const afterBranch = await fs.readFile(harness.transcriptPath);
        await sink.write(newBranch);
        expect(await fs.readFile(harness.transcriptPath)).toEqual(afterBranch);
        expect(reopened.latestCheckpoint).toEqual(next.checkpoint);
        const last = await reopened.commitCheckpoint(
          command('commitCheckpoint', 'last-state'),
          { state: Buffer.from('last'), boundary: null },
          HOLDS,
        );
        expect(last.checkpoint.previousCheckpointId).toBe(
          next.checkpoint.checkpointId,
        );
        expect(
          await readManagedSessionRecords({
            transcriptPath: harness.transcriptPath,
            runtimeBaseDir: harness.runtimeBaseDir,
            sessionKey,
          }),
        ).toEqual([...records.slice(0, 2), branch, newBranch]);
      } finally {
        await reopened.close();
      }
    },
  );

  it.each([
    ['wrong record ID', JSON.stringify({ ...branchRecord, uuid: 'other' })],
    ['wrong session', JSON.stringify({ ...branchRecord, sessionId: 'other' })],
    ['wrong type', JSON.stringify({ ...branchRecord, type: 'assistant' })],
    [
      'wrong subtype',
      JSON.stringify({ ...branchRecord, subtype: 'slash_command' }),
    ],
    [
      'missing parent',
      JSON.stringify({ ...branchRecord, parentUuid: undefined }),
    ],
    [
      'invalid payload',
      JSON.stringify({ ...branchRecord, systemPayload: { v: 2 } }),
    ],
    [
      'duplicate JSON key',
      JSON.stringify(branchRecord).replace('"v":1', '"v":2,"v":1'),
    ],
    ['invalid JSON', 'not a record'],
  ])(
    'rejects %s before appending and permits a corrected retry',
    async (_name, body) => {
      const harness = await createHarness();
      try {
        const ref = await harness.store.publish(
          'managed-branch-checkpoint',
          Buffer.from(body),
        );
        const event = historicalCheckpoint(harness, ref);
        const before = await fs.readFile(harness.transcriptPath);
        const cmd = command('commitBranchCheckpoint', 'retryable');
        await expect(
          harness.authority.appendExecution(cmd, [event], HOLDS),
        ).rejects.toThrow();
        expect(await fs.readFile(harness.transcriptPath)).toEqual(before);
        expect(harness.authority.latestCheckpoint).toBeUndefined();
        expect(harness.authority.restoreBasis()).toBe('initial');
        const valid = await harness.store.publish(
          'managed-branch-checkpoint',
          Buffer.from(JSON.stringify(branchRecord)),
        );
        await harness.authority.appendExecution(
          cmd,
          [historicalCheckpoint(harness, valid)],
          HOLDS,
        );
        expect(harness.authority.restoreBasis()).toBe('blocked');
        expect(await harness.projection.project()).toEqual([branchRecord]);
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    'kind',
    'version',
    'coverage',
    'dangling predecessor',
    'self predecessor',
    'boundary',
  ] as const)(
    'rejects an invalid checkpoint %s before committing',
    async (invalid) => {
      const harness = await createHarness();
      try {
        let ref = await harness.store.publish(
          'managed-branch-checkpoint',
          Buffer.from(JSON.stringify(branchRecord)),
        );
        if (invalid === 'kind') ref = { ...ref, kind: 'managed-other' };
        if (invalid === 'version') ref = { ...ref, schemaVersion: 2 };
        const event = historicalCheckpoint(harness, ref);
        const payload = {
          ...event.payload,
          ...(invalid === 'coverage'
            ? { coveredSequence: event.sequence }
            : {}),
          ...(invalid === 'dangling predecessor'
            ? { previousCheckpointId: 'missing' }
            : {}),
          ...(invalid === 'self predecessor'
            ? { previousCheckpointId: 'branch-1' }
            : {}),
          ...(invalid === 'boundary' ? { boundary: 'turn_settled' } : {}),
        };
        const before = await fs.readFile(harness.transcriptPath);
        await expect(
          harness.authority.appendExecution(
            command('commitBranchCheckpoint', 'invalid'),
            [{ ...event, payload }],
            HOLDS,
          ),
        ).rejects.toThrow();
        expect(await fs.readFile(harness.transcriptPath)).toEqual(before);
        expect(harness.authority.latestCheckpoint).toBeUndefined();
      } finally {
        await harness.close();
      }
    },
  );

  it.each(['digest', 'length', 'missing'])(
    'rejects a historical branch resource with %s damage on cold reads and reopen',
    async (damage) => {
      const harness = await createHarness();
      const bytes = Buffer.from(JSON.stringify(branchRecord));
      const ref = await harness.store.publish(
        'managed-branch-checkpoint',
        bytes,
      );
      await harness.authority.appendExecution(
        command('commitCheckpoint', 'committed'),
        [historicalCheckpoint(harness, ref)],
        HOLDS,
      );
      await harness.close();
      const resourcePath = path.join(
        harness.store.sessionRoot,
        ref.kind,
        ref.resourceId,
      );
      if (damage === 'missing') {
        await fs.unlink(resourcePath);
      } else {
        await fs.writeFile(
          resourcePath,
          Buffer.alloc(damage === 'length' ? 0 : bytes.length),
        );
      }
      const error =
        damage === 'digest'
          ? /digest/
          : damage === 'length'
            ? /bytes where/
            : /not present/;
      const before = await fs.readFile(harness.transcriptPath);
      await expect(
        readManagedSessionRecords({
          transcriptPath: harness.transcriptPath,
          runtimeBaseDir: harness.runtimeBaseDir,
          sessionKey,
        }),
      ).rejects.toThrow(error);
      const lease = await LocalManagedSessionAuthority.acquireWriter({
        runtimeBaseDir: harness.runtimeBaseDir,
        sessionId,
        transcriptPath: harness.transcriptPath,
      });
      try {
        await expect(
          LocalManagedSessionAuthority.open({
            lease,
            sessionKey,
            cwd: '/workspace',
            version: 'test',
            resources: harness.store,
          }),
        ).rejects.toThrow(error);
        expect(await fs.readFile(harness.transcriptPath)).toEqual(before);
      } finally {
        await lease.release();
      }
    },
  );

  it('rejects coverage of the same transaction on both hot and cold paths', async () => {
    const harness = await createHarness();
    const stateRef = await harness.store.publish(
      'managed-checkpoint',
      Buffer.from('state'),
    );
    const contentRef = await harness.store.publish(
      'managed-message',
      Buffer.from(JSON.stringify(records[0])),
    );
    const checkpoint = historicalCheckpoint(harness, stateRef, 'state-1');
    const events = [
      parseManagedSessionEvent({
        ...checkpoint,
        eventId: 'message-1',
        kind: 'message.committed',
        payload: {
          messageId: records[0].uuid,
          role: 'user',
          contentRef,
          parentMessageId: null,
        },
      }),
      parseManagedSessionEvent({
        ...checkpoint,
        sequence: checkpoint.sequence + 1,
        payload: {
          ...checkpoint.payload,
          coveredSequence: checkpoint.sequence,
        },
      }),
    ];
    try {
      await expect(
        harness.authority.appendExecution(
          command('commitCheckpoint', 'bad-coverage'),
          events,
          HOLDS,
        ),
      ).rejects.toThrow(/coverage/);
    } finally {
      await harness.close();
    }
    const scan = await readManagedSessionLog(
      harness.transcriptPath,
      sessionKey,
    );
    const marker = {
      transactionId: 'historical-batch',
      commandId: 'historical-batch',
      operation: 'commitCheckpoint',
      contentDigest: DIGEST,
      firstSequence: events[0].sequence,
      lastSequence: events[1].sequence,
      eventCount: events.length,
      eventsDigest: managedSessionEventsDigest(events),
      previousCommitDigest: scan.lastMarkerDigest,
    };
    await fs.appendFile(
      harness.transcriptPath,
      [
        ...events.map((event) =>
          JSON.stringify({
            subtype: 'managed_session_event_v1',
            managedSession: event,
          }),
        ),
        JSON.stringify({
          subtype: 'managed_session_commit_v1',
          managedSession: marker,
        }),
      ].join('\n') + '\n',
    );
    await expect(
      readManagedSessionRecords({
        transcriptPath: harness.transcriptPath,
        runtimeBaseDir: harness.runtimeBaseDir,
        sessionKey,
      }),
    ).rejects.toThrow(/not committed before its transaction/);
  });

  it.each([
    { label: 'input', record: records[0], basis: 'initial' },
    { label: 'assistant', record: records[1], basis: 'blocked' },
    { label: 'system input', record: records[2], basis: 'initial' },
    {
      label: 'tool result',
      record: { ...records[1], type: 'tool_result' } as ChatRecord,
      basis: 'blocked',
    },
  ])(
    'classifies $label without a checkpoint consistently on cold reopen',
    async ({ record, basis }) => {
      const harness = await createHarness();
      try {
        await harness.projection.commit(
          command('commitMessage', 'only-record'),
          { record },
          HOLDS,
        );
        expect(harness.authority.restoreBasis()).toBe(basis);
        expect(harness.authority.latestCheckpoint).toBeUndefined();
      } finally {
        await harness.close();
      }
      const lease = await LocalManagedSessionAuthority.acquireWriter({
        runtimeBaseDir: harness.runtimeBaseDir,
        sessionId,
        transcriptPath: harness.transcriptPath,
      });
      const reopened = await LocalManagedSessionAuthority.open({
        lease,
        sessionKey,
        cwd: '/workspace',
        version: 'test',
        resources: harness.store,
      });
      try {
        expect(reopened.restoreBasis()).toBe(basis);
        expect(reopened.latestCheckpoint).toBeUndefined();
      } finally {
        await reopened.close();
      }
    },
  );

  it('round trips records through the authoritative log without losing detail', async () => {
    const harness = await createHarness();
    for (const [index, record] of records.entries()) {
      await harness.projection.commit(
        command('commitMessage', `cmd-msg-${index}`),
        { record },
        HOLDS,
      );
    }

    const projected = await harness.projection.project();
    expect(projected).toEqual(records);
    await harness.close();
  });

  it('keeps no legacy copy of the projected records', async () => {
    const harness = await createHarness();
    await harness.projection.commit(
      command('commitMessage', 'cmd-msg-0'),
      { record: records[0] },
      HOLDS,
    );
    await harness.close();

    const subtypes = (await fs.readFile(harness.transcriptPath, 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as { subtype?: string }).subtype);

    /* The content lives only in the resource the event references, so no
       equivalent user/assistant record may sit beside it in the transcript. */
    expect(new Set(subtypes)).toEqual(
      new Set([
        'session_execution_engine',
        'managed_session_header_v1',
        'managed_session_event_v1',
        'managed_session_commit_v1',
      ]),
    );
  });

  it('survives a cold reopen', async () => {
    const harness = await createHarness();
    for (const [index, record] of records.entries()) {
      await harness.projection.commit(
        command('commitMessage', `cmd-msg-${index}`),
        { record },
        HOLDS,
      );
    }
    await harness.close();

    const lease = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir: harness.runtimeBaseDir,
      sessionId,
      transcriptPath: harness.transcriptPath,
    });
    const store = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: harness.runtimeBaseDir,
      sessionKey,
    });
    const reopened = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      resources: store,
    });
    const projected = await new ManagedSessionMessageProjection(
      reopened,
      store,
    ).project();
    expect(projected).toEqual(records);
    await reopened.close();
  });

  it('refuses a record with no uuid of its own', async () => {
    const harness = await createHarness();
    await expect(
      harness.projection.commit(
        command('commitMessage', 'cmd-msg-bad'),
        { record: { ...records[0], uuid: '' } as ChatRecord },
        HOLDS,
      ),
    ).rejects.toThrow(/must carry its own uuid/);
    await harness.close();
  });

  it('fails the projection when a content body is missing', async () => {
    const harness = await createHarness();
    await harness.projection.commit(
      command('commitMessage', 'cmd-msg-0'),
      { record: records[0] },
      HOLDS,
    );

    /* Dropping the record silently would present a short history as complete. */
    await fs.rm(
      path.join(
        managedSessionResourceRoot(harness.runtimeBaseDir, sessionId),
        'managed-message',
      ),
      { recursive: true, force: true },
    );
    await expect(harness.projection.project()).rejects.toThrow(
      /is not present for session/,
    );
    await harness.close();
  });
});
