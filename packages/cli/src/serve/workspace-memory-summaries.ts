/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function formatWorkspaceMemoryForgetSummary(
  removedEntryCount: number,
): string {
  return removedEntryCount > 0
    ? `Forgot ${removedEntryCount} memory entr${removedEntryCount === 1 ? 'y' : 'ies'}.`
    : 'No managed auto-memory entries matched.';
}

export function formatWorkspaceMemoryDreamSummary(
  touchedTopicCount: number,
): string {
  return touchedTopicCount > 0
    ? 'Managed auto-memory dream completed.'
    : 'No managed auto-memory topics changed.';
}
