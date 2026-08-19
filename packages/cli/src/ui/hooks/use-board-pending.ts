/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import {
  resolveBoardPromptContext,
  listAsks,
  listDecisions,
} from '@qwen-code/qwen-code-core/board';

/**
 * How often an idle session looks at the board.
 *
 * Nothing is delivered here — a participant sees an item when it next reads.
 * A session mid-turn reads at its turn boundary, but an idle one sitting at a
 * prompt has no boundary, so without a timer an ask addressed to it would sit
 * until its TTL lapsed. Five seconds is below the threshold a person notices
 * and costs one `readdir` plus a few small reads, which is the same order as
 * `sessions ps`.
 *
 * This is not push: the session chose the moment, nothing can arrive unbidden,
 * and no door is open. It is what lets the fetch contract stay responsive.
 */
export const BOARD_POLL_INTERVAL_MS = 5_000;

export interface BoardPending {
  board: string;
  /** Open asks addressed to this participant. */
  asks: number;
  /** Open decisions — the human's, regardless of who raised them. */
  decisions: number;
}

/**
 * Watches the board this session joined for anything waiting on it. Returns
 * `null` when the session is on no board, which is the common case.
 */
export function useBoardPending(): BoardPending | null {
  const [pending, setPending] = useState<BoardPending | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const ctx = resolveBoardPromptContext();
      if (!ctx) {
        if (!cancelled) setPending(null);
        return;
      }
      try {
        const [asks, decisions] = await Promise.all([
          listAsks(ctx.board, {
            states: ['open'],
            ...(ctx.as ? { to: ctx.as } : {}),
          }),
          listDecisions(ctx.board, { states: ['open'] }),
        ]);
        if (cancelled) return;
        setPending({
          board: ctx.board,
          asks: asks.length,
          decisions: decisions.length,
        });
      } catch {
        // A board that is unreadable — removed, permissions changed — is not
        // worth interrupting a session over. The indicator simply goes away.
        if (!cancelled) setPending(null);
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), BOARD_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return pending;
}

/**
 * The footer string, or undefined when there is nothing waiting. Decisions
 * come first and carry the warning mark: an ask blocks one peer, a decision
 * blocks everyone until a person acts.
 */
export function formatBoardPending(
  pending: BoardPending | null,
): string | undefined {
  if (!pending) return undefined;
  const parts: string[] = [];
  if (pending.decisions > 0) parts.push(`⚠ ${pending.decisions}`);
  if (pending.asks > 0) parts.push(`? ${pending.asks}`);
  if (parts.length === 0) return undefined;
  return `board ${pending.board} ${parts.join(' ')}`;
}
