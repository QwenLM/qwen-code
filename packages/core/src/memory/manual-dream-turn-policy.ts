/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';

// This is persisted provenance, not an environment reminder. Keeping it out
// of <system-reminder> avoids suppressing real environment reminders when an
// interrupted Dream turn is recovered.
export const MANUAL_DREAM_TOOL_GUARD_MARKER =
  '<qwen-code-turn-policy>manual-dream-v1</qwen-code-turn-policy>';

export function hasManualDreamToolGuardMarker(parts: readonly Part[]): boolean {
  return parts.some(
    (part) =>
      typeof part.text === 'string' &&
      part.text.includes(MANUAL_DREAM_TOOL_GUARD_MARKER),
  );
}

/** Find the owning user prompt for the current logical tool/continuation turn. */
export function isManualDreamToolGuardTurn(
  history: readonly Content[],
): boolean {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const content = history[index];
    if (content?.role !== 'user') continue;

    const parts = content.parts ?? [];
    if (hasManualDreamToolGuardMarker(parts)) return true;
    if (parts.some((part) => part.functionResponse)) {
      // Tool results still belong to the original user prompt.
      continue;
    }

    // Hooks and failed retries can persist adjacent user entries. Inspect the
    // complete run, but never cross the model response separating older work.
    while (history[index - 1]?.role === 'user') {
      index -= 1;
      if (hasManualDreamToolGuardMarker(history[index]?.parts ?? [])) {
        return true;
      }
    }
    return false;
  }
  return false;
}

/** Add persisted provenance to an automatic continuation exactly once. */
export function preserveManualDreamToolGuardMarker(
  history: readonly Content[],
  parts: readonly Part[],
): Part[] {
  if (
    hasManualDreamToolGuardMarker(parts) ||
    !isManualDreamToolGuardTurn(history)
  ) {
    return [...parts];
  }
  const marker = { text: MANUAL_DREAM_TOOL_GUARD_MARKER };
  const firstNonResponse = parts.findIndex((part) => !part.functionResponse);
  if (firstNonResponse < 0) return [...parts, marker];
  return [
    ...parts.slice(0, firstNonResponse),
    marker,
    ...parts.slice(firstNonResponse),
  ];
}
