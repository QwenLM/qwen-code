/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import type { DaemonSessionActions } from '@qwen-code/web-shell/daemon-react-sdk';
import { parseContextCompressionMeta } from '../utils/contextCompression';

/**
 * Refreshes the composer's context counters after a compression the client did
 * not initiate.
 *
 * `useContextUsageControls` reconciles the counters for its own button, but the
 * command can just as well be typed into the composer, and the daemon emits no
 * usage frame for a compression — so the transcript outcome is the only signal
 * both entry points share.
 *
 * A read is only ever issued on a live session: `syncCounters` refuses the
 * write while the session is catching up (`session/actions.ts`) and never
 * retries, so one issued during the replay would be discarded. The first live
 * render therefore reconciles an attach the replay's own counters misdescribe
 * — they are the last usage-bearing frame in the replay, and a compression
 * emits none — and after that a compression arriving live reconciles the same
 * way.
 *
 * A panel-initiated compression therefore reads usage twice — once for its own
 * controls, once here. That repetition is the price of not coupling the two
 * paths, and the extra read is silent and idempotent.
 */
export function useContextCompressionReconcile({
  blocks,
  sessionId,
  live,
  currentModel,
  contextWindow,
  getContextUsage,
}: {
  blocks: readonly DaemonTranscriptBlock[];
  sessionId: string | undefined;
  /** False while the transcript is replaying, or the session is not connected. */
  live: boolean;
  /** Model the counters are measured against; undefined until it resolves. */
  currentModel: string | undefined;
  contextWindow: number | undefined;
  getContextUsage: DaemonSessionActions['getContextUsage'];
}): void {
  // The check below is keyed on everything `syncCounters` insists on holding
  // still: it refuses the write when the connection moved while the read was in
  // flight (`session/actions.ts`) and never retries. An attach resolves its
  // model and context window after it is already live, so a compression read
  // that raced that resolution is read again here rather than spent on one that
  // could not land.
  const key = `${sessionId ?? ''}|${currentModel ?? ''}|${contextWindow ?? ''}`;
  const state = useRef<{
    key?: string;
    /** True once the attach-time check has run for this key. */
    settled?: boolean;
    /** Newest compression accounted for, so it is not read for twice. */
    reconciled?: string;
  }>({});
  useEffect(() => {
    const reconcile = () =>
      void getContextUsage({
        detail: true,
        silent: true,
        syncCounters: true,
      }).catch(() => undefined);
    if (state.current.key !== key || !live) {
      state.current = { key };
    }
    const current = state.current;
    if (!live) return;
    const newest = findNewestCompression(blocks);
    if (!current.settled) {
      current.settled = true;
      current.reconciled = newest?.id;
      if (newest && seededCountersPredateCompression(blocks, newest.index)) {
        reconcile();
      }
      return;
    }
    if (newest?.id === current.reconciled) return;
    current.reconciled = newest?.id;
    if (!newest) return;
    reconcile();
  }, [blocks, key, live, getContextUsage]);
}

function findNewestCompression(
  blocks: readonly DaemonTranscriptBlock[],
): { id: string; index: number } | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind !== 'assistant') continue;
    const meta = parseContextCompressionMeta(
      block.meta?.['contextCompression'],
    );
    if (meta?.phase === 'done') return { id: block.id, index };
  }
  return undefined;
}

/**
 * Whether the counters a session seeded from its replay still describe the
 * context a compression replaced. They come from the last usage-bearing frame
 * in the replay (`getReplayTokenUsage`), which a compression never emits — so
 * only a usage-bearing block *after* the compression's can have caught the seed
 * up. Usage folded onto the compression's own block does not: it arrives on the
 * round that ran before the command did, so it still describes the pre-outcome
 * context. That scan skips sub-agent usage, and so does this one.
 */
function seededCountersPredateCompression(
  blocks: readonly DaemonTranscriptBlock[],
  compressionIndex: number,
): boolean {
  for (let index = compressionIndex + 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (
      block?.kind === 'assistant' &&
      block.usage !== undefined &&
      block.parentToolCallId === undefined
    ) {
      return false;
    }
  }
  return true;
}
