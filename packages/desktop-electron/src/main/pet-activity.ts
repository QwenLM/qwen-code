/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PetState, SessionChangeReport } from '../shared/desktop-api';

export interface PetSessionTransition {
  baseState: PetState;
  state: PetState;
  transientMs?: number;
}

export function petStateForStreaming(state: string): PetState {
  if (state === 'waiting') return 'waiting';
  if (state === 'responding') return 'running';
  return 'idle';
}

export function petTransitionForSession(
  event: SessionChangeReport,
): PetSessionTransition {
  if (event.type === 'submit') {
    return { baseState: 'running', state: 'running' };
  }
  return event.failed
    ? { baseState: 'idle', state: 'failed', transientMs: 2_600 }
    : { baseState: 'idle', state: 'jumping', transientMs: 1_300 };
}
