/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export interface OpenTuiScrollbarOptions {
  visible: boolean;
}

/**
 * The OpenTUI transcript scrollbar is hidden by default to give the
 * conversation one more column. An explicit `ui.showOpenTuiScrollbar: true`
 * restores OpenTUI's default bar, drawn whenever the transcript overflows
 * (undefined lets the scrollbox use
 * its own visibility logic).
 */
export function openTuiScrollbarOptions(
  show: boolean | undefined,
): OpenTuiScrollbarOptions | undefined {
  return show === true ? undefined : { visible: false };
}
