/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { ManagedSessionEvent } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type {
  ChatRecord,
  ChatCompressionRecordPayload,
} from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  getRecordRewindId,
  isApiHistoryCompressionCandidate,
} from '@qwen-code/qwen-code-core/services/session-api-history.js';
import {
  getApiHistoryPromptId,
  markApiHistoryPrompt,
} from '@qwen-code/qwen-code-core/utils/api-history-metadata.js';

/**
 * Settlement comes from the journal. Only an interruption with committed model
 * work keeps its instruction; a bare abandoned input must not be replayed.
 */
export function excludedHostedPrompts(
  events: readonly ManagedSessionEvent[],
  records: readonly ChatRecord[],
): Set<string> {
  const committedWork = new Set(
    records
      .filter(
        (entry) => entry.type === 'assistant' || entry.type === 'tool_result',
      )
      .map((entry) => entry.daemonPromptId),
  );
  const excluded = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'turn.settled') continue;
    const turnId = event.payload['turnId'];
    if (typeof turnId !== 'string') continue;
    if (
      event.payload['outcome'] === 'error' ||
      (event.payload['outcome'] === 'cancelled' &&
        (event.payload['stopReason'] !== 'harness_interruption' ||
          !committedWork.has(turnId)))
    )
      excluded.add(turnId);
  }
  return excluded;
}

export function isExcludedHostedRecord(
  record: ChatRecord,
  excludedPromptIds: ReadonlySet<string>,
): boolean {
  return (
    record.daemonPromptId !== undefined &&
    excludedPromptIds.has(record.daemonPromptId)
  );
}

/** Model-only copies: rewind ids in older snapshots are not journal turn ids. */
export function normalizeHostedTurnRecords(
  records: readonly ChatRecord[],
  excludedPromptIds?: ReadonlySet<string>,
): ChatRecord[] {
  const owners = new Map(
    records
      .filter((record) => record.daemonPromptId !== undefined)
      .map((record) => [getRecordRewindId(record), record.daemonPromptId!]),
  );
  const snapshotIndex = records.findLastIndex(isApiHistoryCompressionCandidate);
  const snapshot = records[snapshotIndex]?.systemPayload as
    | ChatCompressionRecordPayload
    | undefined;
  const snapshotIds = snapshot?.promptIds?.map(
    (id) => owners.get(id ?? '') ?? id,
  );
  const firstExcludedRecord = records.findIndex(
    (record) =>
      record.daemonPromptId !== undefined &&
      excludedPromptIds?.has(record.daemonPromptId),
  );
  const knownOwners = new Set(snapshotIds);
  // Older snapshots did not mark wake-only groups. If their boundary is lost,
  // replay raw records rather than guessing where an excluded group ends.
  const unmarkedTail =
    Array.isArray(snapshot?.compressedHistory) &&
    snapshot.compressedHistory.some(
      (_, index) =>
        index >= (snapshot.summaryPrefixLength ?? 0) &&
        snapshotIds?.[index] == null,
    );
  const restoreRaw =
    unmarkedTail &&
    firstExcludedRecord >= 0 &&
    records
      .slice(firstExcludedRecord, snapshotIndex)
      .some(
        (record) =>
          record.message &&
          record.daemonPromptId !== undefined &&
          !knownOwners.has(record.daemonPromptId),
      );
  return records.flatMap((record) => {
    if (isApiHistoryCompressionCandidate(record)) {
      if (restoreRaw) return [];
      const payload = record.systemPayload as ChatCompressionRecordPayload;
      return [
        {
          ...record,
          systemPayload: {
            ...payload,
            promptIds: payload.promptIds?.map(
              (id) => owners.get(id ?? '') ?? id,
            ),
          },
        },
      ];
    }
    if (!record.message || record.daemonPromptId === undefined) return [record];
    const message = { ...record.message };
    markApiHistoryPrompt(message, record.daemonPromptId);
    return [
      {
        ...record,
        message,
        ...(record.type === 'user' && !record.subtype
          ? { promptId: record.daemonPromptId }
          : {}),
      },
    ];
  });
}

export function filterHostedTurnHistory(
  history: Content[],
  excludedPromptIds: ReadonlySet<string> | undefined,
): Content[] {
  let excluded = false;
  return history.filter((entry) => {
    const promptId = getApiHistoryPromptId(entry);
    // Legacy snapshots mark prompts alone. Their unmarked tool rounds and
    // queued guidance belong to that boundary until the next marked group.
    if (promptId !== undefined)
      excluded = excludedPromptIds?.has(promptId) ?? false;
    return !excluded;
  });
}
