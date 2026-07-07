/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import {
  createDebugLogger,
  type FileHistoryService,
  type TurnDiff,
} from '@qwen-code/qwen-code-core';
import type { HistoryItem, HistoryItemUser } from '../types.js';

type UserTurn = HistoryItem & HistoryItemUser;
import { isRealUserTurn } from '../utils/historyMapping.js';
import { escapeAnsiCtrlCodes } from '../utils/textUtils.js';

const debugLogger = createDebugLogger('DiffDialog');

/** Cap concurrent `getTurnDiff` calls. Each call can fan out to up to
 *  `MAX_TURN_DIFF_FILES * 2 = 1000` open()s; without an outer cap a
 *  50-turn session would multiply that and trivially blow past macOS's
 *  default `ulimit -n` of 256. 4 is conservative — turns batch quickly
 *  enough that loading never feels slower in practice while bounding the
 *  worst case to ~4000 concurrent fds (well under typical 4096 ceilings).
 */
const TURN_CONCURRENCY = 4;

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

    // isRealUserTurn is a type predicate, so the filter narrows to
    // UserTurn[] without the previous `as HistoryItem[]` cast.
    const userTurns = history.filter(isRealUserTurn);

    const loadOne = async (
      item: UserTurn,
      idx: number,
    ): Promise<TurnDiffEntry | null> => {
      // Early-exit so a quick close → reopen doesn't keep paying for
      // disk reads from the previous effect. The outer cancellation
      // guard alone would still suppress setState, but the I/O would
      // have already completed.
      if (cancelled) return null;
      const { promptId } = item;
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
    };

    // Process turns in fixed-size batches instead of an unbounded
    // Promise.all over every turn. See TURN_CONCURRENCY for the rationale.
    const loadAll = async (): Promise<TurnDiffEntry[]> => {
      const out: TurnDiffEntry[] = [];
      for (let i = 0; i < userTurns.length; i += TURN_CONCURRENCY) {
        if (cancelled) return out;
        const slice = userTurns.slice(i, i + TURN_CONCURRENCY);
        const batch = await Promise.all(
          slice.map((item, j) => loadOne(item, i + j)),
        );
        for (const entry of batch) {
          if (entry) out.push(entry);
        }
      }
      return out;
    };

    loadAll()
      .then((entries) => {
        if (cancelled) return;
        // Most recent first — matches the mental model: hitting `/diff`
        // is almost always "what just changed".
        entries.reverse();
        setTurns(entries);
        setLoading(false);
      })
      .catch((err) => {
        // Defense-in-depth: each inner promise already swallows its own
        // errors, but a setState during unmount or a future refactor could
        // still surface here. Log and unstick `loading` rather than letting
        // the rejection propagate to the Node default-handler (which on
        // Node 22+ terminates the process for unhandled rejections).
        debugLogger.debug(`useTurnDiffs pipeline failed: ${err}`);
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [history, fileHistoryService, enabled]);

  return { turns, loading };
}

const PREVIEW_MAX = 60;

function previewOfUserItem(item: UserTurn): string {
  if (!item.text) return '';
  // Neutralize ANSI / OSC escapes so a prompt containing pasted terminal
  // output (or a hostile OSC 8 hyperlink) cannot reach the terminal raw
  // via the source-tab label. `HistoryItemDisplay` already applies the
  // same defense to the chat surface.
  const safe = escapeAnsiCtrlCodes(item.text);
  const oneLine = safe.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= PREVIEW_MAX) return oneLine;
  return `${oneLine.slice(0, PREVIEW_MAX - 1)}…`;
}
