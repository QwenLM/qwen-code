/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type TranscriptRecordType =
  | 'user'
  | 'assistant'
  | 'tool_result'
  | 'system';

export interface TranscriptProjectionDiagnostic {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly affectsCompleteness: boolean;
  readonly recordIndex?: number;
  readonly recordId?: string;
  readonly path?: string;
}

export interface TranscriptRecordInput {
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly sessionId: string;
  readonly timestamp?: string;
  readonly type: TranscriptRecordType;
  readonly subtype?: string;
  readonly message?: {
    readonly role?: string;
    readonly parts?: readonly unknown[];
  };
  readonly model?: unknown;
  readonly usageMetadata?: unknown;
  readonly toolCallResult?: unknown;
  readonly systemPayload?: unknown;
}

export interface TranscriptReplayGapInput {
  readonly childUuid: string;
  readonly missingParentUuid: string;
}

export interface PreparedTranscriptRecords {
  readonly sessionId?: string;
  readonly records: readonly TranscriptRecordInput[];
  readonly gaps: readonly TranscriptReplayGapInput[];
  readonly diagnostics: readonly TranscriptProjectionDiagnostic[];
}

export type TranscriptRecordPreparationErrorCode =
  | 'invalid_records'
  | 'leaf_not_found'
  | 'mixed_session_ids';

export class TranscriptRecordPreparationError extends TypeError {
  constructor(
    readonly code: TranscriptRecordPreparationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptRecordPreparationError';
  }
}

export interface PrepareTranscriptRecordsOptions {
  readonly leafUuid?: string;
}

export interface TranscriptUuidChainResult {
  readonly uuids: readonly string[];
  readonly gaps: readonly TranscriptReplayGapInput[];
  readonly cycleUuid?: string;
}

const RECORD_TYPES = new Set<TranscriptRecordType>([
  'user',
  'assistant',
  'tool_result',
  'system',
]);

const ARTIFACT_RECORD_SUBTYPES = new Set([
  'session_artifact_event',
  'session_artifact_snapshot',
]);

