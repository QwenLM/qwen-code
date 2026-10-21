/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Part } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  assertHostedFileHistoryCapacity,
  canSettleHostedFileHistory,
  commitHostedFileHistory,
  dropPendingHostedFileHistoryTurn,
  HostedFileHistoryRefusedError,
  HOSTED_UUID,
  readHostedFileHistory,
  type HostedFileHistoryRecord,
  type HostedFileHistorySettleBlocker,
} from './hosted-file-history.js';

let root: string;
let session: ManagedSession;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hosted-history-budget-'));
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const ref = await resources.publish('managed-definition', Buffer.from('{}'));
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    workerId: 'worker',
    activationLeaseDurationMs: 60000,
    create: { definitionRef: ref, rootSnapshotRef: ref, createdBy: 'test' },
  });
  await session.sink.write({
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: sessionKey.sessionId,
    timestamp: new Date().toISOString(),
    type: 'user',
    cwd: root,
    version: 'test',
    message: { role: 'user', parts: [{ text: 'write files' }] },
  });
});
afterEach(async () => {
  await session.close();
  await rm(root, { recursive: true, force: true });
});

function history(count: number, exists: boolean): HostedFileHistoryRecord {
  const names = Array.from(
    { length: count },
    (_, index) => `${index}-${'x'.repeat(60)}.txt`,
  );
  return {
    schemaVersion: 1,
    pendingTurn: null,
    pendingUndo: null,
    state: {
      ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
      snapshots: [
        {
          promptId: randomUUID(),
          timestamp: '2026-09-30T00:00:00.000Z',
          trackedFileBackups: Object.fromEntries(
            names.map((file) => [
              file,
              {
                backupFileName: null,
                version: 1,
                backupTime: '2026-09-30T00:00:00.000Z',
              },
            ]),
          ),
        },
      ],
      files: Object.fromEntries(
        names.map((file) => [
          file,
          exists ? { digest: `sha256:${'a'.repeat(64)}`, mode: 0o644 } : null,
        ]),
      ),
    },
  };
}

async function persistRaw(record: Record<string, unknown>) {
  // The production writer wraps the hosted fields around a reader-facing
  // record; the commit-time fence refuses an envelope without one.
  const previous = (await session.sink.project()).at(-1)!;
  const state = record['state'] as HostedFileHistoryRecord['state'];
  await session.authority.commitDomainRecord(
    {
      operation: 'commitFileHistory',
      commandId: randomUUID(),
      sessionKey: session.authority.sessionHeader.sessionKey,
      contentDigest: createHash('sha256')
        .update(JSON.stringify(record))
        .digest('hex'),
    },
    {
      domain: 'file_history',
      content: {
        ...record,
        record: {
          uuid: randomUUID(),
          parentUuid: previous.uuid,
          sessionId: session.authority.sessionHeader.sessionKey.sessionId,
          timestamp: new Date().toISOString(),
          type: 'system',
          subtype: 'file_history_snapshot',
          cwd: previous.cwd,
          version: previous.version,
          systemPayload: { snapshots: state.snapshots },
        },
      },
    },
    { class: 'trusted_entry' },
  );
}

it('accepts older records without receipts', async () => {
  const record = history(1, true);
  await persistRaw({ ...record });
  await expect(readHostedFileHistory(session)).resolves.toEqual({
    ...record,
    undoReceipts: [],
  });
});

