/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PENDING_PROMPT_ADDED_EVENT,
  PENDING_PROMPT_STARTED_EVENT,
  PENDING_PROMPT_COMPLETED_EVENT,
} from '@qwen-code/sdk/daemon';
import type {
  DaemonPendingPromptAddedEvent,
  DaemonPendingPromptStartedEvent,
  DaemonPendingPromptCompletedEvent,
  DaemonTurnCompleteEvent,
  DaemonTurnErrorEvent,
} from '@qwen-code/sdk/daemon';

/**
 * Simple version counter for pending-prompt queue changes.
 *
 * The daemon publishes `pending_prompt_added`, `pending_prompt_started`,
 * and `pending_prompt_completed` SSE events whenever the pending queue
 * changes. This sidechannel increments a version counter on each event,
 * and consumers (e.g. web-shell) re-fetch the full queue via
 * `GET /session/:id/pending-prompts` when the version changes.
 *
 * This is intentionally simpler than `midTurnInjectedSidechannel`: a
 * monotonic counter plus a small bounded event buffer for completion callbacks.
 */

const versionListeners = new Set<() => void>();
const eventListeners = new Set<() => void>();
const MAX_PENDING_PROMPT_EVENTS = 200;
let version = 0;
let events: PendingPromptSidechannelEvent[] = [];

export type PendingPromptSidechannelEvent =
  | DaemonPendingPromptAddedEvent
  | DaemonPendingPromptStartedEvent
  | DaemonPendingPromptCompletedEvent
  | DaemonTurnCompleteEvent
  | DaemonTurnErrorEvent;

export function getPendingPromptVersion(): number {
  return version;
}

export function getPendingPromptEvents(): readonly PendingPromptSidechannelEvent[] {
  return events;
}

export function subscribePendingPromptVersion(
  listener: () => void,
): () => void {
  versionListeners.add(listener);
  return () => {
    versionListeners.delete(listener);
  };
}

export function subscribePendingPromptEvents(listener: () => void): () => void {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

export function bumpPendingPromptVersion(): void {
  version++;
  for (const listener of versionListeners) {
    try {
      listener();
    } catch (error) {
      console.error('[pendingPromptVersion] listener error', error);
    }
  }
}

function notifyPendingPromptEvents(): void {
  for (const listener of eventListeners) {
    try {
      listener();
    } catch (error) {
      console.error('[pendingPromptEvents] listener error', error);
    }
  }
}

export function consumePendingPromptEvents(
  handled: readonly PendingPromptSidechannelEvent[],
): void {
  if (handled.length === 0) return;
  const handledSet = new Set(handled);
  const next = events.filter((event) => !handledSet.has(event));
  if (next.length === events.length) return;
  events = next;
  notifyPendingPromptEvents();
}

export function publishPendingPromptEvent(event: unknown): boolean {
  const parsed = parsePendingPromptEvent(event);
  if (!parsed) return false;
  events = [...events, parsed].slice(-MAX_PENDING_PROMPT_EVENTS);
  notifyPendingPromptEvents();
  if (
    parsed.type === PENDING_PROMPT_ADDED_EVENT ||
    parsed.type === PENDING_PROMPT_STARTED_EVENT ||
    (parsed.type === PENDING_PROMPT_COMPLETED_EVENT &&
      parsed.data.state === 'removed')
  ) {
    bumpPendingPromptVersion();
  }
  return true;
}

/**
 * Parse a raw daemon SSE frame and return true if it's a pending-prompt
 * event that should bump the version counter.
 */
export function isPendingPromptEvent(event: unknown): boolean {
  return parsePendingPromptEvent(event) !== undefined;
}

function parsePendingPromptEvent(
  event: unknown,
): PendingPromptSidechannelEvent | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as Record<string, unknown>;
  const type = record['type'];
  const data = record['data'];
  if (!data || typeof data !== 'object') return undefined;
  const dataRecord = data as Record<string, unknown>;
  if (typeof dataRecord['sessionId'] !== 'string') return undefined;
  if (
    (type === PENDING_PROMPT_ADDED_EVENT ||
      type === PENDING_PROMPT_STARTED_EVENT ||
      type === PENDING_PROMPT_COMPLETED_EVENT) &&
    typeof dataRecord['promptId'] === 'string'
  ) {
    return event as PendingPromptSidechannelEvent;
  }
  if (
    (type === 'turn_complete' || type === 'turn_error') &&
    typeof dataRecord['promptId'] === 'string'
  ) {
    return event as PendingPromptSidechannelEvent;
  }
  return undefined;
}
