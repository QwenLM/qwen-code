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
 * Direct scope implications (transitive closure is computed in {@link hasScope}).
 * Hierarchy: `owner ⊃ {write, approve, session:read}`, `write ⊃ session:read`,
 * `approve ⊃ session:read`. `write` does NOT imply `approve` and vice-versa —
 * sending a prompt and voting on a permission are independent authorities.
 * `bridge` and `share` are marker scopes; they carry no functional implications
 * (a `bridge` token's concrete bundle is materialized at issue time by
 * {@link expandScopes}).
 */
export const SCOPE_IMPLIES: Readonly<Record<RcScope, readonly RcScope[]>> = {
  [OWNER]: [WRITE, APPROVE, SESSION_READ],
  [WRITE]: [SESSION_READ],
  [APPROVE]: [SESSION_READ],
  [SESSION_READ]: [],
  [SHARE]: [],
  [BRIDGE]: [],
};

/**
 * True iff `required` is conferred by any of the `granted` scopes after
 * computing the transitive closure of {@link SCOPE_IMPLIES}. Uses an
 * iterative DFS so indirect chains (e.g. `owner → write → session:read`)
 * are resolved correctly.
 */
export function hasScope(
  granted: readonly RcScope[],
  required: RcScope,
): boolean {
  const expanded = new Set<RcScope>();
  const stack: RcScope[] = [...granted];
  while (stack.length > 0) {
    const scope = stack.pop() as RcScope;
    if (expanded.has(scope)) continue;
    expanded.add(scope);
    for (const implied of SCOPE_IMPLIES[scope] ?? []) {
      if (!expanded.has(implied)) stack.push(implied);
    }
  }
  return expanded.has(required);
}

/**
 * Materialize the concrete scope set a request grants. Only `bridge`
 * expands: a `bridge` token also carries `session:read` + `approve` + `write`
 * (a bridge must read the session stream it bridges, vote on permission
 * requests, and send prompts). Pure; dedupes; preserves the `bridge` marker. A
 * request without `bridge` is returned unchanged (deduped).
 *
 * Note: this is a token-issue-time materialization, NOT the runtime implication
 * check. Runtime scope sufficiency uses {@link hasScope} which walks
 * {@link SCOPE_IMPLIES} transitively.
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
