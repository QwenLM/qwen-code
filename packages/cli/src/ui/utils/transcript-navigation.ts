/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Structure-aware navigation over the virtualized transcript.
 *
 * The transcript scroll commands move by *distance* (lines, pages). These
 * helpers move by *structure*: a turn (the user prompt that started it) or a
 * tool-output block. They are deliberately renderer-agnostic and operate on
 * the smallest structural shape they need, so both the navigation key handler
 * and the unit tests can feed them plain history-shaped objects, including
 * the `vp-banner` sentinel, which never matches an anchor.
 */

/** The item tags this module understands; anything else is never an anchor. */
export interface TranscriptNavItem {
  readonly type: string;
  readonly sentToModel?: boolean;
}

export type TranscriptAnchorKind = 'turn' | 'tool';

/**
 * A turn starts at a user prompt that was actually sent to the model. Steer
 * items (`sentToModel === false`) are mid-turn injections, so they must not
 * split a turn — this mirrors the turn-boundary predicate MainContent uses
 * when it resets per-turn source-copy numbering.
 */
export function isTurnStart(item: TranscriptNavItem): boolean {
  return item.type === 'user' && item.sentToModel !== false;
}

export function isToolOutputItem(item: TranscriptNavItem): boolean {
  return item.type === 'tool_group';
}

export function isAnchorItem(
  item: TranscriptNavItem,
  kind: TranscriptAnchorKind,
): boolean {
  return kind === 'turn' ? isTurnStart(item) : isToolOutputItem(item);
}

export type AnchorDirection = 'previous' | 'next';

/**
 * Index of the closest anchor strictly beyond `fromIndex` in `direction`, or
 * -1 when there is none. The search is exclusive on purpose: when the
 * viewport is already anchored on a turn, "previous turn" must move to the
 * turn before it rather than stay put.
 */
export function findAdjacentAnchor<T extends TranscriptNavItem>(
  items: readonly T[],
  fromIndex: number,
  direction: AnchorDirection,
  kind: TranscriptAnchorKind,
): number {
  const step = direction === 'next' ? 1 : -1;
  for (
    let index = fromIndex + step;
    index >= 0 && index < items.length;
    index += step
  ) {
    if (isAnchorItem(items[index], kind)) {
      return index;
    }
  }
  return -1;
}

export function countAnchors<T extends TranscriptNavItem>(
  items: readonly T[],
  kind: TranscriptAnchorKind,
): number {
  let count = 0;
  for (const item of items) {
    if (isAnchorItem(item, kind)) count += 1;
  }
  return count;
}

/**
 * 1-based ordinal of `index` among anchors of `kind`, i.e. the "12" in
 * "turn 12/48". Returns 0 when `index` is not an anchor so callers cannot
 * render a misleading position for a non-anchor row.
 */
export function anchorOrdinal<T extends TranscriptNavItem>(
  items: readonly T[],
  index: number,
  kind: TranscriptAnchorKind,
): number {
  if (index < 0 || index >= items.length) return 0;
  if (!isAnchorItem(items[index], kind)) return 0;
  let ordinal = 0;
  for (let i = 0; i <= index; i += 1) {
    if (isAnchorItem(items[i], kind)) ordinal += 1;
  }
  return ordinal;
}

/**
 * Tracks where structure navigation currently is, *independently* of the
 * viewport's scroll anchor. Needed because scrollToIndex clamps at the end of
 * the transcript: once a target sits inside the last page, the anchor stops
 * changing, so deriving the next step from the anchor would replay the same
 * jump forever. The cursor records the requested target instead, so every
 * keypress advances exactly one boundary even when the view cannot move.
 *
 * Reset it whenever the reading position changes for a reason that is not a
 * structure jump (manual scrolling, new output, a different search).
 */
export interface TranscriptNavCursor {
  /** Where the next previous/next search starts from. */
  origin: (liveAnchor: number) => number;
  /** Record a jump target as the new position, clamped or not. */
  record: (target: number) => void;
  /** Forget the position so the next jump starts from the live anchor. */
  reset: () => void;
}

export function createTranscriptNavCursor(): TranscriptNavCursor {
  let target: number | null = null;
  return {
    origin: (liveAnchor) => target ?? liveAnchor,
    record: (next) => {
      target = next;
    },
    reset: () => {
      target = null;
    },
  };
}
