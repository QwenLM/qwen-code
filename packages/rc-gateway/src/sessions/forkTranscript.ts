/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One parsed JSONL transcript record. We deliberately operate on opaque parsed
 * JSON objects (not core's full `ChatRecord` type) — the transform only reads
 * `uuid` and rewrites three well-known fields; every other field is copied
 * verbatim, so we never need to know its shape.
 */
export type ForkRecord = Record<string, unknown>;

/**
 * Replicates core `SessionService.forkSession`'s in-memory map EXACTLY:
 *
 * - `sessionId` → `newId` on every record.
 * - `parentUuid` → rebuilt as a linear chain in write order (`prevUuid`,
 *   starting `null`), so the fork is a clean linear descendant.
 * - `forkedFrom` → `{ sessionId: sourceId, messageUuid: <record.uuid> }` on
 *   every copied record (per-message lineage / audit).
 *
 * Everything else (notably `cwd`, which `loadSession` re-checks for project
 * ownership, and the message content) is copied verbatim. The input array and
 * its records are never mutated.
 */
export function forkRecords(
  records: readonly ForkRecord[],
  sourceId: string,
  newId: string,
): ForkRecord[] {
  let prevUuid: string | null = null;
  return records.map((record) => {
    const uuid = typeof record['uuid'] === 'string' ? record['uuid'] : null;
    const next: ForkRecord = {
      ...record,
      sessionId: newId,
      parentUuid: prevUuid,
      forkedFrom: {
        sessionId: sourceId,
        messageUuid: uuid,
      },
    };
    prevUuid = uuid;
    return next;
  });
}

/**
 * Builds a core-faithful `custom_title` system record to append to a freshly
 * forked transcript, so a NAMED fork shows its title everywhere core does (the
 * picker, on resume, and the gateway's `/rc/sessions` tail reader).
 *
 * Mirrors core `SessionService.renameSession`'s record shape EXACTLY (see
 * `packages/core/src/services/sessionService.ts:847-857`):
 *
 * - `parentUuid` → the LAST forked record's uuid, so `reconstructHistory`
 *   chains the title onto the tail (a `null` here would sever the chain and the
 *   fork would load empty). This matches core's `readLastRecordUuid`, including
 *   the faithful title→title chaining when the parent was itself renamed.
 * - `cwd` / `version` → copied from the FIRST forked record (the exact fields
 *   core copies; an absent `version` is dropped by `JSON.stringify`).
 * - `sessionId` → taken from the forked records (already the new id).
 * - NO `forkedFrom`: the record is synthesized at fork time, not copied from a
 *   source message, so it carries no per-message lineage stamp (as in core).
 *
 * Pure: never mutates the input. The caller supplies `uuid`/`timestamp` (a
 * fresh `randomUUID()` + ISO stamp) so the builder stays deterministic.
 */
export function buildForkTitleRecord(
  forkedRecords: readonly ForkRecord[],
  title: string,
  opts: { uuid: string; timestamp: string },
): ForkRecord {
  const first = forkedRecords[0] ?? {};
  const last = forkedRecords[forkedRecords.length - 1];
  const lastUuid =
    last && typeof last['uuid'] === 'string' ? (last['uuid'] as string) : null;
  return {
    uuid: opts.uuid,
    parentUuid: lastUuid,
    sessionId: first['sessionId'],
    timestamp: opts.timestamp,
    type: 'system',
    subtype: 'custom_title',
    cwd: first['cwd'],
    version: first['version'],
    systemPayload: { customTitle: title, titleSource: 'manual' },
  };
}

/**
 * Serializes forked records to the exact byte shape core's `forkSession`
 * writes: one `JSON.stringify` per record joined by `\n`, plus a trailing `\n`.
 */
export function serializeForked(records: readonly ForkRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/**
 * Builds the JSONL fork header record that is prepended as the very first line
 * of a forked transcript. This gives every fork a machine-readable lineage
 * breadcrumb that does not interfere with core's `reconstructHistory` (it only
 * reads records with known `type` values; an unknown `type: 'fork'` is skipped
 * by the history builder).
 *
 * Fields:
 *  - `type`: always `'fork'` (distinguishable from user/assistant/system).
 *  - `parentSessionId`: the source session's id.
 *  - `parentEventId`: the WAL event id at which the fork was taken, if known.
 *    Absent (omitted, not null) when the fork is a full-copy with no event
 *    anchor.
 *  - `transcriptMode`: which records were copied (`'include'` = all, `'empty'`
 *    = none, `'summary'` = future).
 *  - `forkedAt`: ISO-8601 timestamp of fork creation.
 */
export function buildForkHeader(opts: {
  parentSessionId: string;
  parentEventId?: number;
  transcriptMode: 'include' | 'summary' | 'empty';
  forkedAt: string;
}): ForkRecord {
  const header: ForkRecord = {
    type: 'fork',
    parentSessionId: opts.parentSessionId,
    transcriptMode: opts.transcriptMode,
    forkedAt: opts.forkedAt,
  };
  if (opts.parentEventId !== undefined) {
    header['parentEventId'] = opts.parentEventId;
  }
  return header;
}
