/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-async-context session ID, mirroring {@link promptIdContext}.
 *
 * `QWEN_CODE_SESSION_ID` historically lived only in `process.env`, which is
 * a single process-global slot. That is fine for the interactive CLI (one
 * session per process, switched via `Config.startNewSession()`), but breaks
 * in daemon mode where one process hosts many concurrent sessions: only the
 * first `Config` ever claims the env slot (see `sessionEnvClaimed` in
 * config.ts), so shells spawned by every later session would read a stale
 * session ID.
 *
 * Daemon-style hosts should wrap each session's execution entry points in
 * `sessionIdContext.run(sessionId, ...)`. `getShellContextEnvVars()` prefers
 * this context over `process.env`, falling back to the env var so the
 * single-session CLI behavior is unchanged.
 */
export const sessionIdContext = new AsyncLocalStorage<string>();