const KNOWN_RECORD_SUBTYPES = new Set([
  'chat_compression',
  'slash_command',
  'ui_telemetry',
  'at_command',
  'attribution_snapshot',
  'notification',
  'cron',
  'mid_turn_user_message',
  'custom_title',
  'parent_session',
  'rewind',
  'agent_bootstrap',
  'agent_launch_prompt',
  'file_history_snapshot',
  ...ARTIFACT_RECORD_SUBTYPES,
]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnostic(
  code: string,
  message: string,
  affectsCompleteness: boolean,
  fields: Pick<
    TranscriptProjectionDiagnostic,
    'recordIndex' | 'recordId' | 'path'
  > = {},
  severity: TranscriptProjectionDiagnostic['severity'] = affectsCompleteness
    ? 'warning'
    : 'info',
): TranscriptProjectionDiagnostic {
  return {
    code,
    severity,
    message,
    affectsCompleteness,
    ...fields,
  };
}

export function isTranscriptConversationRecord(
  record: Pick<TranscriptRecordInput, 'type' | 'subtype'>,
): boolean {
  return !isTranscriptArtifactRecord(record);
}

export function isTranscriptArtifactRecord(record: {
  readonly type?: unknown;
  readonly subtype?: unknown;
}): boolean {
  return (
    record.type === 'system' &&
    typeof record.subtype === 'string' &&
    ARTIFACT_RECORD_SUBTYPES.has(record.subtype)
  );
}

export function validateTranscriptRecord(
  value: unknown,
  recordIndex?: number,
): {
  readonly record?: TranscriptRecordInput;
  readonly diagnostics: readonly TranscriptProjectionDiagnostic[];
} {
  const diagnostics: TranscriptProjectionDiagnostic[] = [];
  if (!isObjectRecord(value)) {
    diagnostics.push(
      diagnostic(
        'invalid_record',
        'Skipped a transcript record that is not an object.',
        true,
        { recordIndex },
      ),
    );
    return { diagnostics };
  }

  const uuid = value['uuid'];
  const parentUuid = value['parentUuid'];
  const sessionId = value['sessionId'];
  const type = value['type'];
  const recordId = typeof uuid === 'string' ? uuid : undefined;
  if (
    typeof uuid !== 'string' ||
    uuid.length === 0 ||
    (typeof parentUuid !== 'string' && parentUuid !== null) ||
    typeof sessionId !== 'string' ||
    sessionId.length === 0
  ) {
    diagnostics.push(
      diagnostic(
        'invalid_record',
        'Skipped a transcript record with invalid identity fields.',
        true,
        { recordIndex, recordId },
      ),
    );
    return { diagnostics };
  }
  if (
    typeof type !== 'string' ||
    !RECORD_TYPES.has(type as TranscriptRecordType)
  ) {
    diagnostics.push(
      diagnostic(
        'unknown_record_or_part',
        'Skipped a transcript record with an unknown record type.',
        true,
        { recordIndex, recordId },
      ),
    );
    return { diagnostics };
  }

  const timestamp = value['timestamp'];
  if (
    timestamp !== undefined &&
    (typeof timestamp !== 'string' ||
      !Number.isFinite(new Date(timestamp).getTime()))
  ) {
    diagnostics.push(
      diagnostic(
        'invalid_timestamp',
        'Ignored an invalid transcript record timestamp.',
        false,
        { recordIndex, recordId, path: 'timestamp' },
      ),
    );
  }

  const subtype = value['subtype'];
  if (
    subtype !== undefined &&
    (typeof subtype !== 'string' || !KNOWN_RECORD_SUBTYPES.has(subtype))
  ) {
    diagnostics.push(
      diagnostic(
        'unknown_record_or_part',
        'The transcript record has an unknown subtype.',
        true,
        { recordIndex, recordId, path: 'subtype' },
      ),
    );
  }

  let message: TranscriptRecordInput['message'];
  if (value['message'] !== undefined) {
    if (!isObjectRecord(value['message'])) {
      diagnostics.push(
        diagnostic(
          'malformed_part',
          'Ignored a malformed transcript message payload.',
          true,
          { recordIndex, recordId, path: 'message' },
        ),
      );
    } else {
      const parts = value['message']['parts'];
      if (parts !== undefined && !Array.isArray(parts)) {
        diagnostics.push(
          diagnostic(
            'malformed_part',
            'Ignored malformed transcript message parts.',
            true,
            { recordIndex, recordId, path: 'message.parts' },
          ),
        );
      }
      message = {
        ...(typeof value['message']['role'] === 'string'
          ? { role: value['message']['role'] }
          : {}),
        ...(Array.isArray(parts) ? { parts } : {}),
      };
    }
  }

  return {
    record: {
      ...value,
      uuid,
      parentUuid,
      sessionId,
      type: type as TranscriptRecordType,
      ...(typeof subtype === 'string' ? { subtype } : { subtype: undefined }),
      ...(typeof timestamp === 'string' &&
      Number.isFinite(new Date(timestamp).getTime())
        ? { timestamp }
        : { timestamp: undefined }),
      ...(message ? { message } : { message: undefined }),
    },
    diagnostics,
  };
}

export function selectTranscriptLeaf(
  records: readonly TranscriptRecordInput[],
  leafUuid?: string,
): string | undefined {
  if (leafUuid !== undefined) {
    return records.some(
      (record) =>
        record.uuid === leafUuid && isTranscriptConversationRecord(record),
    )
      ? leafUuid
      : undefined;
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record && isTranscriptConversationRecord(record)) return record.uuid;
  }
  return undefined;
}

export function walkTranscriptUuidChain(
  leafUuid: string,
  lookup: (uuid: string) => TranscriptRecordInput | undefined,
): TranscriptUuidChainResult {
  const uuids: string[] = [];
  const gaps: TranscriptReplayGapInput[] = [];
  const visited = new Set<string>();
  let currentUuid: string | null = leafUuid;
  let cycleUuid: string | undefined;

  while (currentUuid) {
    if (visited.has(currentUuid)) {
      cycleUuid = currentUuid;
      break;
    }
    visited.add(currentUuid);
    const record = lookup(currentUuid);
    if (!record) break;
    uuids.push(currentUuid);
    if (!record.parentUuid) break;
    if (!lookup(record.parentUuid)) {
      gaps.push({
        childUuid: currentUuid,
        missingParentUuid: record.parentUuid,
      });
      break;
    }
    currentUuid = record.parentUuid;
  }

  uuids.reverse();
  return { uuids, gaps, ...(cycleUuid ? { cycleUuid } : {}) };
}

export function aggregateTranscriptRecordFragments<
  T extends TranscriptRecordInput,
