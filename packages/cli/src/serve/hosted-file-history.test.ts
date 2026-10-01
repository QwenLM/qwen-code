/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
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
