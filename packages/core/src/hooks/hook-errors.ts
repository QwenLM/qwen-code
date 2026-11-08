/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A hook ran past its own configured timeout. Never used for a caller abort:
 * a runner that sees this error reports the `timeout` outcome, which tells the
 * user to raise `timeout`, not that someone cancelled the hook.
 */
export class HookTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookTimeoutError';
  }
}

/** The caller's AbortSignal fired while the hook was running. */
export class HookAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookAbortError';
  }
}