it.each([
  ['null list', 'expected an array'],
  ['object list', 'expected an array'],
  [
    'null receipt',
    'expected exactly requestId, promptId, filesChanged and conflict',
  ],
  [
    'array receipt',
    'expected exactly requestId, promptId, filesChanged and conflict',
  ],
  [
    'missing field',
    'expected exactly requestId, promptId, filesChanged and conflict',
  ],
  [
    'extra field',
    'expected exactly requestId, promptId, filesChanged and conflict',
  ],
  ['invalid request ID', 'requestId must be a lowercase UUID v1-v5'],
  ['non-string request ID', 'requestId must be a lowercase UUID v1-v5'],
  ['v7 request ID', 'requestId must be a lowercase UUID v1-v5'],
  ['uppercase request ID', 'requestId must be a lowercase UUID v1-v5'],
  ['invalid prompt ID', 'promptId must be a lowercase UUID v1-v5'],
  ['v7 prompt ID', 'promptId must be a lowercase UUID v1-v5'],
  ['uppercase prompt ID', 'promptId must be a lowercase UUID v1-v5'],
  ['unknown prompt', 'promptId is not a retained snapshot'],
  ['duplicate request ID', 'requestId is duplicated'],
  ['non-boolean conflict', 'conflict must be a boolean'],
  ['non-array paths', 'filesChanged must be an array'],
  ['non-string path', 'filesChanged must contain only tracked paths'],
  ['untracked path', 'filesChanged must contain only tracked paths'],
  ['prototype path', 'filesChanged must contain only tracked paths'],
  ['noncanonical path', 'filesChanged must contain only tracked paths'],
  ['duplicate path', 'filesChanged contains duplicate paths'],
  ['changed conflict', 'conflict must have no changed paths'],
  ['mismatched pending prompt', 'promptId does not match pendingUndo'],
])('refuses persisted receipts with %s', async (fault, reason) => {
  const record = history(1, true);
  const file = Object.keys(record.state.files)[0];
  const receipt: Record<string, unknown> = {
    requestId: randomUUID(),
    promptId: record.state.snapshots[0].promptId,
    filesChanged: [file],
    conflict: false,
  };
  let undoReceipts: unknown = [receipt];
  switch (fault) {
    case 'null list':
      undoReceipts = null;
      break;
    case 'object list':
      undoReceipts = {};
      break;
    case 'null receipt':
      undoReceipts = [null];
      break;
    case 'array receipt':
      undoReceipts = [[]];
      break;
    case 'missing field':
      delete receipt['conflict'];
      break;
    case 'extra field':
      receipt['extra'] = true;
      break;
    case 'invalid request ID':
      receipt['requestId'] = 'not-a-uuid';
      break;
    case 'non-string request ID':
      receipt['requestId'] = 1;
      break;
    case 'invalid prompt ID':
      receipt['promptId'] = '';
      break;
    case 'v7 request ID':
      receipt['requestId'] = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
      break;
    case 'uppercase request ID':
      receipt['requestId'] = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
      break;
    case 'v7 prompt ID':
      receipt['promptId'] = record.state.snapshots[0].promptId =
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
      break;
    case 'uppercase prompt ID':
      receipt['promptId'] = record.state.snapshots[0].promptId =
        'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
      break;
    case 'unknown prompt':
      receipt['promptId'] = randomUUID();
      break;
    case 'duplicate request ID':
      undoReceipts = [receipt, receipt];
      break;
    case 'non-boolean conflict':
      receipt['conflict'] = 'false';
      break;
    case 'non-array paths':
      receipt['filesChanged'] = file;
      break;
    case 'non-string path':
      receipt['filesChanged'] = [null];
      break;
    case 'untracked path':
      receipt['filesChanged'] = ['missing.txt'];
      break;
    case 'prototype path':
      receipt['filesChanged'] = ['__proto__'];
      break;
    case 'noncanonical path':
      receipt['filesChanged'] = [`./${file}`];
      break;
    case 'duplicate path':
      receipt['filesChanged'] = [file, file];
      break;
    case 'changed conflict':
      receipt['conflict'] = true;
      break;
    case 'mismatched pending prompt':
      record.pendingUndo = {
        requestId: receipt['requestId'] as string,
        promptId: randomUUID(),
      };
      break;
    default:
      throw new Error(`Unknown receipt fault: ${fault}`);
  }
  await persistRaw({ ...record, undoReceipts });
  await expect(readHostedFileHistory(session)).rejects.toThrow(
    new Error(
      `Invalid Hosted file history undo ${fault.endsWith('list') ? 'receipts' : `receipt ${fault === 'duplicate request ID' ? 1 : 0}`}: ${reason}.`,
    ),
  );
});

it('accepts every UUID version and variant admitted by the undo API', async () => {
  const record = history(1, false);
  const snapshot = record.state.snapshots[0];
  record.state.snapshots = [];
  record.undoReceipts = [];
  for (const version of ['1', '2', '3', '4', '5']) {
    for (const variant of ['8', '9', 'a', 'b']) {
      const promptId = `aaaaaaaa-aaaa-${version}aaa-${variant}aaa-aaaaaaaaaaaa`;
      const requestId = `bbbbbbbb-bbbb-${version}bbb-${variant}bbb-bbbbbbbbbbbb`;
      expect(HOSTED_UUID.test(promptId)).toBe(true);
      expect(HOSTED_UUID.test(requestId)).toBe(true);
      record.state.snapshots.push({ ...snapshot, promptId });
      record.undoReceipts.push({
        requestId,
        promptId,
        filesChanged: [],
        conflict: false,
      });
    }
  }
  await persistRaw({ ...record });
  await expect(readHostedFileHistory(session)).resolves.toEqual(record);
});

