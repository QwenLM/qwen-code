/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranscriptMessage } from '../../protocol/transcript/entry.js';
import type { Message } from '../../protocol/transcript/message.js';
import { projectTranscriptMessages } from './resume-projector.js';
import { isChainParticipant } from './session-writer.js';

export type HistoricalLineageSelectionMode =
  | 'through-target'
  | 'before-target';

export interface HistoricalLineageSelection {
  readonly target: TranscriptMessage;
  readonly retainedChain: readonly TranscriptMessage[];
  readonly discardedChain: readonly TranscriptMessage[];
  readonly runtimeMessages: readonly Message[];
  readonly retainedLeafUuid: string | null;
}

/**
 * Selects an operation boundary on an already resolved historical lineage.
 *
 * Fork and resume retain the target, while Rewind excludes it. Runtime state
 * is always projected from the selected raw chain, so pre-boundary targets use
 * their original ancestry and post-boundary targets retain the Compact Summary.
 */
export function selectHistoricalLineage(
  lineage: readonly TranscriptMessage[],
  targetUuid: string,
  mode: HistoricalLineageSelectionMode,
): HistoricalLineageSelection | undefined {
  const targetIndex = lineage.findLastIndex(
    (message) => message.uuid === targetUuid,
  );
  if (targetIndex < 0) {
    return undefined;
  }

  const retainedEnd =
    mode === 'through-target' ? targetIndex + 1 : targetIndex;
  const retainedChain = lineage.slice(0, retainedEnd);
  return {
    target: lineage[targetIndex],
    retainedChain,
    discardedChain: lineage.slice(retainedEnd),
    runtimeMessages: projectTranscriptMessages(retainedChain, 'runtime'),
    retainedLeafUuid: findRetainedLeafUuid(retainedChain),
  };
}

function findRetainedLeafUuid(
  chain: readonly TranscriptMessage[],
): string | null {
  for (let index = chain.length - 1; index >= 0; index--) {
    const message = chain[index];
    if (message && isChainParticipant(message)) {
      return message.uuid;
    }
  }
  return null;
}
