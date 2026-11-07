/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type {
  ChatCompressionRecordPayload,
  CustomTitleRecordPayload,
  ChatRecord,
  FileHistorySnapshotRecordPayload,
  SlashCommandRecordPayload,
  UiTelemetryRecordPayload,
} from '../services/chatRecordingService.js';
import { prepareTranscriptRecords } from './transcript-records.js';

import type { SerializedFileHistorySnapshot } from '../services/fileHistoryService.js';
import { removeFileHistorySnapshots } from './file-history-snapshots.js';

export interface MessageGroup {
  id: string;
  promptId?: string;
  promptIds?: string[];
  recordIds: string[];
}

export interface MessageGroupsSnapshot {
  snapshot: string;
  groups: MessageGroup[];
}

export interface DeleteMessageGroupsRequest {
  snapshot: string;
  groupIds: string[];
}

export interface DeleteMessageGroupsResult {
  deletedGroupIds: string[];
  deletedPromptIds: string[];
  removedApiPromptIds: string[];
}

export class MessageGroupDeletionError extends Error {
  constructor(
    readonly code:
      | 'unsupported'
      | 'conflict'
      | 'invalid_groups'
      | 'invalid_history',
    message: string,
  ) {
    super(message);
    this.name = 'MessageGroupDeletionError';
  }
}

export function messageGroupsSnapshot(records: readonly ChatRecord[]): string {
  const history = records.filter(
    (record) =>
      record.type !== 'system' ||
      (record.subtype !== 'ui_telemetry' &&
        !(
          record.subtype === 'custom_title' &&
          (record.systemPayload as CustomTitleRecordPayload | undefined)
            ?.titleSource === 'auto'
        )),
  );
  return createHash('sha256').update(JSON.stringify(history)).digest('hex');
}

export function parseMessageGroupTranscript(text: string): ChatRecord[] {
  try {
    if (text.length > 0 && !text.endsWith('\n')) throw new Error('Torn tail');
    const records: ChatRecord[] = text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ChatRecord);
    const prepared = prepareTranscriptRecords(records);
    if (prepared.diagnostics.some((item) => item.affectsCompleteness)) {
      throw new Error('Incomplete transcript');
    }
    const byId = new Map(
      records.toReversed().map((record) => [record.uuid, record]),
    );
    // Also check abandoned branches, whose edges a physical rewrite retains.
    const checked = new Set<string>();
    for (const record of records) {
      const seen = new Set<string>();
      let parent: string | null = record.uuid;
      while (parent !== null && !checked.has(parent)) {
        if (seen.has(parent) || !byId.has(parent)) {
          throw new Error('Invalid transcript ancestry');
        }
        seen.add(parent);
        parent = byId.get(parent)!.parentUuid;
      }
      for (const id of seen) checked.add(id);
    }
    return records;
  } catch (error) {
    if (error instanceof MessageGroupDeletionError) throw error;
    throw new MessageGroupDeletionError(
      'invalid_history',
      'The session history is incomplete or has ambiguous identities',
    );
  }
}

const GROUP_SYSTEM_SUBTYPES = new Set([
  'slash_command',
  'ui_telemetry',
  'at_command',
  'omni_recall',
  'user_text_elements',
  'turn_result',
  'turn_attempt',
  'branch_checkpoint',
  // The snapshot records a catalog part this turn appended to the model
  // history. Keeping it after the turn is gone would reattach it to an
  // earlier turn on replay, restoring content the rewound session never
  // had; the next durable request re-appends the current catalog anyway.
  'memory_catalog_snapshot',
]);

export function telemetryRecordIdentity(record: ChatRecord): {
  promptId?: string;
  callId?: string;
} {
  if (record.subtype !== 'ui_telemetry') return {};
  const event = (record.systemPayload as UiTelemetryRecordPayload | undefined)
    ?.uiEvent;
  if (!event) return {};
  const promptId =
    'prompt_id' in event
      ? event.prompt_id
      : 'promptId' in event
        ? event.promptId
        : undefined;
  const callId =
    'call_id' in event
      ? event.call_id
      : 'callId' in event
        ? event.callId
        : undefined;
  return {
    promptId: typeof promptId === 'string' ? promptId : undefined,
    callId: typeof callId === 'string' ? callId : undefined,
  };
}

