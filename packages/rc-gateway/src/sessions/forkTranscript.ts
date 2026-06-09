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
 * Serializes forked records to the exact byte shape core's `forkSession`
 * writes: one `JSON.stringify` per record joined by `\n`, plus a trailing `\n`.
 */
export function serializeForked(records: readonly ForkRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
