/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The stop sidecar — `qwen-review-<target>-stop.json` under `REVIEW_TMP_DIR`,
// written by `capture-local` when a round is a decided stop — has one writer
// and two readers: `run.ts` fences the child's completion verdict on it, and
// `compose-review` fences the `stopReRule` floor exemption on it. The
// naming, the parse, and the reason contract all live HERE so the writer and
// both readers share one spelling of each; a drift between independent
// copies would fail silently — a renamed suffix would leave the fence
// scanning names that no longer exist, the exemption would die for every
// genuinely stamped sidecar, and every decided-stop round with an open
// Critical would cap back to exactly the hole #9908 closed (paths.ts
// records this codebase already paid the suffix-drift cost once, when a
// rename in one file silently stopped the other from sweeping).

import { readFileSync } from 'node:fs';

/**
 * The sidecar's filename suffix, in the writer's `tmpFile` spelling
 * (`tmpFile(target, STOP_SIDECAR_SUFFIX)` in capture-local). The family
 * regex and the exact-name helper both derive from this one constant, so
 * the writer and both readers cannot spell it differently.
 */
export const STOP_SIDECAR_SUFFIX = 'stop.json';

/**
 * The sidecar's filename family: `qwen-review-<stem>-stop.json`. The stem
 * is target-derived (and not injective), so readers that do not know the
 * target match the family and let the stamp decide.
 */
export const STOP_SIDECAR_NAME = new RegExp(
  `^qwen-review-.*-${STOP_SIDECAR_SUFFIX.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  )}$`,
);

/** The exact sidecar filename for a target stem. */
export function stopSidecarNameFor(stem: string): string {
  return `qwen-review-${stem}-${STOP_SIDECAR_SUFFIX}`;
}

/**
 * The writer's `reason` contract as the readers check it: a non-empty
 * string. Anything else carries no decision.
 */
export function isValidStopReason(reason: unknown): reason is string {
  return typeof reason === 'string' && reason !== '';
}

/**
 * The sidecar's fields as written, or null when the file does not read as a
 * JSON object. No shape judgement beyond that — `reason` validity is
 * `isValidStopReason`, the stamp check is each fence's; this is only the
 * shared parse.
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
