/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cmd+B (macOS) / Ctrl+B toggles the session sidebar (#5074), mirroring the
 * convention editors like VS Code use. Plain modifier+B only: Shift/Alt
 * variants stay available to the browser and other bindings, and
 * Cmd+Ctrl combined presses are rejected as ambiguous.
 */
export function isSidebarToggleShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (event.key !== 'b' && event.key !== 'B') return false;
  if (event.altKey || event.shiftKey) return false;
  return event.metaKey !== event.ctrlKey;
}
