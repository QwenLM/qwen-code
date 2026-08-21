/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Menu / dialog / completion hover + click parity for the OpenTUI renderer
 * (PR1 slice 4).
 *
 * Framework-neutral port of `RowMouseController`, the headless mouse layer
 * the ink TUI shares between select menus (BaseSelectionList) and completion
 * suggestions (SuggestionsDisplay): bare pointer motion (`move`) highlights
 * the row under the pointer; a left press selects it. Disabled rows and
 * interactions outside the list's columns are ignored.
 */

import {
  resolveListIndex,
  type ListHitGeometry,
  type MousePoint,
} from './mouse-hit.js';

/** The two events a row list reacts to (parity with RowMouseController). */
export type RowMouseEventName = 'move' | 'left-press';

export interface RowMouseEvent {
  name: RowMouseEventName;
  /** Layout-space pointer position (already anchor-corrected). */
  point: MousePoint;
}

export interface RowMouseDispatchProps {
  geometry: ListHitGeometry;
  isDisabled?: (index: number) => boolean;
  /** Highlight the row under the pointer (hover). */
  onHoverIndex: (index: number) => void;
  /** Select the row under the pointer (click). */
  onSelectIndex: (index: number) => void;
}

/**
 * Resolve one mouse event onto a row and dispatch hover/select. Returns the
 * resolved index, or null when the event fell outside the list, on a gap, or
 * on a disabled row (nothing dispatched). Parity with
 * `RowMouseController#handleMouse`.
 */
export function dispatchRowMouseEvent(
  event: RowMouseEvent,
  props: RowMouseDispatchProps,
): number | null {
  const index = resolveListIndex(props.geometry, event.point, props.isDisabled);
  if (index === null) return null;
  if (event.name === 'move') {
    props.onHoverIndex(index);
  } else {
    props.onSelectIndex(index);
  }
  return index;
}
