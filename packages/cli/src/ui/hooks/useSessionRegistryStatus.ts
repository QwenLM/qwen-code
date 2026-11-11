/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Publishes this session's activity into the peer registry.
 *
 * The registry's `status` is what lets a peer decide whether this session can
 * take work now, so it has to track the session rather than being stamped once
 * at startup. See docs/designs/2026-08-10-cross-session-peer-identity.md §6.3.
 */

import { useEffect } from 'react';
import {
  refreshSessionRegistryEntry,
  type SessionStatus,
} from '@qwen-code/core';
import { StreamingState } from '../types.js';

/**
 * Maps UI activity onto the registry's status vocabulary.
 *
 * Model activity outranks shell mode: a session whose agent is mid-turn is
 * unavailable to a peer whatever the prompt happens to be doing, so `shell`
 * describes an otherwise-idle session where the user is at a shell prompt.
 */
export function deriveSessionStatus(
  streamingState: StreamingState,
  shellModeActive: boolean,
): SessionStatus {
  if (streamingState === StreamingState.Responding) return 'busy';
  if (streamingState === StreamingState.WaitingForConfirmation) return 'waiting';
  return shellModeActive ? 'shell' : 'idle';
}

/**
 * Keeps the published status in step with the session.
 *
 * The effect is keyed on the derived status rather than on `streamingState`, so
 * it fires on transitions instead of on renders — the host component re-renders
 * about once a second, and the registry lives in a directory every peer scans.
 * The change gate inside `refreshSessionRegistryEntry` is the second line of
 * defence, not the first.
 */
export function useSessionRegistryStatus(
  streamingState: StreamingState,
  shellModeActive: boolean,
): void {
  const status = deriveSessionStatus(streamingState, shellModeActive);

  useEffect(() => {
    refreshSessionRegistryEntry({ status });
  }, [status]);
}
