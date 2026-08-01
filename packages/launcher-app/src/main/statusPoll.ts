/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { StatusResult } from './launcherClient.js';

export interface PollState {
  running: boolean;
  url?: string;
  lastError?: string;
}

/** Pure reducer: fold a status probe into the poll state (unit-tested). */
export function nextPollState(_prev: PollState, s: StatusResult): PollState {
  return {
    running: s.running,
    url: s.running ? s.url : undefined,
    lastError: undefined,
  };
}
