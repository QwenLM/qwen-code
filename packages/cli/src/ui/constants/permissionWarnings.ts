/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Centralized permission-mode transient warning messages.
 *
 * These warnings are displayed via `showTransientMessage` (auto-clears after
 * timeout) when the user enters a potentially dangerous permission mode via
 * Shift+Tab cycling. They are NEVER persisted to the session transcript.
 *
 * If any edge path accidentally writes them to the messages array, the
 * `permission_mode_transient` SystemSubtype ensures the transcript-writer
 * skips them structurally (no content matching needed).
 */

import { SHIFT_TAB_DISPLAY } from './shortcuts.js';

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

export function getBypassPermissionsWarning(): string {
  return `⚠ YOLO mode — every tool call auto-approved, including destructive operations. ${SHIFT_TAB_DISPLAY} to switch back.`;
}

export function getDontAskWarning(): string {
  return `⚠ Don't Ask mode — all operations requiring confirmation will be silently denied. ${SHIFT_TAB_DISPLAY} to switch back.`;
}
