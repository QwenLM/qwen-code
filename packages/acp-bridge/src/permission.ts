/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `PermissionMediator` — type-only interface contract for daemon
 * permission flow. **No implementation lives here.** Permission voting
 * still runs inside `BridgeClient.requestPermission`
 * (`@qwen-code/acp-bridge/bridgeClient` after #4175 F1 step 2) and
 * `respondToPermission` (inside `createHttpAcpBridge` factory closure
 * at `@qwen-code/acp-bridge/bridge` after F1 step 3), hard-coded to
 * `first-responder`. F3 PR 24 will move that code behind this
 * interface and add the other three policies.
 *
 * The four policies are ordered from cheapest to strongest:
 *
 * - `first-responder` — first valid `POST /permission/:requestId`
 *   wins; later voters get `permission_already_resolved`. Today's
 *   default; preserves the live-collaboration UX.
 * - `designated` — only the `originatorClientId` that started the
 *   prompt may answer; other clients see `permission_forbidden`.
 *   Use case: per-tenant SaaS where a UI surface must own its own
 *   approvals.
 * - `consensus` — N-of-M quorum across pair-token-authenticated
 *   clients before resolving; intermediate `permission_partial_vote`
 *   events let UIs render progress. Use case: enterprise change
 *   review where two operators must agree.
 * - `local-only` — refuses any HTTP voter; the prompt blocks until
 *   a loopback client (the local TUI super-client) resolves it.
 *   Use case: workstations where remote control should never grant
 *   privilege escalation.
 *
 * See `bridgeClient.ts BridgeClient.requestPermission` for the
 * current first-responder implementation; the `FIXME(stage-1.5,
 * chiga0 finding 3)` block above that method scoped this contract.
 */
export type PermissionPolicy =
  | 'first-responder'
  | 'designated'
  | 'consensus'
  | 'local-only';

/**
 * One pending permission tracked by a `PermissionMediator`. The
 * shape mirrors the current `PendingPermission` record in
 * `@qwen-code/acp-bridge/bridgeClient` (lifted in #4175 F1 step 2)
 * so F3 PR 24's lift is a structural rename rather than a redesign.
 */
export interface PermissionRequestRecord {
  /** ACP `RequestPermission` request id, unique per session. */
  readonly requestId: string;
  /** Session that the request belongs to. Permission scope is
   * always per-session — workspace-scoped permission is out of
   * scope for v1. */
  readonly sessionId: string;
  /**
   * `originatorClientId` that triggered the underlying prompt.
   * `designated` policy votes are only accepted from this id;
   * `first-responder` ignores it for resolution but stamps it on
   * the outgoing `permission_request` event for audit.
   */
  readonly originatorClientId: string | undefined;
  /**
   * Allowed option ids the agent declared. Voters who submit an
   * `optionId` outside this set get `invalid_permission_option`
   * rejection regardless of policy.
   */
  readonly allowedOptionIds: ReadonlySet<string>;
  /**
   * Wallclock ms when the request was issued; the mediator decides
   * resolution timeouts relative to this.
   */
  readonly issuedAtMs: number;
}

/**
 * One vote landing on `POST /session/:sessionId/permission/:requestId`.
 */
export interface PermissionVote {
  readonly requestId: string;
  readonly sessionId: string;
  /**
   * Daemon-stamped (PR 7 / #4231) — never client self-declared.
   * `local-only` rejects votes whose remote address is not
   * loopback regardless of `clientId`.
   */
  readonly clientId: string | undefined;
  /** ACP option id the voter chose. Validated against
   * `allowedOptionIds` before the mediator sees it. */
  readonly optionId: string;
  /** Wallclock ms when the vote arrived. */
  readonly receivedAtMs: number;
  /** True when the request originated on a loopback connection.
   * `local-only` requires this. */
  readonly fromLoopback: boolean;
}

/**
 * Outcome of a single vote attempt. The mediator returns this so
 * the route handler can shape the HTTP response (200 / 409 / 410)
 * and the audit emitter can log the trail.
 */
export type PermissionVoteOutcome =
  | { readonly kind: 'resolved'; readonly resolvedOptionId: string }
  | { readonly kind: 'recorded'; readonly votesNeeded: number }
  | { readonly kind: 'already_resolved'; readonly resolvedOptionId: string }
  | {
      readonly kind: 'forbidden';
      /**
       * `designated_mismatch` fires for both:
       *   - `designated` policy: voter `clientId` is not the prompt
       *     `originatorClientId`.
       *   - `consensus` policy: voter `clientId` is undefined OR not
       *     in the issue-time `votersAtIssue` snapshot. Overloaded
       *     here to keep the contract closed; future versions may
       *     widen this union with a more specific reason if SDK
       *     consumers need to distinguish.
       *
       * `remote_not_allowed` fires under `local-only` policy when
       * `vote.fromLoopback === false`.
       */
      readonly reason: 'designated_mismatch' | 'remote_not_allowed';
    }
  | { readonly kind: 'unknown_request' };

/**
 * Final resolution shape. PR 24 will produce one per request once
 * either a quorum is reached, the originator votes (designated), or
 * a timeout expires.
 */
export type PermissionResolution =
  | { readonly kind: 'option'; readonly optionId: string }
  | {
      readonly kind: 'cancelled';
      readonly reason: 'timeout' | 'session_closed' | 'agent_cancelled';
    };

/**
 * The contract `qwen serve`'s permission route layer talks to.
 * Today there is one implementation (first-responder) wired
 * inline in `BridgeClient`; PR 24 will provide all four behind
 * this surface plus pair-token authentication and an audit log.
 */
export interface PermissionMediator {
  /** Active policy. May be reconfigured per session in future
   * versions, but PR 24 ships with daemon-wide policy only. */
  readonly policy: PermissionPolicy;

  /**
   * Register a fresh permission request from the agent. The
   * mediator returns a Promise that resolves once a vote
   * resolves the request or it times out. The bridge awaits this
   * in `BridgeClient.requestPermission` and forwards the result
   * back to the agent over ACP.
   */
  request(
    record: PermissionRequestRecord,
    timeoutMs: number,
  ): Promise<PermissionResolution>;

  /**
   * Record an incoming vote. The mediator decides whether it
   * resolves, accumulates, or is rejected. The route handler
   * shapes the HTTP reply from the returned outcome.
   */
  vote(vote: PermissionVote): PermissionVoteOutcome;

  /**
   * Drop any pending state for the session — called when the
   * session is closed or evicted. Pending requests resolve as
   * `{ kind: 'cancelled', reason: 'session_closed' }`.
   */
  forgetSession(sessionId: string): void;
}
