/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { MouseButton, type MouseEvent } from '@opentui/core';

export interface TranscriptRightClickActions {
  /** A selection whose owner is inside the transcript. */
  hasSelection: boolean;
  clearSelection: () => void;
  pasteClipboard: () => void;
}

type TranscriptMouseEvent = Pick<
  MouseEvent,
  'button' | 'preventDefault' | 'stopPropagation'
>;

/**
 * Transcript right-click policy: a scoped selection is cleared; otherwise the
 * clipboard is pasted into the composer. Left and middle buttons fall through
 * to their normal handlers.
 */
export function handleTranscriptRightClick(
  event: TranscriptMouseEvent,
  actions: TranscriptRightClickActions,
): boolean {
  if (event.button !== MouseButton.RIGHT) return false;
  if (actions.hasSelection) actions.clearSelection();
  else actions.pasteClipboard();
  event.preventDefault();
  event.stopPropagation();
  return true;
}
