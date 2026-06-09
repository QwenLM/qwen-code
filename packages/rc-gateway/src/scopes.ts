/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** A remote-control capability scope. Flat set for the walking skeleton. */
export type RcScope = string;

/** The only scope exercised this cycle: read a session's event stream. */
export const SESSION_READ: RcScope = 'session:read';

/** Management scope: list / mint / revoke tokens. */
export const OWNER: RcScope = 'owner';

/** Vote on a session's pending permission requests. */
export const APPROVE: RcScope = 'approve';

/** Send a prompt to a session (start a turn). */
export const WRITE: RcScope = 'write';

/**
 * Identity marker for a guest share token. Functional access comes from the
 * concrete `session:read`/`approve` scopes a share also carries; this scope
 * lets list/UI distinguish shares and is reserved for future guest-only gating.
 */
export const SHARE: RcScope = 'share';

/** All scopes the gateway recognizes (used to reject unknown mint scopes). */
export const KNOWN_SCOPES: readonly RcScope[] = [
  OWNER,
  SESSION_READ,
  APPROVE,
  WRITE,
  SHARE,
];
