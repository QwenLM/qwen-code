/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// ---------------------------------------------------------------------------
// Bearer read face — the token that goes on the Authorization header
//
// A plain value with no kind attached: which identity the token belongs to is
// a login-state question and is read through the UserInfoResolver instead.
// ---------------------------------------------------------------------------

/**
 * Read face over the active request bearer. `undefined` when no credential is
 * projected (anonymous).
 */
export interface BearerResolver {
  getBearer(): string | undefined;
  /**
   * Optional asynchronous read for rotating credentials; valves prefer it
   * over the synchronous read when present.
   */
  getBearerAsync?(): Promise<string | undefined>;
  /**
   * Optional one-shot renewal when a request was rejected with HTTP 401.
   * `rejectedToken` is what the peer refused, so an already-rotated
   * credential is reused instead of refreshed twice.
   */
  refreshBearer?(rejectedToken?: string): Promise<string | undefined>;
}