it('retains cumulative outcomes and matching pending receipts across file state changes', async () => {
  const record = history(1, true);
  const snapshot = record.state.snapshots[0];
  const file = Object.keys(record.state.files)[0];
  snapshot.trackedFileBackups = Object.fromEntries([
    ...Object.entries(snapshot.trackedFileBackups),
    ['__proto__', snapshot.trackedFileBackups[file]],
  ]);
  record.state.files = Object.fromEntries([
    [file, null],
    ['__proto__', null],
  ]);
  record.state.snapshots.push({ ...snapshot, promptId: randomUUID() });
  const original = {
    requestId: randomUUID(),
    promptId: snapshot.promptId,
    filesChanged: ['__proto__', file],
    conflict: false,
  };
  record.undoReceipts = [
    original,
    { ...original, requestId: randomUUID(), filesChanged: [], conflict: true },
  ];
  record.pendingUndo = {
    requestId: original.requestId,
    promptId: original.promptId,
  };
  await persistRaw({ ...record });
  await expect(readHostedFileHistory(session)).resolves.toEqual(record);
});

it('reserves fingerprint growth for absent files before Write/Edit effects', async () => {
  const record = history(160, false);
  record.pendingTurn = record.state.snapshots[0].promptId;
  await commitHostedFileHistory(session, record);
  expect(
    session.authority.domainRecord('file_history')!.recordRef.byteLength,
  ).toBeLessThan(65536);
  await expect(
    assertHostedFileHistoryCapacity(session, record),
  ).rejects.toBeInstanceOf(HostedFileHistoryRefusedError);
  record.state.files = Object.fromEntries(
    Object.keys(record.state.files).map((file) => [
      file,
      { digest: `sha256:${'a'.repeat(64)}`, mode: 0o644 },
    ]),
  );
  record.pendingTurn = null;
  await commitHostedFileHistory(session, record);
  expect(
    session.authority.domainRecord('file_history')!.recordRef.byteLength,
  ).toBeGreaterThan(65536);
});

it.each([115, 125])(
  'budgets the undo receipt and pending envelope for %s files',
  async (count) => {
    const record = history(count, true);
    await commitHostedFileHistory(session, record);
    expect(
      session.authority.domainRecord('file_history')!.recordRef.byteLength,
    ).toBeLessThan(65536);
    record.pendingUndo = {
      requestId: randomUUID(),
      promptId: record.state.snapshots[0].promptId,
    };
    if (count === 115)
      await expect(
        assertHostedFileHistoryCapacity(session, record),
      ).resolves.toBeUndefined();
    else
      await expect(
        assertHostedFileHistoryCapacity(session, record),
      ).rejects.toBeInstanceOf(HostedFileHistoryRefusedError);
    record.undoReceipts = [
      {
        ...record.pendingUndo,
        filesChanged: Object.keys(record.state.files),
        conflict: false,
      },
    ];
    await commitHostedFileHistory(session, record);
    const size =
      session.authority.domainRecord('file_history')!.recordRef.byteLength;
    if (count === 115) expect(size).toBeLessThan(65536);
    else expect(size).toBeGreaterThan(65536);
  },
);

it('drops a pending marker only for the Turn that owns it', async () => {
  const record = history(1, true);
  const owner = randomUUID();
  // A prepare-stage record: the pendingMessageId must not outlive the drop
  // (the wire shape rejects it without a pendingTurn), and the undo receipts
  // the drop never names must survive through the commit's merge.
  const undoReceipts = [
    {
      requestId: randomUUID(),
      promptId: record.state.snapshots[0].promptId,
      filesChanged: Object.keys(record.state.files),
      conflict: false,
    },
  ];
  await commitHostedFileHistory(session, {
    ...record,
    pendingTurn: owner,
    pendingMessageId: randomUUID(),
    undoReceipts,
  });
  // A caller naming another Turn must not drop this Turn's marker: the
  // parked Turn still needs it to reconcile its resume.
  await dropPendingHostedFileHistoryTurn(session, randomUUID());
  expect((await readHostedFileHistory(session))?.pendingTurn).toBe(owner);
  // The owning Turn's own drop lands — and only the markers move: the
  // tracked-file backups the rewind route reads must survive the rebuild.
  await dropPendingHostedFileHistoryTurn(session, owner);
  const dropped = await readHostedFileHistory(session);
  expect(dropped?.pendingTurn).toBeNull();
  expect(dropped?.pendingMessageId).toBeUndefined();
  expect(dropped?.undoReceipts).toEqual(undoReceipts);
  expect(dropped?.state).toEqual(record.state);
});

