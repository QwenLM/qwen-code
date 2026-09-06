/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const MAX_DAEMON_WORKSPACES = 25;
export const CHANNEL_WORKER_STARTUP_TIMEOUT_MS = 30_000;
export const CHANNEL_WORKER_STOP_GRACE_MS = 10_000;
export const CHANNEL_WORKER_KILL_GRACE_MS = 2_000;
export const CHANNEL_CONTROL_CLIENT_HEADROOM_MS = 30_000;

const CHANNEL_WORKER_STOP_TIMEOUT_MS =
  CHANNEL_WORKER_STOP_GRACE_MS + CHANNEL_WORKER_KILL_GRACE_MS;

// A replacement can stop and start every workspace, then perform the same
// bounded work again while rolling back. The SDK timeout must cover that full
// server-side transaction so it never reports a false failure while the
// non-cancellable mutation continues in the daemon.
export const CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS =
  2 *
    MAX_DAEMON_WORKSPACES *
    (CHANNEL_WORKER_STOP_TIMEOUT_MS + CHANNEL_WORKER_STARTUP_TIMEOUT_MS) +
  CHANNEL_CONTROL_CLIENT_HEADROOM_MS;
