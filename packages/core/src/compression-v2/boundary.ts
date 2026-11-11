/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type {
  CompactMetadata,
  Message,
  SystemMessage,
} from '../protocol/transcript/message.js';
import type { CompressionBoundary } from './types.js';

/**
 * Constructs the in-memory `system/compact_boundary` marker that the
 * compression-v2 pipeline prepends to every successful compaction's
 * `newHistory`. The marker is what `findCompressionBoundary` scans for on
 * subsequent compressions — boundary state is reconstructed from the
 * transcript itself, with no sidecar lookup required.
 *
 * The transcript writer chains this marker to the last pre-compact entry
 * via its normal `parent` arg, so callers do not need to pre-compute
 * parent UUIDs here.
 */
export function createCompactBoundaryMessage(
  metadata: CompactMetadata,
): SystemMessage {
  return {
    type: 'system',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    // Marks the boundary as the chain-break point in the transcript writer:
    // `parentUuid` flips to null and `logicalParentUuid` points at the last
    // pre-compact entry, so resume-time reconstruction can choose whether
    // to walk into the pre-compact prefix or stop at the boundary.
    isCompactSummary: true,
    compactMetadata: metadata,
  };
}

/**
 * Locates the latest in-memory compression boundary by scanning the
 * unfiltered runtime history for the most recent
 * `system/compact_boundary` marker.
 *
 * The marker itself stays in `prefixContents`; `contents` is the slice
 * starting immediately after it, filtered to model-visible conversation
 * messages that participate in compression. Runtime attachment messages are
 * preserved because normalizeMessagesForAPI() expands them into the actual
 * prompt blocks sent to the model. Dropping them here makes compact forks
 * diverge from the parent request prefix and prevents prompt-cache reuse.
 */
export function findCompressionBoundary(
  history: readonly Message[],
): CompressionBoundary {
  for (let i = history.length - 1; i >= 0; i--) {
    const candidate = history[i];
    if (
      candidate?.type === 'system' &&
      candidate.subtype === 'compact_boundary'
    ) {
      const startIndex = i + 1;
      return {
        startIndex,
        prefixContents: history.slice(0, startIndex),
        contents: filterCompressible(history.slice(startIndex)),
        source: 'compact_boundary',
      };
    }
  }

  return {
    startIndex: 0,
    prefixContents: [],
    contents: filterCompressible(history),
    source: 'initial_history',
  };
}

function filterCompressible(slice: readonly Message[]): Message[] {
  return slice.filter(
    (msg): msg is Message =>
      msg.type === 'user' ||
      msg.type === 'assistant' ||
      msg.type === 'attachment',
  );
}
