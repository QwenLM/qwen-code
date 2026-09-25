/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonFollowupSuggestionData } from '@qwen-code/sdk/daemon';

const listeners = new Set<() => void>();
let lastFollowupSuggestion: DaemonFollowupSuggestionData | undefined;

export function getSidechannelFollowupSuggestion():
  | DaemonFollowupSuggestionData
  | undefined {
  return lastFollowupSuggestion;
}

export function subscribeSidechannelFollowupSuggestion(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishSidechannelFollowupSuggestion(
  suggestion: DaemonFollowupSuggestionData,
): void {
  lastFollowupSuggestion = { ...suggestion };
  notifySidechannelFollowupListeners();
}

export function clearSidechannelFollowupSuggestion(): void {
  if (lastFollowupSuggestion === undefined) return;
  lastFollowupSuggestion = undefined;
  notifySidechannelFollowupListeners();
}

function notifySidechannelFollowupListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function parseSidechannelFollowupSuggestion(
  event: unknown,
): DaemonFollowupSuggestionData | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as Record<string, unknown>;
  if (record['type'] !== 'followup_suggestion') return undefined;
  const data = record['data'];
  if (!data || typeof data !== 'object') return undefined;
  const dataRecord = data as Record<string, unknown>;
  const sessionId = dataRecord['sessionId'];
  const suggestion = dataRecord['suggestion'];
  const promptId = dataRecord['promptId'];
  if (
    typeof sessionId !== 'string' ||
    typeof suggestion !== 'string' ||
    suggestion.length === 0 ||
    typeof promptId !== 'string'
  ) {
    return undefined;
  }
  return { sessionId, suggestion, promptId };
}
