/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  parseHostedFileHistoryState,
  type HostedFileHistoryState,
} from './hosted-file-history-protocol.js';

export interface HostedFileHistoryRecord {
  schemaVersion: 1;
  state: HostedFileHistoryState;
  pendingTurn: string | null;
  pendingUndo: { requestId: string; promptId: string } | null;
  undoReceipts?: Array<{
    requestId: string;
    promptId: string;
    filesChanged: string[];
    conflict: boolean;
  }>;
}

export async function readHostedFileHistory(
  session: ManagedSession,
): Promise<HostedFileHistoryRecord | undefined> {
  const latest = session.authority.domainRecord('file_history');
  if (!latest) return undefined;
  const record = JSON.parse(
    (await session.resources.read(latest.recordRef)).toString('utf8'),
  ) as HostedFileHistoryRecord;
  if (
    record.schemaVersion !== 1 ||
    !(record.pendingTurn === null || typeof record.pendingTurn === 'string') ||
    !(
      record.pendingUndo === null ||
      (typeof record.pendingUndo?.requestId === 'string' &&
        typeof record.pendingUndo.promptId === 'string')
    )
  )
    throw new Error('Invalid Hosted file history record.');
  return {
    schemaVersion: 1,
    state: parseHostedFileHistoryState(
      record.state,
      session.authority.sessionHeader.sessionKey.sessionId,
    ),
    pendingTurn: record.pendingTurn,
    pendingUndo: record.pendingUndo,
    undoReceipts: record.undoReceipts ?? [],
  };
}

export async function commitHostedFileHistory(
  session: ManagedSession,
  record: HostedFileHistoryRecord,
): Promise<void> {
  const saved = await readHostedFileHistory(session);
  record = {
    ...record,
    undoReceipts: record.undoReceipts ?? saved?.undoReceipts ?? [],
  };
  if (isDeepStrictEqual(saved, record)) return;
  const previous = (await session.sink.project()).at(-1);
  if (!previous)
    throw new Error('Hosted file history has no owning conversation.');
  await session.authority.commitDomainRecord(
    {
      operation: 'commitFileHistory',
      commandId: `hosted-history:${randomUUID()}`,
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
          sessionId: record.state.ownerSessionId,
          timestamp: new Date().toISOString(),
          type: 'system',
          subtype: 'file_history_snapshot',
          cwd: previous.cwd,
          version: previous.version,
          systemPayload: { snapshots: record.state.snapshots },
        },
      },
    },
    { class: 'trusted_entry' },
  );
}
