/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItemWithoutId } from '../types.js';
import {
  projectToolCallDisplay,
  type ProjectToolDisplayInput,
} from './toolDisplayProjection.js';

export function appendToolResultsToHistory(
  results: readonly ProjectToolDisplayInput[],
  addHistoryItem: (item: HistoryItemWithoutId) => void,
): void {
  addHistoryItem({
    type: 'tool_group',
    tools: results.map((result) => projectToolCallDisplay(result)),
  });
}
