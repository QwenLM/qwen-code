/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  parseHostedFileHistoryState,
  type HostedFileHistoryState,
} from './hosted-file-history-protocol.js';

export interface HostedFileHistoryRecord {
  schemaVersion: 1;
  state: HostedFileHistoryState;
  pendingTurn: string | null;
  pendingMessageId?: string;
  pendingUndo: { requestId: string; promptId: string } | null;
  undoReceipts?: Array<{
    requestId: string;
    promptId: string;
    filesChanged: string[];
    conflict: boolean;
  }>;
}

export class HostedFileHistoryRefusedError extends Error {}

export const HOSTED_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function assertHostedFileHistoryCapacity(
  session: ManagedSession,
  record: HostedFileHistoryRecord,
): Promise<void> {
  const files = Object.keys(record.state.files);
  const receipts =
    record.undoReceipts ??
    (await readHostedFileHistory(session))?.undoReceipts ??
    [];
  const content = await fileHistoryContent(session, {
    ...record,
    state: {
      ...record.state,
      files: Object.fromEntries(
        files.map((file) => [
          file,
          { digest: `sha256:${'0'.repeat(64)}`, mode: 0o7777 },
        ]),
      ),
    },
    undoReceipts: [
      ...receipts,
      ...(record.pendingUndo
        ? [{ ...record.pendingUndo, filesChanged: files, conflict: false }]
        : []),
    ],
  });
  // Reserve the authority's UUID command, revision and prior resource reference.
  // Fingerprints and undo receipts above bound the record after file effects.
  if (
    Buffer.byteLength(JSON.stringify(content)) >
    HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes - 1024
  )
    throw new HostedFileHistoryRefusedError(
      'Hosted file history capacity is exhausted; no file mutation was started. Use a new Session for further Write/Edit.',
    );
}

async function fileHistoryContent(
  session: ManagedSession,
  record: HostedFileHistoryRecord,
) {
  const previous = (await session.sink.project()).at(-1);
  if (!previous)
    throw new Error('Hosted file history has no owning conversation.');
  return {
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
  };
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
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    record.schemaVersion !== 1 ||
    !(record.pendingTurn === null || typeof record.pendingTurn === 'string') ||
    (record.pendingMessageId !== undefined &&
      (typeof record.pendingMessageId !== 'string' || !record.pendingTurn)) ||
    !(
      record.pendingUndo === null ||
      (typeof record.pendingUndo?.requestId === 'string' &&
        typeof record.pendingUndo.promptId === 'string')
    )
  )
    throw new Error('Invalid Hosted file history record.');
  const state = parseHostedFileHistoryState(
    record.state,
    session.authority.sessionHeader.sessionKey.sessionId,
  );
  const undoReceipts =
    record.undoReceipts === undefined ? [] : record.undoReceipts;
  if (!Array.isArray(undoReceipts))
    throw new Error(
      'Invalid Hosted file history undo receipts: expected an array.',
    );
  const requests = new Set<string>();
  // Hosted rewind never truncates snapshots and prepare refuses at capacity.
  // Future retention (#13124) must prune dependent receipts in the same commit.
  const prompts = new Set(state.snapshots.map((snapshot) => snapshot.promptId));
  for (const [index, receipt] of undoReceipts.entries()) {
    const invalid = (reason: string): never => {
      throw new Error(
        `Invalid Hosted file history undo receipt ${index}: ${reason}.`,
      );
    };
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt) ||
      Object.keys(receipt).sort().join(',') !==
        'conflict,filesChanged,promptId,requestId'
    )
      invalid(
        'expected exactly requestId, promptId, filesChanged and conflict',
      );
    if (
      typeof receipt.requestId !== 'string' ||
      !HOSTED_UUID.test(receipt.requestId)
    )
      invalid('requestId must be a lowercase UUID v1-v5');
    if (
      typeof receipt.promptId !== 'string' ||
      !HOSTED_UUID.test(receipt.promptId)
    )
      invalid('promptId must be a lowercase UUID v1-v5');
    if (!prompts.has(receipt.promptId))
      invalid('promptId is not a retained snapshot');
    if (requests.has(receipt.requestId)) invalid('requestId is duplicated');
    if (typeof receipt.conflict !== 'boolean')
      invalid('conflict must be a boolean');
    if (!Array.isArray(receipt.filesChanged))
      invalid('filesChanged must be an array');
    if (
      receipt.filesChanged.some(
        (file) => typeof file !== 'string' || !Object.hasOwn(state.files, file),
      )
    )
      invalid('filesChanged must contain only tracked paths');
    if (new Set(receipt.filesChanged).size !== receipt.filesChanged.length)
      invalid('filesChanged contains duplicate paths');
    if (receipt.conflict && receipt.filesChanged.length !== 0)
      invalid('conflict must have no changed paths');
    if (
      record.pendingUndo?.requestId === receipt.requestId &&
      record.pendingUndo.promptId !== receipt.promptId
    )
      invalid('promptId does not match pendingUndo');
    requests.add(receipt.requestId);
  }
  return {
    schemaVersion: 1,
    state,
    pendingTurn: record.pendingTurn,
    ...(record.pendingMessageId !== undefined
      ? { pendingMessageId: record.pendingMessageId }
      : {}),
    pendingUndo: record.pendingUndo,
    undoReceipts,
  };
}

export async function canSettleHostedFileHistory(
  session: ManagedSession,
  record: HostedFileHistoryRecord,
): Promise<boolean> {
  if (!record.pendingTurn || !record.pendingMessageId || record.pendingUndo)
    return false;
  const authorization = await session.authority.harnessRunAuthorization();
  if (authorization.status !== 'runnable') return false;
  const checkpoint = authorization.checkpoint;
  const items = checkpoint.tools?.items ?? [];
  if (
    checkpoint.identity.promptId !== record.pendingTurn ||
    checkpoint.identity.turnId !== record.pendingTurn ||
    checkpoint.continuation.phase !== 'results_ready' ||
    !items.some((item) => item.modelMessageId === record.pendingMessageId) ||
    items.some((item) => item.state !== 'settled' || !item.outcomeRef)
  )
    return false;
  const current = (await session.sink.project()).filter(
    (item) => item.daemonPromptId === record.pendingTurn,
  );
  const index = current.findLastIndex((item) => item.type === 'assistant');
  const assistant = current[index];
  if (assistant?.uuid !== record.pendingMessageId) return false;
  const calls =
    assistant.message?.parts?.flatMap((part) =>
      part.functionCall?.id ? [part.functionCall.id] : [],
    ) ?? [];
  const tail = current.slice(index + 1);
  const results = tail.flatMap(
    (item) =>
      item.message?.parts?.flatMap((part) =>
        part.functionResponse?.id ? [part.functionResponse.id] : [],
      ) ?? [],
  );
  return (
    calls.length > 0 &&
    tail.every((item) => item.type === 'tool_result') &&
    new Set(calls).size === calls.length &&
    isDeepStrictEqual(calls.sort(), results.sort())
  );
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
  const content = await fileHistoryContent(session, record);
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
      content,
    },
    { class: 'trusted_entry' },
  );
}
