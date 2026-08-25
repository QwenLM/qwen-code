/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The stop sidecar — `qwen-review-<target>-stop.json` under `REVIEW_TMP_DIR`,
// written by `capture-local` when a round is a decided stop — has one writer
// and two readers: `run.ts` fences the child's completion verdict on it, and
// `compose-review` fences the `stopReRule` floor exemption on it. Both parse
// through this module so the writer's contract (field names, stamp equality)
// has exactly one reader-side spelling; a drift between two independent
// copies would fail silently — the exemption would die for every genuinely
// stamped sidecar, and every decided-stop round with an open Critical would
// cap back to exactly the hole #9908 closed.

import { readFileSync } from 'node:fs';

/**
 * The sidecar's fields as written, or null when the file does not read as a
 * JSON object. No shape judgement beyond that — `reason` validity is the
 * verdict reader's (`run.ts`), the stamp check is each fence's; this is only
 * the shared parse.
 */
export function readStopSidecarFields(path: string): {
  reason?: unknown;
  runId?: unknown;
} | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as { reason?: unknown; runId?: unknown };
  } catch {
    return null;
  }
}
