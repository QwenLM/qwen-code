/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  HarnessCheckpointPhase,
  HarnessRunAuthorization,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  parseHostedFileHistoryRecord,
  type HostedFileHistoryRecord,
} from './hosted-file-history-protocol.js';

export { HOSTED_UUID } from './hosted-file-history-protocol.js';
export type { HostedFileHistoryRecord } from './hosted-file-history-protocol.js';

export class HostedFileHistoryRefusedError extends Error {}

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
  return parseHostedFileHistoryRecord(
    JSON.parse(
      (await session.resources.read(latest.recordRef)).toString('utf8'),
    ),
    session.authority.sessionHeader.sessionKey.sessionId,
  );
}

type HarnessRunAuthorizationBlockedReason = Extract<
  HarnessRunAuthorization,
  { status: 'blocked' }
>['reason'];

/** One name per conjunct that can keep the pending turn from settling. */
export type HostedFileHistorySettleBlocker =
  | 'undo_pending'
  | 'no_pending_turn'
  | 'no_pending_message'
  | 'authorization_initial'
  | `authorization_blocked_${HarnessRunAuthorizationBlockedReason}`
  | 'checkpoint_identity_mismatch'
  | `phase_${HarnessCheckpointPhase}`
  | 'pending_message_not_ready'
  | 'tool_item_unsettled'
  | 'assistant_mismatch'
  | 'no_pending_tool_calls'
  | 'unexpected_tail_item'
  | 'duplicate_tool_call_id'
  | 'tool_results_mismatch';

/**
 * Null when the pending turn settles clean; a terse ground the cold-load
 * refusal may log when it does not. The grounds are the same conjuncts the
 * boolean version evaluated, in the same order, each with its own name.
 */
export async function canSettleHostedFileHistory(
  session: ManagedSession,
  record: HostedFileHistoryRecord,
): Promise<HostedFileHistorySettleBlocker | null> {
  if (record.pendingUndo) return 'undo_pending';
  if (!record.pendingTurn) return 'no_pending_turn';
  if (!record.pendingMessageId) return 'no_pending_message';
  const authorization = await session.authority.harnessRunAuthorization();
  if (authorization.status !== 'runnable')
    return authorization.status === 'blocked'
      ? `authorization_blocked_${authorization.reason}`
      : `authorization_${authorization.status}`;
  const checkpoint = authorization.checkpoint;
  const items = checkpoint.tools?.items ?? [];
  if (
    checkpoint.identity.promptId !== record.pendingTurn ||
    checkpoint.identity.turnId !== record.pendingTurn
  )
    return 'checkpoint_identity_mismatch';
  if (checkpoint.continuation.phase !== 'results_ready')
    return `phase_${checkpoint.continuation.phase}`;
  if (!items.some((item) => item.modelMessageId === record.pendingMessageId))
    return 'pending_message_not_ready';
  if (items.some((item) => item.state !== 'settled' || !item.outcomeRef))
    return 'tool_item_unsettled';
  const current = (await session.sink.project()).filter(
    (item) => item.daemonPromptId === record.pendingTurn,
  );
  const index = current.findLastIndex((item) => item.type === 'assistant');
  const assistant = current[index];
  if (assistant?.uuid !== record.pendingMessageId) return 'assistant_mismatch';
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
  if (calls.length === 0) return 'no_pending_tool_calls';
  if (!tail.every((item) => item.type === 'tool_result'))
    return 'unexpected_tail_item';
  if (new Set(calls).size !== calls.length) return 'duplicate_tool_call_id';
  return isDeepStrictEqual(calls.sort(), results.sort())
    ? null
    : 'tool_results_mismatch';
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