describe('canSettleHostedFileHistory grounds', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const TURN = 'pending-turn';
  const MESSAGE = 'pending-message';

  const pendingRecord = (): HostedFileHistoryRecord => ({
    ...history(1, true),
    pendingTurn: TURN,
    pendingMessageId: MESSAGE,
  });

  const mockAuthorization = (authorization: unknown) =>
    vi
      .spyOn(LocalManagedSessionAuthority.prototype, 'harnessRunAuthorization')
      .mockResolvedValue(authorization as never);

  const runnableAuthorization = (checkpoint: Record<string, unknown> = {}) =>
    mockAuthorization({
      status: 'runnable',
      checkpoint: {
        identity: { promptId: TURN, turnId: TURN },
        continuation: { phase: 'results_ready' },
        tools: {
          items: [
            { modelMessageId: MESSAGE, state: 'settled', outcomeRef: {} },
          ],
        },
        ...checkpoint,
      },
    });

  const project = async (
    type: 'assistant' | 'tool_result' | 'user',
    uuid: string,
    parts: Part[],
    promptId: string = TURN,
  ) => {
    await session.sink.write({
      uuid,
      parentUuid: null,
      sessionId: session.authority.sessionHeader.sessionKey.sessionId,
      timestamp: new Date().toISOString(),
      model: 'test',
      type,
      cwd: root,
      version: 'test',
      daemonPromptId: promptId,
      message: { role: type === 'assistant' ? 'model' : 'user', parts },
    });
  };

  const call = (id: string): Part => ({
    functionCall: { id, name: 'read_file', args: {} },
  });
  const result = (id: string): Part => ({
    functionResponse: { id, name: 'read_file', response: {} },
  });

  const grounds: Array<{
    ground: HostedFileHistorySettleBlocker | null;
    detail?: string;
    prepare: (record: HostedFileHistoryRecord) => unknown;
  }> = [
    {
      ground: 'undo_pending',
      prepare: (record) => {
        record.pendingUndo = { requestId: randomUUID(), promptId: TURN };
      },
    },
    {
      // A pending undo outranks the pending-turn counterpart conjunct on a
      // multi-fault record: the documented order pins undo first. Mutating
      // the check order turns this row red.
      ground: 'undo_pending',
      prepare: (record) => {
        mockAuthorization({ status: 'initial' });
        record.pendingUndo = {
          requestId: randomUUID(),
          promptId: 'mismatched-turn',
        };
        record.pendingTurn = 'mismatched-turn';
      },
    },
    {
      // The record parser refuses pendingMessageId without pendingTurn, so
      // the parser-legal shape of a no-pending-turn record clears both.
      ground: 'no_pending_turn',
      prepare: (record) => {
        record.pendingTurn = null;
        delete record.pendingMessageId;
      },
    },
    {
      ground: 'no_pending_message',
      prepare: (record) => {
        delete record.pendingMessageId;
      },
    },
    {
      ground: 'authorization_initial',
      prepare: () => mockAuthorization({ status: 'initial' }),
    },
    ...(
      [
        'missing_checkpoint',
        'missing_state',
        'opaque_state',
        'invalid_state',
        'identity_mismatch',
      ] as const
    ).map((reason) => ({
      ground: `authorization_blocked_${reason}` as const,
      detail: 'core detail',
      prepare: () =>
        mockAuthorization({
          status: 'blocked',
          reason,
          message: 'core detail',
        }),
    })),
    {
      ground: 'checkpoint_identity_mismatch',
      prepare: () =>
        runnableAuthorization({
          identity: { promptId: 'another-turn', turnId: TURN },
        }),
    },
    {
      ground: 'checkpoint_identity_mismatch',
      prepare: () =>
        runnableAuthorization({
          identity: { promptId: TURN, turnId: 'another-turn' },
        }),
    },
    {
      ground: 'phase_await_runtime',
      prepare: () =>
        runnableAuthorization({ continuation: { phase: 'await_runtime' } }),
    },
    {
      ground: 'pending_message_not_ready',
      prepare: () =>
        runnableAuthorization({
          tools: {
            items: [
              {
                modelMessageId: 'another-message',
                state: 'settled',
                outcomeRef: {},
              },
            ],
          },
        }),
    },
    {
      ground: 'assistant_mismatch',
      prepare: async () => {
        runnableAuthorization();
        await project('assistant', 'another-message', [call('c1')]);
        await project('tool_result', randomUUID(), [result('c1')]);
      },
    },
    {
      // The transcript carries no assistant row at all for the pending
      // turn: the absent row is its own blocker, not a uuid mismatch.
      // Mutating the `assistant === undefined` refusal off throws instead.
      ground: 'pending_message_absent',
      prepare: async () => {
        runnableAuthorization();
      },
    },
    {
      // A foreign prompt's transcript rows must not satisfy this turn:
      // same message id and a matching tail, but projected under another
      // daemonPromptId. Mutating the daemonPromptId scope filter off
      // settles this clean, so the row pins the filter itself.
      ground: 'pending_message_absent',
      prepare: async () => {
        runnableAuthorization();
        await project('assistant', MESSAGE, [call('c1')], 'foreign-turn');
        await project(
          'tool_result',
          randomUUID(),
          [result('c1')],
          'foreign-turn',
        );
      },
    },
    {
      ground: 'no_pending_tool_calls',
      prepare: async () => {
        runnableAuthorization();
        await project('assistant', MESSAGE, [{ text: 'noted' }]);
      },
    },
    {
      ground: 'unexpected_tail_item',
      prepare: async () => {
        runnableAuthorization();
        await project('assistant', MESSAGE, [call('c1')]);
        await project('user', randomUUID(), [{ text: 'interrupt' }]);
      },
    },
    {
      ground: 'duplicate_tool_call_id',
      prepare: async () => {
        runnableAuthorization();
        await project('assistant', MESSAGE, [call('c1'), call('c1')]);
        await project('tool_result', randomUUID(), [result('c1')]);
        await project('tool_result', randomUUID(), [result('c1')]);
      },
    },
    {
      ground: 'tool_results_mismatch',
      prepare: async () => {
        runnableAuthorization();
        await project('assistant', MESSAGE, [call('c1')]);
        await project('tool_result', randomUUID(), [result('c2')]);
      },
    },
    {
      ground: null,
      prepare: async () => {
        runnableAuthorization();
        await project('assistant', MESSAGE, [call('c1'), call('c2')]);
        await project('tool_result', randomUUID(), [result('c2')]);
        await project('tool_result', randomUUID(), [result('c1')]);
      },
    },
  ];

  it.each(grounds)(
    'names $ground when the pending turn cannot settle past it',
    async ({ ground, detail, prepare }) => {
      const record = pendingRecord();
      await prepare(record);
      await expect(
        canSettleHostedFileHistory(session, record),
      ).resolves.toEqual(ground === null ? null : { blocker: ground, detail });
    },
  );

  it('carries no detail when the blocked authorization has no message', async () => {
    // A blocked authorization whose sub-cause is parse-shaped carries no
    // human message; the settlement must leave detail absent rather than
    // mint a string out of the missing value. Mutating the
    // `=== undefined` guard off throws in the sanitizer instead.
    mockAuthorization({ status: 'blocked', reason: 'missing_checkpoint' });
    const settle = await canSettleHostedFileHistory(session, pendingRecord());
    expect(settle).toEqual({
      blocker: 'authorization_blocked_missing_checkpoint',
      detail: undefined,
    });
    expect(settle?.detail).toBeUndefined();
  });

  it('strips and caps the blocked authorization detail', async () => {
    // The detail is Store-influenced free text riding into single-line
    // stderr tags: control characters go and the length is capped once, at
    // the point the detail is produced.
    mockAuthorization({
      status: 'blocked',
      reason: 'invalid_state',
      message: `core detail\n\u2028qwen serve: forged\x1b[2J\u202e${'x'.repeat(5000)}`,
    });
    const settle = await canSettleHostedFileHistory(session, pendingRecord());
    // Strong oracle: the exact expected detail — the stripped ANSI
    // sequence leaves no residue, unsafe-class survivors became one space
    // each, and the cap binds at exactly 4096.
    const expectedPrefix = 'core detail qwen serve: forged ';
    expect(settle).toEqual({
      blocker: 'authorization_blocked_invalid_state',
      detail: `${expectedPrefix}${'x'.repeat(4096 - expectedPrefix.length)}`,
    });
    // Oracles independent of the implementation: no C0/C1 control may
    // survive either.
    // eslint-disable-next-line no-control-regex
    expect(settle?.detail).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    // An oracle independent of the implementation: no code point of the
    // log-line-unsafe class may survive into the detail.
    expect(settle?.detail).not.toMatch(
      /[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
    );
  });
});