export function getTranscriptMessageGroups(
  records: ChatRecord[],
): MessageGroup[] {
  const active = prepareTranscriptRecords(records).records as ChatRecord[];
  const groups: MessageGroup[] = [];
  const groupsByPromptId = new Map<string, MessageGroup>();
  let group: MessageGroup | undefined;
  let owner: ChatRecord | undefined;
  let command: string | undefined;
  const telemetry: ChatRecord[] = [];
  for (const record of active) {
    if (record.subtype === 'ui_telemetry') {
      telemetry.push(record);
      continue;
    }
    const independentInput =
      record.type === 'user' &&
      ((record.subtype === 'notification' &&
        record.deliveredTurn !== true &&
        !record.backgroundTurn) ||
        record.subtype === 'agent_message' ||
        record.subtype === 'agent_mention');
    const slash =
      record.subtype === 'slash_command'
        ? (record.systemPayload as SlashCommandRecordPayload | undefined)
        : undefined;
    if (
      record.subtype === 'slash_command' &&
      (!slash ||
        !['invocation', 'result'].includes(slash.phase) ||
        typeof slash.rawCommand !== 'string')
    ) {
      throw new MessageGroupDeletionError(
        'invalid_history',
        'Invalid slash command record',
      );
    }
    if (record.type === 'user' && record.subtype === undefined) {
      if (
        owner?.subtype === 'turn_attempt' &&
        record.daemonPromptId !== undefined &&
        owner.daemonPromptId === record.daemonPromptId
      ) {
        group!.id = record.uuid;
      } else {
        group = {
          id: record.uuid,
          ...(record.daemonPromptId ? { promptId: record.daemonPromptId } : {}),
          recordIds: [],
        };
        groups.push(group);
      }
      command =
        record.message?.parts?.length === 1
          ? record.message.parts[0]?.text
          : undefined;
      owner = record;
      if (record.promptId) groupsByPromptId.set(record.promptId, group!);
    } else if (record.subtype === 'turn_attempt') {
      group = record.promptId
        ? groupsByPromptId.get(record.promptId)
        : undefined;
      if (!group) {
        group = {
          id: record.uuid,
          ...(record.daemonPromptId ? { promptId: record.daemonPromptId } : {}),
          recordIds: [],
        };
        groups.push(group);
        if (record.promptId) groupsByPromptId.set(record.promptId, group);
      }
      command = undefined;
      owner = record;
    } else if (slash?.phase === 'invocation') {
      group = { id: record.uuid, recordIds: [] };
      groups.push(group);
      command = slash.rawCommand;
      owner = record;
    } else if (slash?.phase === 'result' && command !== slash.rawCommand) {
      group = { id: record.uuid, recordIds: [] };
      groups.push(group);
      command = slash.rawCommand;
      owner = record;
    } else if (
      record.type === 'user' &&
      record.subtype !== 'mid_turn_user_message' &&
      !independentInput
    ) {
      // Background turns and injected external input are not ordinary turns.
      group = undefined;
      command = undefined;
      owner = undefined;
    }
    if (
      group &&
      !independentInput &&
      (record.type !== 'system' ||
        GROUP_SYSTEM_SUBTYPES.has(record.subtype ?? ''))
    ) {
      group.recordIds.push(record.uuid);
    }
  }
  const byId = new Map(active.map((record) => [record.uuid, record]));
  const byCall = new Map<string, MessageGroup>();
  for (const item of groups) {
    for (const id of item.recordIds) {
      const record = byId.get(id)!;
      if (record.promptId) groupsByPromptId.set(record.promptId, item);
      if (record.daemonPromptId)
        groupsByPromptId.set(record.daemonPromptId, item);
      for (const part of record.message?.parts ?? []) {
        if (part.functionCall?.id) byCall.set(part.functionCall.id, item);
      }
    }
  }
  for (const record of telemetry) {
    const { promptId, callId } = telemetryRecordIdentity(record);
    const owner = promptId
      ? groupsByPromptId.get(promptId)
      : callId
        ? byCall.get(callId)
        : undefined;
    owner?.recordIds.push(record.uuid);
  }
  return groups
    .filter((item) => item.recordIds.length > 0)
    .map((item) => {
      const promptIds = [
        ...new Set(
          item.recordIds
            .map((id) => byId.get(id)?.daemonPromptId)
            .filter(
              (id): id is string => typeof id === 'string' && id.length > 0,
            ),
        ),
      ];
      return { ...item, ...(promptIds.length > 0 ? { promptIds } : {}) };
    });
}

