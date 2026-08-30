/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useContext } from 'react';
import { SettingsContext } from '../contexts/SettingsContext.js';

/**
 * Whether tool calls render verbosely: one row per call with its full raw
 * arguments inline (`ui.showToolCallArgs`, default false).
 *
 * Two decision points share this flag and must not drift apart:
 * 1. `ToolGroupMessage` — folds it into `forceExpandAll`, so read/search/list
 *    batches stop collapsing into a `Read 3 files` summary line.
 * 2. `ToolMessage` — renders the args row under the tool header.
 *
 * Reads the raw context, not the throwing `useSettings`, so the tool renderers
 * still mount outside a SettingsProvider (e.g. unit tests) — mirrors
 * `useMouseTrackingEnabled`.
 */
export function useShowToolCallArgs(): boolean {
  return useContext(SettingsContext)?.merged.ui?.showToolCallArgs === true;
}
