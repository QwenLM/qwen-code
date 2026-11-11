/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ComponentType } from 'react';

/**
 * Where a session gate stands:
 * - `checking`: its first check (or a retry) is still running;
 * - `awaiting`: the user has to act before the session can continue;
 * - `ready`: the session may be used.
 */
export type SessionGateStatus = 'checking' | 'awaiting' | 'ready';

export interface SessionGateState {
  status: SessionGateStatus;
  /**
   * Whether the gate is showing its own UI. While it is, the gate takes over
   * the controls area and the CLI holds back its one-time startup actions.
   */
  visible: boolean;
}

export interface SessionGateProps {
  /** Reports every change of the gate's state to the CLI. */
  onStateChange(state: SessionGateState): void;
}

/**
 * A product-provided component mounted for the whole TUI session above every
 * other control. It renders nothing while it has nothing to show.
 */
export type SessionGate = ComponentType<SessionGateProps>;

/** The state a TUI without a session gate reports. */
export const OPEN_SESSION_GATE: SessionGateState = {
  status: 'ready',
  visible: false,
};

/** The state a session gate starts from until it reports its own. */
export const INITIAL_SESSION_GATE: SessionGateState = {
  status: 'checking',
  visible: false,
};
