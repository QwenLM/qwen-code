/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A hint that describes a keyboard shortcut for the footer bar.
 */
export interface ShortcutHint {
  /** Display text, e.g. "↑↓ navigate" */
  label: string;
  /** Sort weight — lower numbers appear further left (default: 50) */
  order: number;
  /**
   * Optional association with a Command enum value.
   * @deprecated No longer used for filtering — kept for backward compatibility.
   */
  command?: unknown;
}
