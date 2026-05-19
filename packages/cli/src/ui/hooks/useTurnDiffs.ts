/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import type { FileHistoryService, TurnDiff } from '@qwen-code/qwen-code-core';
import type { HistoryItem, HistoryItemUser } from '../types.js';
import { isRealUserTurn } from '../utils/historyMapping.js';
import { escapeAnsiCtrlCodes } from '../utils/textUtils.js';

export interface TurnDiffEntry {
  /** 1-based index displayed to the user (T1 = oldest). */
  turnIndex: number;
  /** Trimmed preview of the original prompt, for the source tab label. */
  promptPreview: string;
  /** Full diff payload from FileHistoryService. */
  diff: TurnDiff;
}

/**
 * Loads per-turn diffs for every user turn that has a tracked `promptId`.
 *
 * Output is ordered **most recent first** to match how users mentally scan
 * "what just happened" — the source picker in the dialog mirrors that.
 *
 * Turns that:
 *   - have no `promptId` (slash commands, BTW prompts, pre-checkpointing
 *     legacy turns), or
 *   - have a `promptId` but no matching snapshot (e.g. compressed-out turns
 *     where the snapshot survives but the user message was rebuilt without
 *     a `promptId`), or
 *   - produced no file changes at all
 * are filtered out: showing an empty "T7" entry is just noise.
 */
export function useTurnDiffs(
  history: HistoryItem[],
  fileHistoryService: FileHistoryService | undefined,
  enabled: boolean,
): { turns: TurnDiffEntry[]; loading: boolean } {
  const [turns, setTurns] = useState<TurnDiffEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(enabled);

  useEffect(() => {
    if (!enabled || !fileHistoryService) {
      setTurns([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const userTurns = history.filter(isRealUserTurn) as HistoryItem[];

    Promise.all(
      userTurns.map(async (item, idx) => {
        // Early-exit so a quick close → reopen doesn't keep paying for
        // disk reads from the previous effect. The outer cancellation
        // guard alone would still suppress setState, but the I/O would
        // have already completed.
        if (cancelled) return null;
        const promptId = (item as HistoryItemUser).promptId;
        if (!promptId) return null;
        try {
          const diff = await fileHistoryService.getTurnDiff(promptId);
          if (cancelled) return null;
          if (!diff || diff.files.length === 0) return null;
          return {
            turnIndex: idx + 1,
            promptPreview: previewOfUserItem(item),
            diff,
          } satisfies TurnDiffEntry;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const usable = entries.filter((e): e is TurnDiffEntry => e !== null);
      // Most recent first — matches the mental model: hitting `/diff`
      // is almost always "what just changed".
      usable.reverse();
      setTurns(usable);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [history, fileHistoryService, enabled]);

  return { turns, loading };
}

const PREVIEW_MAX = 60;

function previewOfUserItem(item: HistoryItem): string {
  if (item.type !== 'user' || !item.text) return '';
  // Neutralize ANSI / OSC escapes so a prompt containing pasted terminal
  // output (or a hostile OSC 8 hyperlink) cannot reach the terminal raw
  // via the source-tab label. `HistoryItemDisplay` already applies the
  // same defense to the chat surface.
  const safe = escapeAnsiCtrlCodes(item.text);
  const oneLine = safe.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= PREVIEW_MAX) return oneLine;
  return `${oneLine.slice(0, PREVIEW_MAX - 1)}…`;
}
