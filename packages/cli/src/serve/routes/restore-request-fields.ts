/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Body fields accepted by `POST /session/:id/load` and
 * `POST /session/:id/resume`. The restore handler parses exactly these
 * fields — resume skips the load-only ones — and the REST documentation
 * contract test verifies the public OpenAPI schemas against this list, so a
 * drift between the implementation and the published contract fails CI.
 */

/** Fields shared by both restore actions. */
export const RESTORE_SHARED_REQUEST_FIELDS = [
  'approvalMode',
  'cwd',
  'sourceId',
  'sourceType',
] as const;

/**
 * Load-only fields. Load replays history; resume restores the full journal,
 * so resume neither uses nor validates them.
 */
export const RESTORE_LOAD_ONLY_REQUEST_FIELDS = [
  'compactedReplayMode',
  'historyPageSize',
  'liveReplayMode',
] as const;

/** Accepted body fields of `POST /session/:id/load`, sorted. */
export const RESTORE_LOAD_REQUEST_FIELDS: readonly string[] = [
  ...RESTORE_SHARED_REQUEST_FIELDS,
  ...RESTORE_LOAD_ONLY_REQUEST_FIELDS,
].sort();

/** Accepted body fields of `POST /session/:id/resume`, sorted. */
export const RESTORE_RESUME_REQUEST_FIELDS: readonly string[] = [
  ...RESTORE_SHARED_REQUEST_FIELDS,
].sort();