function pruneCompression(
  record: ChatRecord,
  removedPromptIds: ReadonlySet<string>,
  earlierPromptIds: ReadonlySet<string>,
  removedToolCalls: ReadonlySet<string>,
): ChatRecord {
  if (record.subtype !== 'chat_compression') return record;
  const payload = record.systemPayload as ChatCompressionRecordPayload;
  if (!Array.isArray(payload?.compressedHistory)) {
    throw new MessageGroupDeletionError(
      'invalid_history',
      'Invalid compression checkpoint',
    );
  }
  const affectsEarlierInput = earlierPromptIds.size > 0;
  const prefix = payload.summaryPrefixLength;
  if (
    prefix !== undefined &&
    (!Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > payload.compressedHistory.length)
  ) {
    throw new MessageGroupDeletionError(
      'invalid_history',
      'Invalid summary boundary',
    );
  }
  const assertNoRetainedToolCopies = (indices: number[]) => {
    if (
      indices.some((index) =>
        payload.compressedHistory[index]?.parts?.some((part) => {
          const id = part.functionCall?.id ?? part.functionResponse?.id;
          return id && removedToolCalls.has(id);
        }),
      )
    ) {
      throw new MessageGroupDeletionError(
        'invalid_history',
        'Cannot safely delete a tool call retained inside unowned compression context',
      );
    }
  };
  if (!payload.promptIds) {
    if (affectsEarlierInput && prefix !== payload.compressedHistory.length) {
      throw new MessageGroupDeletionError(
        'invalid_history',
        'This compression checkpoint has no reliable raw input identities',
      );
    }
    assertNoRetainedToolCopies(
      payload.compressedHistory.map((_, index) => index),
    );
    return record;
  }
  if (payload.promptIds.length !== payload.compressedHistory.length) {
    throw new MessageGroupDeletionError(
      'invalid_history',
      'Invalid compression identities',
    );
  }
  const known = new Set(payload.promptIds.filter(Boolean));
  const hasUnidentifiedSelectedInput = [...earlierPromptIds].some(
    (id) => !known.has(id),
  );
  let removing = false;
  const seen = new Set<string>();
  const retained: number[] = [];
  for (let index = 0; index < payload.compressedHistory.length; index++) {
    if (prefix !== undefined && index < prefix) {
      retained.push(index);
      continue;
    }
    const promptId = payload.promptIds[index];
    if (promptId !== null && typeof promptId !== 'string') {
      throw new MessageGroupDeletionError(
        'invalid_history',
        'Invalid compression identity',
      );
    }
    if (promptId) {
      if (
        seen.has(promptId) ||
        payload.compressedHistory[index]?.role !== 'user'
      ) {
        throw new MessageGroupDeletionError(
          'invalid_history',
          'Ambiguous compression identity',
        );
      }
      seen.add(promptId);
      removing = removedPromptIds.has(promptId);
    } else if (
      payload.compressedHistory[index]?.role === 'user' &&
      !payload.compressedHistory[index]?.parts?.some(
        (part) => part.functionResponse,
      )
    ) {
      if (removing || (affectsEarlierInput && hasUnidentifiedSelectedInput)) {
        throw new MessageGroupDeletionError(
          'invalid_history',
          'Cannot safely resolve injected input ownership in this compression checkpoint',
        );
      }
      // Unidentified injected input has no durable turn ownership.
      removing = false;
    }
    // Unidentified prefix entries hold summaries and injected restore context.
    if (!removing) retained.push(index);
  }
  assertNoRetainedToolCopies(retained);
  if (retained.length === payload.compressedHistory.length) return record;
  return {
    ...record,
    systemPayload: {
      ...payload,
      compressedHistory: retained.map(
        (index) => payload.compressedHistory[index]!,
      ),
      promptIds: retained.map((index) => payload.promptIds![index]!),
      ...(Array.isArray(payload.directoryContextIndices)
        ? {
            directoryContextIndices: retained.flatMap((index, newIndex) =>
              payload.directoryContextIndices!.includes(index)
                ? [newIndex]
                : [],
            ),
          }
        : {}),
    },
  };
}

