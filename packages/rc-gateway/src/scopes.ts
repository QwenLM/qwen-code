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

/**
 * Sidecar/in-process BRIDGE scope (`add-bridge-protocol`). A bridge fans in N
 * external chat-service users; the scope marks a token as allowed to ASSERT a
 * `subActor` identity (the underlying human) in audit/SSE. Functionally a bridge
 * needs to read a session's stream, vote, and prompt, so a bridge token is
 * issued the CONCRETE bundle `{bridge, session:read, approve, write}` (see
 * {@link expandScopes}) rather than relying on a runtime implication hierarchy —
 * the gateway's scope checks are a deliberately FLAT `includes()` set, and not
 * every check funnels through one place (the notifier gates on `scopesFor`
 * directly), so the safe move is to materialize the bundle at issue time. The
 * `bridge` marker is retained in the set so the subActor gate can test for it.
 */
export const BRIDGE: RcScope = 'bridge';

/** All scopes the gateway recognizes (used to reject unknown mint scopes). */
export const KNOWN_SCOPES: readonly RcScope[] = [
  OWNER,
  SESSION_READ,
  APPROVE,
  WRITE,
  SHARE,
  BRIDGE,
];

/**
 * Materialize the concrete scope set a request grants. Today only `bridge`
 * expands: a `bridge` token also carries `session:read` + `approve` + `write`
 * (a bridge must read the session stream it bridges, vote on permission
 * requests, and send prompts). Pure; dedupes; preserves the `bridge` marker. A
 * request without `bridge` is returned unchanged (deduped).
 */
export function expandScopes(requested: readonly RcScope[]): RcScope[] {
  const out = new Set<RcScope>(requested);
  if (out.has(BRIDGE)) {
    out.add(SESSION_READ);
    out.add(APPROVE);
    out.add(WRITE);
  }
  return [...out];
}