>(records: readonly T[]): T {
  const first = records[0];
  if (!first) {
    throw new Error('Cannot aggregate empty transcript record array');
  }
  const base = { ...first } as Record<string, unknown>;
  let message = first.message
    ? { ...first.message, parts: [...(first.message.parts ?? [])] }
    : undefined;

  for (let index = 1; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.message !== undefined) {
      message = message
        ? {
            role: message.role,
            parts: [...(message.parts ?? []), ...(record.message.parts ?? [])],
          }
        : { ...record.message, parts: [...(record.message.parts ?? [])] };
    }
    if (record.usageMetadata) base['usageMetadata'] = record.usageMetadata;
    if (record.toolCallResult && !base['toolCallResult']) {
      base['toolCallResult'] = record.toolCallResult;
    }
    if (record.model && !base['model']) base['model'] = record.model;
    if (
      record.timestamp &&
      (!base['timestamp'] || record.timestamp > String(base['timestamp']))
    ) {
      base['timestamp'] = record.timestamp;
    }
  }
  base['message'] = message;
  return base as T;
}

export function prepareTranscriptRecords(
  values: readonly unknown[],
  options: PrepareTranscriptRecordsOptions = {},
): PreparedTranscriptRecords {
  if (!Array.isArray(values)) {
    throw new TranscriptRecordPreparationError(
      'invalid_records',
      'Transcript records must be an array.',
    );
  }

  const diagnostics: TranscriptProjectionDiagnostic[] = [];
  const records: TranscriptRecordInput[] = [];
  const sourceIndexByRecord = new Map<TranscriptRecordInput, number>();
  for (let index = 0; index < values.length; index += 1) {
    const validated = validateTranscriptRecord(values[index], index);
    diagnostics.push(...validated.diagnostics);
    if (validated.record) {
      records.push(validated.record);
      sourceIndexByRecord.set(validated.record, index);
    }
  }

  const sessionIds = new Set(records.map((record) => record.sessionId));
  if (sessionIds.size > 1) {
    throw new TranscriptRecordPreparationError(
      'mixed_session_ids',
      'Transcript records contain multiple session ids.',
    );
  }

  const leafUuid = selectTranscriptLeaf(records, options.leafUuid);
  if (options.leafUuid !== undefined && leafUuid === undefined) {
    throw new TranscriptRecordPreparationError(
      'leaf_not_found',
      'The requested transcript leaf was not found.',
    );
  }
  if (!leafUuid) {
    if (records.length > 0) {
      diagnostics.push(
        diagnostic(
          'artifact_only',
          'The input contains no conversation records.',
          false,
        ),
      );
    }
    return {
      ...(sessionIds.size === 1 ? { sessionId: records[0]!.sessionId } : {}),
      records: [],
      gaps: [],
      diagnostics,
    };
  }

  const fragmentsByUuid = new Map<string, TranscriptRecordInput[]>();
  const firstByUuid = new Map<string, TranscriptRecordInput>();
  for (const record of records) {
    if (!isTranscriptConversationRecord(record)) continue;
    const fragments = fragmentsByUuid.get(record.uuid);
    if (fragments) {
      if (fragments[0]!.parentUuid !== record.parentUuid) {
        diagnostics.push(
          diagnostic(
            'conflicting_parent_uuid',
            'Duplicate transcript record fragments disagree on parentUuid.',
            true,
            {
              recordIndex: sourceIndexByRecord.get(record),
              recordId: record.uuid,
              path: 'parentUuid',
            },
          ),
        );
      }
      fragments.push(record);
    } else {
      fragmentsByUuid.set(record.uuid, [record]);
      firstByUuid.set(record.uuid, record);
    }
  }

  const chain = walkTranscriptUuidChain(leafUuid, (uuid) =>
    firstByUuid.get(uuid),
  );
  for (const gap of chain.gaps) {
    diagnostics.push(
      diagnostic(
        'history_gap',
        'The active transcript chain is missing a parent record.',
        true,
        { recordId: gap.childUuid },
      ),
    );
  }
  if (chain.cycleUuid) {
    diagnostics.push(
      diagnostic(
        'parent_cycle',
        'The active transcript chain contains a parent cycle.',
        true,
        { recordId: chain.cycleUuid },
      ),
    );
  }

  return {
    ...(sessionIds.size === 1 ? { sessionId: records[0]!.sessionId } : {}),
    records: chain.uuids.map((uuid) =>
      aggregateTranscriptRecordFragments(fragmentsByUuid.get(uuid) ?? []),
    ),
    gaps: chain.gaps,
    diagnostics,
  };
}
