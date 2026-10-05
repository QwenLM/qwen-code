/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { asKnownDaemonEvent, type DaemonEvent } from '@qwen-code/sdk/daemon';
import { isRecord } from './httpErrors.js';

export interface LiveJournalRepairTarget {
  marker: DaemonEvent;
  promptId: string;
  signature: string;
}

export interface LiveJournalRepairSuffix {
  events: DaemonEvent[];
  terminal: DaemonEvent;
}

export function findLiveJournalRepairTarget(
  sessionId: string,
  liveJournal: readonly DaemonEvent[],
  lastEventId: number | undefined,
  replayDegraded: boolean,
): LiveJournalRepairTarget | undefined {
  if (replayDegraded) return undefined;
  const marker = liveJournal.find(isRecoverableLiveJournalMarker);
  if (!marker) return undefined;
  const promptId =
    nonEmptyString(marker.promptId) ?? uniqueRetainedPromptId(liveJournal);
  if (!promptId) return undefined;
  const truncatedEvents = isRecord(marker.data)
    ? marker.data['truncatedEvents']
    : undefined;
  return {
    marker,
    promptId,
    signature: [
      sessionId,
      promptId,
      lastEventId ?? 'unknown',
      typeof truncatedEvents === 'number' ? truncatedEvents : 'unknown',
    ].join(':'),
  };
}

export function findLiveJournalRepairSuffix(
  replayEvents: readonly DaemonEvent[],
  promptId: string,
): LiveJournalRepairSuffix | undefined {
  const start = replayEvents.findIndex(
    (event) => eventPromptId(event) === promptId && isUserMessageChunk(event),
  );
  if (start < 0) return undefined;
  const terminal = replayEvents.find(
    (event, index) =>
      index >= start &&
      eventPromptId(event) === promptId &&
      (event.type === 'turn_complete' || event.type === 'turn_error'),
  );
  if (!terminal) return undefined;
  return { events: replayEvents.slice(start), terminal };
}

export function eventPromptId(event: DaemonEvent): string | undefined {
  const envelopePromptId = nonEmptyString(event.promptId);
  if (envelopePromptId) return envelopePromptId;
  return isRecord(event.data)
    ? nonEmptyString(event.data['promptId'])
    : undefined;
}

export function isLiveJournalMarker(event: DaemonEvent): boolean {
  return (
    event.type === 'history_truncated' &&
    isRecord(event.data) &&
    event.data['scope'] === 'live_journal'
  );
}

function isRecoverableLiveJournalMarker(event: DaemonEvent): boolean {
  const knownEvent = asKnownDaemonEvent(event);
  return (
    knownEvent?.type === 'history_truncated' &&
    isLiveJournalMarker(event) &&
    isRecord(event.data) &&
    event.data['fullTranscriptAvailable'] === true
  );
}

function uniqueRetainedPromptId(
  liveJournal: readonly DaemonEvent[],
): string | undefined {
  const promptIds = new Set<string>();
  for (const event of liveJournal) {
    if (isLiveJournalMarker(event)) continue;
    const promptId = eventPromptId(event);
    if (promptId) promptIds.add(promptId);
    if (promptIds.size > 1) return undefined;
  }
  return promptIds.size === 1 ? [...promptIds][0] : undefined;
}

function isUserMessageChunk(event: DaemonEvent): boolean {
  if (event.type !== 'session_update' || !isRecord(event.data)) return false;
  const update = event.data['update'];
  return isRecord(update) && update['sessionUpdate'] === 'user_message_chunk';
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
