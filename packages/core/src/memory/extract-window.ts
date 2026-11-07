/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Internal experiment for #15493: the extractor reads the parent's CURATED
 * history from a start index pinned once per extraction epoch instead of the
 * sliding last-40 tail, so consecutive runs share a byte-identical request
 * prefix and the provider's implicit prefix cache can be reused. Off unless
 * set; not a user setting until paired runs show no missed or late memories.
 *
 * The window is deliberately unbounded: #15493 keeps growth bounding as the
 * session-compaction policy's decision, so this module never re-slices to a
 * newer "last N" to fit a budget. It only rebases when the pinned start can no
 * longer describe the live curated history.
 *
 * Like extract-cadence.ts, the flag name is defined here so the experiment
 * cannot drift between its readers.
 */

import { createHash } from 'node:crypto';
import type { Content } from '@google/genai';
import type { AutoMemoryExtractCursor } from './types.js';
import { EXTRACT_TAIL_ENTRIES } from './extract-cadence.js';

export const EXTRACT_STABLE_WINDOW_ENV =
  'QWEN_CODE_MEMORY_EXTRACT_STABLE_WINDOW';

const TRUTHY_VALUES = new Set(['1', 'true', 'on', 'yes']);

export function isStableExtractionWindowEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[EXTRACT_STABLE_WINDOW_ENV]?.trim().toLowerCase();
  return raw !== undefined && TRUTHY_VALUES.has(raw);
}

/** Why a run started a new window epoch instead of reusing its start index. */
export type ExtractWindowRebaseReason =
  | 'new_session'
  | 'new_epoch'
  | 'epoch_id_changed'
  | 'history_shrank'
  | 'head_changed';

export interface ResolvedExtractWindow {
  /** New value for the cursor's `epoch`. */
  epoch: number;
  /** CURATED-history index the extractor input starts at. */
  windowStartCurated: number;
  /**
   * CURATED-history index up to which a completed extraction has covered.
   * Only advanced after a successful run with genuine progress.
   */
  coveredCurated: number;
  /** Identity of the window start, stored to detect an in-place rewrite. */
  windowHeadHash: string;
  /** Set when this run started a new epoch. */
  rebaseReason?: ExtractWindowRebaseReason;
}

/**
 * Cheap, stable identity of one CURATED history entry.
 *
 * Deliberately bounded: text is sampled by length and edges, and media
 * payloads by their size, so hashing the head entry on every run cannot cost
 * proportional to an inline image. This detects the rewrites the window
 * cares about — a compaction replacing history, a session restore truncating
 * it — without claiming to be a cryptographic digest of the payload.
 */
export function hashCuratedEntry(entry: Content | undefined): string {
  if (!entry) return '';
  const parts = (entry.parts ?? []).map((part) => {
    if (typeof part.text === 'string') {
      return `t:${part.text.length}:${part.text.slice(0, 96)}:${part.text.slice(-32)}`;
    }
    if (part.functionCall) {
      return `c:${part.functionCall.name ?? ''}:${JSON.stringify(part.functionCall.args ?? null).length}`;
    }
    if (part.functionResponse) {
      return `r:${part.functionResponse.name ?? ''}:${part.functionResponse.id ?? ''}`;
    }
    if (part.inlineData) {
      return `i:${part.inlineData.mimeType ?? ''}:${part.inlineData.data?.length ?? 0}`;
    }
    if (part.fileData) {
      return `f:${part.fileData.mimeType ?? ''}:${part.fileData.fileUri ?? ''}`;
    }
    return 'x';
  });
  return createHash('sha256')
    .update(`${entry.role ?? ''}|${parts.join('|')}`)
    .digest('hex')
    .slice(0, 16);
}

export interface ResolveExtractWindowParams {
  /** Parent CURATED history snapshot, materialized at extraction time. */
  curatedHistory: Content[];
  sessionId: string;
  /** Window state persisted by the previous run. */
  previous: AutoMemoryExtractCursor;
  /**
   * Identity of the current window owner: a process token plus a generation
   * bumped on every boundary that rewrites the curated history in place. When
   * omitted (direct test calls) only the content checks apply.
   */
  epochId?: string;
}

/**
 * Decide where this run's extractor input starts.
 *
 * Reuse keeps the previous `windowStartCurated` untouched so the request bytes
 * before the task prompt stay a prefix of the previous run's. Rebases only
 * cover structural invalidation — a session change, a new process or
 * history-rewriting boundary, a shrunken history, or a rewritten start entry —
 * never a size limit. Every rebase seeds the new window no later than the
 * previously covered curated index, so turns no completed run has extracted
 * are never dropped by the fresh start; `EXTRACT_TAIL_ENTRIES` is the fallback
 * when nothing was covered yet.
 */
export function resolveExtractWindow(
  params: ResolveExtractWindowParams,
): ResolvedExtractWindow {
  const { curatedHistory, sessionId, previous, epochId } = params;
  const length = curatedHistory.length;
  const tailStart = Math.max(0, length - EXTRACT_TAIL_ENTRIES);
  const sameSession = previous.sessionId === sessionId;
  const previousCovered = sameSession ? previous.coveredCurated : undefined;
  const seed =
    previousCovered !== undefined
      ? Math.min(previousCovered, tailStart)
      : tailStart;

  const start = previous.windowStartCurated;
  let rebaseReason: ExtractWindowRebaseReason | undefined;
  if (!sameSession) {
    rebaseReason = 'new_session';
  } else if (
    start === undefined ||
    previous.epoch === undefined ||
    previousCovered === undefined ||
    previous.windowHeadHash === undefined
  ) {
    rebaseReason = 'new_epoch';
  } else if (epochId !== undefined && previous.windowEpochId !== epochId) {
    rebaseReason = 'epoch_id_changed';
  } else if (start < 0 || start >= length) {
    rebaseReason = 'history_shrank';
  } else if (
    hashCuratedEntry(curatedHistory[start]) !== previous.windowHeadHash
  ) {
    rebaseReason = 'head_changed';
  }

  let epoch = previous.epoch ?? 0;
  let windowStartCurated: number;
  let coveredCurated: number;
  if (
    rebaseReason === undefined &&
    start !== undefined &&
    previousCovered !== undefined
  ) {
    windowStartCurated = start;
    coveredCurated = previousCovered;
  } else {
    epoch += 1;
    windowStartCurated = seed;
    // Nothing inside the new window has been covered by a completed run yet;
    // the seed itself records what the fresh start skips.
    coveredCurated = seed;
  }

  return {
    epoch,
    windowStartCurated,
    coveredCurated,
    windowHeadHash: hashCuratedEntry(curatedHistory[windowStartCurated]),
    ...(rebaseReason !== undefined && { rebaseReason }),
  };
}
