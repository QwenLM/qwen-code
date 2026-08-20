/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatRecord } from '../services/chatRecordingService.js';
import {
  isTranscriptConversationRecord,
  selectTranscriptLeaf,
  walkTranscriptUuidChain,
  type TranscriptRecordInput,
} from './transcript-records.js';

/**
 * A break in the persisted parentUuid chain: a record whose `parentUuid` is
 * non-null but points at a uuid that does not exist anywhere in the file.
 *
 * This happens when a middle segment of the session log is physically lost
 * (storage rollback, relocation, or a dropped write) while later turns keep
 * referencing the now-missing tail. Walking from the newest leaf stops at the
 * break, so everything before it is unreachable.
 *
 * The chain walk records the break here (with `detectGaps`) so the surface can
 * render a visible "history incomplete" marker instead of silently truncating.
 * It deliberately does NOT reconstruct the earlier records: read-side, a
 * missing parent is indistinguishable from a lost `/rewind` marker (where the
 * "earlier" turns are ones the user deliberately discarded), so stitching them
 * back could resurrect deleted content. Safe recovery requires durable
 * write-side metadata and is tracked separately.
 */
export interface HistoryGap {
  /** The record whose parent was missing (the UI anchors the marker here). */
  childUuid: string;
  /** The parentUuid value that could not be found in the file. */
  missingParentUuid: string;
}

export interface OrderedChainResult {
  /** Uuids in root→leaf order (the reachable tail island only). */
  uuids: string[];
  /** Detected chain breaks. Empty for healthy sessions. */
  gaps: HistoryGap[];
}

export interface BuildOrderedChainOptions {
  /** Start the walk from this uuid instead of the last physical record. */
  leafUuid?: string;
  /**
   * When true, a walk that stops on a physically-missing parent records a
   * {@link HistoryGap} so the surface can surface a marker. It does NOT stitch
   * an earlier island back on — see the HistoryGap docstring for why that is
   * unsafe read-side. Off by default so callers that want the raw active branch
   * (e.g. fork) keep today's behavior exactly.
   */
  detectGaps?: boolean;
}

/**
 * Linearizes tree-structured session records into an ordered uuid chain by
 * walking `parentUuid` back from the newest leaf to a null root.
 *
 * On a genuinely missing parent the walk stops (as it always has). With
 * `detectGaps` it additionally records the break so the caller can mark it;
 * it never guesses an earlier island to reconnect.
 */
export function buildOrderedUuidChain(
  records: ChatRecord[],
  opts?: BuildOrderedChainOptions,
): OrderedChainResult {
  if (records.length === 0) return { uuids: [], gaps: [] };

  const detectGaps = opts?.detectGaps ?? false;

  const transcriptRecords: TranscriptRecordInput[] = records;
  const firstByUuid = new Map<string, TranscriptRecordInput>();
  for (const r of records) {
    if (isTranscriptConversationRecord(r) && !firstByUuid.has(r.uuid)) {
      firstByUuid.set(r.uuid, r);
    }
  }
  const startUuid = selectTranscriptLeaf(transcriptRecords, opts?.leafUuid);
  if (!startUuid) return { uuids: [], gaps: [] };
  const chain = walkTranscriptUuidChain(startUuid, (uuid) =>
    firstByUuid.get(uuid),
  );
  return {
    uuids: [...chain.uuids],
    gaps: detectGaps ? [...chain.gaps] : [],
  };
}
