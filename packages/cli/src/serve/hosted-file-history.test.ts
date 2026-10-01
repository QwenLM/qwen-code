/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  assertHostedFileHistoryCapacity,
  commitHostedFileHistory,
  HostedFileHistoryRefusedError,
  HOSTED_UUID,
  readHostedFileHistory,
  type HostedFileHistoryRecord,
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
  await session.authority.commitDomainRecord(
    {
      operation: 'commitFileHistory',
      commandId: randomUUID(),
      sessionKey: session.authority.sessionHeader.sessionKey,
      contentDigest: createHash('sha256')
        .update(JSON.stringify(record))
        .digest('hex'),
    },
    { domain: 'file_history', content: record },
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
