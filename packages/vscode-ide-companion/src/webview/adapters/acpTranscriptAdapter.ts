/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Thin adapter that bridges ACP session/update notifications into the shared
 * SDK daemon transcript reducer. The ACP `SessionNotification` payload is
 * structurally identical to the daemon `session_update` envelope, so no
 * per-field projection is needed: wrap the notification once, then let
 * `normalizeDaemonEvent` + `reduceDaemonTranscriptEvents` do the work.
 */
import type { SessionNotification } from '@agentclientprotocol/sdk';
import {
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
} from '@qwen-code/sdk/daemon';
import type { DaemonEvent, DaemonTranscriptState } from '@qwen-code/sdk/daemon';

/** Reduce one ACP notification into the transcript state. */
export function reduceSessionNotification(
  state: DaemonTranscriptState,
  notification: SessionNotification,
): DaemonTranscriptState {
  const event: DaemonEvent = {
    v: 1,
    type: 'session_update',
    data: notification,
  };
  return reduceDaemonTranscriptEvents(state, normalizeDaemonEvent(event));
}