export function deleteTranscriptMessageGroups(
  records: ChatRecord[],
  groupIds: string[],
  anchor: ChatRecord,
): { records: ChatRecord[]; result: DeleteMessageGroupsResult } {
  const groups = getTranscriptMessageGroups(records);
  const ids = new Set(groupIds);
  const selected = groups.filter((group) => ids.has(group.id));
  if (ids.size === 0 || selected.length !== ids.size) {
    throw new MessageGroupDeletionError(
      'invalid_groups',
      'Select existing message groups',
    );
  }
  const removed = new Set(selected.flatMap((group) => group.recordIds));
  const removedPromptIds = new Set(
    records
      .filter((record) => removed.has(record.uuid))
      .map((record) => record.promptId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const byId = new Map(
    records.toReversed().map((record) => [record.uuid, record]),
  );
  const displayCommandRecords = new Set(
    selected
      .filter((group) =>
        group.recordIds.some((id) => byId.get(id)?.subtype === 'slash_command'),
      )
      .flatMap((group) => group.recordIds),
  );
  const removedToolCalls = new Set(
    records
      .filter((record) => removed.has(record.uuid))
      .flatMap(
        (record) =>
          record.message?.parts?.flatMap((part) =>
            part.functionCall?.id ? [part.functionCall.id] : [],
          ) ?? [],
      ),
  );
  const survivingParent = (parent: string | null): string | null => {
    while (parent !== null && removed.has(parent)) {
      parent = byId.get(parent)!.parentUuid;
    }
    return parent;
  };
  const active = prepareTranscriptRecords(records).records;
  let compressionFollows = false;
  for (let index = active.length - 1; index >= 0; index--) {
    const record = active[index] as ChatRecord;
    if (record.subtype === 'chat_compression') compressionFollows = true;
    if (
      compressionFollows &&
      removed.has(record.uuid) &&
      record.type === 'user' &&
      record.subtype === undefined &&
      !record.promptId &&
      !displayCommandRecords.has(record.uuid)
    ) {
      throw new MessageGroupDeletionError(
        'invalid_history',
        'This legacy turn has no compression identity',
      );
    }
  }
  const fileHistory = new Map<string, SerializedFileHistorySnapshot>();
  for (const record of active) {
    if (record.type !== 'system' || record.subtype !== 'file_history_snapshot')
      continue;
    const payload = record.systemPayload as FileHistorySnapshotRecordPayload;
    if (!Array.isArray(payload?.snapshots)) {
      throw new MessageGroupDeletionError(
        'invalid_history',
        'Invalid file history snapshot',
      );
    }
    for (const snapshot of payload.snapshots)
      fileHistory.set(snapshot.promptId, snapshot);
  }
  const survivingSnapshots = new Map(
    removeFileHistorySnapshots([...fileHistory.values()], removedPromptIds).map(
      (snapshot) => [snapshot.promptId, snapshot],
    ),
  );
  const rewritten = records
    .filter((record) => !removed.has(record.uuid))
    .map((record) => {
      let parent = record.parentUuid;
      const earlierPromptIds = new Set<string>();
      if (record.subtype === 'chat_compression') {
        while (parent !== null) {
          const ancestor = byId.get(parent)!;
          if (
            removed.has(parent) &&
            ancestor.type === 'user' &&
            ancestor.subtype === undefined &&
            !displayCommandRecords.has(ancestor.uuid)
          ) {
            if (!ancestor.promptId) {
              throw new MessageGroupDeletionError(
                'invalid_history',
                'This legacy turn has no compression identity',
              );
            }
            earlierPromptIds.add(ancestor.promptId);
          }
          parent = ancestor.parentUuid;
        }
      }
      let rewritten = pruneCompression(
        record,
        removedPromptIds,
        earlierPromptIds,
        removedToolCalls,
      );
      if (record.subtype === 'file_history_snapshot') {
        const payload =
          record.systemPayload as FileHistorySnapshotRecordPayload;
        if (!Array.isArray(payload?.snapshots)) {
          throw new MessageGroupDeletionError(
            'invalid_history',
            'Invalid file history snapshot',
          );
        }
        rewritten = {
          ...rewritten,
          systemPayload: {
            ...payload,
            snapshots: payload.snapshots
              .filter((snapshot) => !removedPromptIds.has(snapshot.promptId))
              .map((snapshot) => {
                const endpoint = survivingSnapshots.get(
                  snapshot.promptId,
                )?.diffAfterBackups;
                return endpoint
                  ? { ...snapshot, diffAfterBackups: endpoint }
                  : snapshot;
              }),
          },
        };
      } else if (record.subtype === 'branch_checkpoint') {
        const payload = record.systemPayload as {
          v: 1;
          startExclusiveRecordUuid: string | null;
          assistantRecordUuid: string;
        };
        if (
          payload?.v !== 1 ||
          (payload.startExclusiveRecordUuid !== null &&
            typeof payload.startExclusiveRecordUuid !== 'string') ||
          typeof payload.assistantRecordUuid !== 'string'
        ) {
          throw new MessageGroupDeletionError(
            'invalid_history',
            'Invalid branch checkpoint',
          );
        }
        rewritten = {
          ...rewritten,
          systemPayload: {
            ...payload,
            startExclusiveRecordUuid: survivingParent(
              payload.startExclusiveRecordUuid,
            ),
          },
        };
      }
      return { ...rewritten, parentUuid: survivingParent(record.parentUuid) };
    });
  // Keep the active branch authoritative even when its last/all turns vanish.
  rewritten.push({
    ...anchor,
    parentUuid: survivingParent(active.at(-1)?.uuid ?? null),
  });
  return {
    records: rewritten,
    result: {
      deletedGroupIds: selected.map((group) => group.id),
      deletedPromptIds: [
        ...new Set(
          records
            .filter((record) => removed.has(record.uuid))
            .map((record) => record.daemonPromptId)
            .filter(
              (id): id is string => typeof id === 'string' && id.length > 0,
            ),
        ),
      ],
      removedApiPromptIds: [...removedPromptIds],
    },
  };
}
