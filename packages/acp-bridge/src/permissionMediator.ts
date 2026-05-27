/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `MultiClientPermissionMediator` — implementation of the
 * `PermissionMediator` contract from `./permission.ts`.
 *
 * Owns ALL pending and resolved permission state for the bridge.
 * `httpAcpBridge.ts` no longer keeps `pendingPermissions: Map` or
 * `resolvedPermissions: LRU` — those are inside this class.
 *
 * Strategy dispatch: a single class with `switch (entry.policy)` inside
 * `vote()`. Per-policy logic stays small (5–15 lines each); strategy
 * sub-classes would be more boilerplate than substance.
 *
 * Per #4175 F3 plan. Companion to PR 22a's frozen contract.
 */

import {
  type PermissionMediator,
  type PermissionPolicy,
  type PermissionRequestRecord,
  type PermissionResolution,
  type PermissionVote,
  type PermissionVoteOutcome,
} from './permission.js';
import { type BridgeEvent } from './eventBus.js';
import {
  CancelSentinelCollisionError,
  InvalidPermissionOptionError,
} from './bridgeErrors.js';

/**
 * Sentinel `optionId` value the bridge maps voter `{outcome:'cancelled'}`
 * to before calling `mediator.vote`. The mediator recognizes this and
 * resolves the pending as `{kind:'cancelled', reason:'agent_cancelled'}`
 * regardless of the active policy.
 *
 * **Bridge-side precondition**: callers MUST NOT forward an incoming
 * `vote.optionId === CANCEL_VOTE_SENTINEL` from a wire client — the
 * mediator treats the sentinel as cancel intent without consulting the
 * `allowedOptionIds` set, so wire-originated sentinel votes would
 * silently flip a real approval into a cancel. The bridge constructs
 * the sentinel only from a `{outcome:'cancelled'}` ACP body that
 * carries no `optionId` of its own.
 *
 * **Cross-policy escape hatch (intentional)**: cancel routes BEFORE
 * policy dispatch. A non-loopback voter under `local-only` and a
 * not-in-voter-set client under `consensus` can both still resolve the
 * pending as cancelled by posting `{outcome:'cancelled'}`. This is
 * deliberate — voter-cancel is the agent-side abort path; if the
 * threat model required policy-gated cancel, that would be a future
 * contract change. Documented here so a future maintainer doesn't
 * "fix" the bypass.
 *
 * **Collision defense**: `mediator.request` rejects records whose
 * `allowedOptionIds` contains the sentinel by throwing
 * `CancelSentinelCollisionError` so an agent legitimately publishing
 * `'__cancelled__'` as an option label can't masquerade as cancel.
 */
export const CANCEL_VOTE_SENTINEL = '__cancelled__' as const;

/**
 * Bounded FIFO size for the `resolved` map (duplicate-vote dedup +
 * `permission_already_resolved` source). DeepSeek review #4335 /
 * 3271627446 — the eviction in `rememberResolved` uses
 * `resolvedOrder.shift()` (drop oldest), not LRU; mirrors the FIFO
 * `PermissionAuditRing` correction in commit b0242ddec. Mirrors the
 * `MAX_RESOLVED_PERMISSION_RECORDS` constant from the pre-F3 inline
 * implementation in `httpAcpBridge.ts` (512 entries). Stores only
 * requestId / sessionId / outcome, so 512 records stays well under
 * 100 KB across normal UI reconnect/race windows.
 */
const MAX_RESOLVED_PERMISSION_RECORDS = 512;

/**
 * Structured "why did this resolve like that?" record attached to
 * audit `permission.resolved` events. Borrowed from claude-code's
 * `PermissionDecisionReason`.
 *
 * **Wire-vs-audit overload note**: `'agent-cancelled'` and
 * `'voter-cancelled'` both project to the same wire shape
 * (`PermissionResolution { kind:'cancelled', reason:'agent_cancelled' }`)
 * because the ACP protocol doesn't distinguish them. The discrimination
 * lives only in the audit log — useful for forensics, invisible on the
 * bus. F3 deliberately preserves this overload to avoid breaking the
 * frozen `permission.ts` contract.
 *
 * `resolverClientId: string | undefined` on `'first-responder'`,
 * `'local-only-loopback'`, and `'voter-cancelled'` is undefined when
 * the resolving voter connected over loopback without a registered
 * `X-Qwen-Client-Id` header — a legitimate path for the local TUI
 * default flow. The field is required-but-nullable rather than
 * optional to force callers to think about the loopback case.
 */
export type PermissionDecisionReason =
  | {
      readonly type: 'first-responder';
      readonly resolverClientId: string | undefined;
    }
  | {
      readonly type: 'designated-originator';
      readonly originatorClientId: string;
    }
  | {
      readonly type: 'consensus-quorum';
      readonly resolvedOptionId: string;
      readonly quorum: number;
      readonly tally: number;
    }
  | {
      readonly type: 'local-only-loopback';
      readonly resolverClientId: string | undefined;
    }
  | {
      readonly type: 'timeout';
      readonly issuedAtMs: number;
      readonly timeoutMs: number;
      /** `deps.now()` at timer fire — distinct from `issuedAtMs +
       *  timeoutMs` under load (timer queue scheduling delay). */
      readonly firedAtMs: number;
    }
  | { readonly type: 'session-closed' }
  /** Agent cancelled the underlying prompt before any voter resolved
   *  the permission. Wire shape collides with `'voter-cancelled'`. */
  | { readonly type: 'agent-cancelled' }
  /** A voter posted `{outcome:'cancelled'}`. Wire shape collides with
   *  `'agent-cancelled'`. */
  | {
      readonly type: 'voter-cancelled';
      readonly resolverClientId: string | undefined;
    };

/**
 * Audit sink the mediator writes to. Implementation lives in
 * `packages/cli/src/serve/permissionAudit.ts` and writes into an
 * in-memory bounded ring on the bridge — NOT onto the SSE bus
 * (audit records and SSE wire events are intentionally separate
 * channels per the F3 plan).
 *
 * The mediator depends only on this interface, so unit tests can
 * substitute a no-op or a recording stub without dragging the host
 * package's audit ring in.
 */
export interface PermissionAuditPublisher {
  recordRequested(
    record: PermissionRequestRecord,
    policy: PermissionPolicy,
    votersAtIssue: ReadonlySet<string>,
  ): void;
  recordVoted(
    record: PermissionRequestRecord,
    vote: PermissionVote,
    outcome: PermissionVoteOutcome,
  ): void;
  recordForbidden(
    record: PermissionRequestRecord,
    vote: PermissionVote,
    reason: 'designated_mismatch' | 'remote_not_allowed',
  ): void;
  recordResolved(
    record: PermissionRequestRecord,
    resolution: PermissionResolution,
    decisionReason: PermissionDecisionReason,
  ): void;
  recordTimeout(record: PermissionRequestRecord): void;
}

/**
 * Best-effort string-form of an unknown error value for breadcrumb
 * lines written to `process.stderr`. Avoids the failure modes of
 * blindly calling `String(err)` on a Symbol or `JSON.stringify` on
 * a circular object. Whole body is try/catch'd: a pathological
 * `Error` subclass with throwing `.name` / `.message` accessors
 * (e.g. `Proxy`-wrapped errors, getter-overriding subclasses) MUST
 * NOT escape from `safeAudit` / `safeEmit` and break the
 * never-blocks-Promise-settle invariant.
 */
function stringifyError(err: unknown): string {
  try {
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    return String(err);
  } catch {
    return '[unstringifiable error]';
  }
}

/**
 * No-op `PermissionAuditPublisher` used as the bridge's default when
 * the host omits `BridgeOptions.permissionAudit`. Production
 * `qwen serve` provides a ring-backed publisher; embedded callers and
 * unit tests that don't care about audit can let the bridge fall back
 * here. Single canonical fallback prevents stub-vs-prod divergence
 * (Commit 2 review note).
 */
export function createNoOpPermissionAuditPublisher(): PermissionAuditPublisher {
  return {
    recordRequested() {},
    recordVoted() {},
    recordForbidden() {},
    recordResolved() {},
    recordTimeout() {},
  };
}

/**
 * Dependency hooks the mediator needs from its host (the bridge).
 * Plumbed through `MultiClientPermissionMediator`'s constructor; tests
 * pass a stub.
 */
export interface MediatorDeps {
  /**
   * Best-effort fan-out of a wire event onto the per-session SSE bus.
   * The mediator passes `sessionId` explicitly so the bridge can route
   * to `byId.get(sessionId)?.events.publish(event)` without reverse-
   * lookup. If the entry is gone (session torn down between issue and
   * emit), the bridge silently drops; the audit record still lands.
   */
  emit: (sessionId: string, event: Omit<BridgeEvent, 'id' | 'v'>) => void;
  /** Audit ring writer. */
  audit: PermissionAuditPublisher;
  /**
   * Optional fixed quorum for `consensus`. When set, capped to
   * `M = votersAtIssue.size` to prevent unreachable quorum. When
   * unset, mediator computes `floor(M/2) + 1`.
   */
  consensusQuorum?: number;
  /** Wallclock supplier — injectable for deterministic tests. Used by
   *  the timeout decision-reason `firedAtMs` field. */
  now: () => number;
  /**
   * Snapshot of registered voter `clientId`s for the session at the
   * moment of `request()`. The mediator captures this into
   * `MediatorPending.votersAtIssue`; consensus rejects votes from
   * `clientId`s not in the snapshot.
   *
   * Implementation: `(sid) => new Set(byId.get(sid)?.clientIds.keys() ?? [])`.
   * Refcount is intentionally NOT exposed.
   *
   * **MUST return synchronously**. `mediator.request()` calls this
   * inside the Promise executor with no `await`, per the N1
   * race-prevention invariant. An async implementation (returning
   * `Promise<ReadonlySet<string>>`) would defer the pending registration
   * past the bridge's `publish → register → await` sequencing point and
   * silently break a `forgetSession` racing with the issue path.
   *
   * **Forward-compat trap**: when the session was torn down between
   * the bridge's `publish` and the mediator's `request` (extremely
   * narrow race), the implementation should return an empty Set
   * rather than throw. F3 v1's `first-responder` policy ignores the
   * snapshot, so an empty set is harmless. Once Commit 4 lands
   * `voteConsensus`, an empty `votersAtIssue` means EVERY vote on
   * the request gets rejected for "not in voter set" — the request
   * can only resolve via `forgetSession` cleanup or `permissionTimeoutMs`.
   * The bridge's torn-down-session race is short enough that this is
   * acceptable; document if a longer-window source of empty-voter
   * snapshots emerges.
   *
   * **Late-joiner timing window** (wenshao review #4335 / 3271041469).
   * The bridge sequence is `entry.events.publish(...)` →
   * (synchronous) → `await mediator.request(record, ...)`. The
   * publish is synchronous (`EventBus.publish` returns after fanning
   * to in-memory subscriber queues, no event-loop yield) and the
   * mediator's Promise executor is also synchronous through this
   * call (N1 invariant), so a NEW HTTP client cannot register its
   * `clientId` on `entry.clientIds` between publish and snapshot.
   * However, an SSE subscriber that connected BEFORE the publish but
   * has NOT yet hit any session route (no `X-Qwen-Client-Id` known
   * to the bridge) will not appear in the snapshot — `consensus`
   * silently rejects its later vote as `forbidden`. UIs that surface
   * the active voter set (eligible-voters chip) should treat
   * `permission_request` as the authoritative cutoff, not subsequent
   * client-identity registrations. F3 v1 does not surface
   * `votersAtIssue` to the wire; future PRs that add an
   * `eligibleVoters[]` field on `permission_request.data` should
   * source it from the same snapshot to keep client-side and
   * server-side membership decisions aligned.
   */
  votersForSession: (sessionId: string) => ReadonlySet<string>;
}

/**
 * Pending permission record owned by the mediator. Uniform shape across
 * all four policies — `tallies` and `votersAtIssue` are present even
 * for non-consensus (empty in that case) so we don't need a discriminated
 * union over `policy`. Memory cost is two empty containers per pending
 * (~120 bytes), negligible against the per-session pending cap of 64.
 */
interface MediatorPending {
  readonly requestId: string;
  readonly sessionId: string;
  /** Captured at request issue time so live-reload of the daemon
   * policy doesn't change the rules under in-flight requests. */
  readonly policy: PermissionPolicy;
  readonly originatorClientId: string | undefined;
  readonly allowedOptionIds: ReadonlySet<string>;
  readonly issuedAtMs: number;
  readonly timeoutMs: number;
  /** Settles the Promise returned by `request()`. */
  readonly resolve: (resolution: PermissionResolution) => void;
  /** Per-option vote sets for `consensus`; empty for other policies. */
  readonly tallies: Map<string /*optionId*/, Set<string /*clientId*/>>;
  /** Snapshot of eligible voters for `consensus`; empty for others. */
  readonly votersAtIssue: ReadonlySet<string>;
  /** Mediator-internal — do not read or write from outside the class. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Wenshao review #4335 / 3271185594 — set to `true` once the
   * `consensusQuorum` override cap has emitted its stderr
   * breadcrumb for this pending so we don't repeat the line every
   * time `consensusQuorumFor` is called within the same request.
   */
  consensusQuorumCapNoted: boolean;
}

interface PermissionResolutionRecord {
  readonly requestId: string;
  readonly sessionId: string;
  readonly resolution: PermissionResolution;
  /** Voter's clientId (or undefined for timeout / session-closed paths)
   *  — replayed onto `permission_already_resolved` so late SSE
   *  subscribers see the same `originatorClientId` the original
   *  `permission_resolved` carried (O8 wire compat). */
  readonly resolverClientId: string | undefined;
}

/**
 * Multi-client permission coordination implementation.
 *
 * Lifecycle:
 *   - `request(record, timeoutMs)` synchronously registers a pending
 *     entry inside the returned Promise's executor (no `await` before
 *     register — see N1 invariant in F3 plan) and arms the timeout.
 *   - `vote(vote)` dispatches by `entry.policy` and either resolves,
 *     records, rejects, or reports unknown.
 *   - `forgetSession(sessionId)` cancels every pending matching the
 *     session as `{kind:'cancelled', reason:'session_closed'}`.
 *
 * State is mediator-owned: `pending: Map<requestId, MediatorPending>`
 * and `resolved: BoundedMap<requestId, PermissionResolutionRecord>`.
 * Outside callers (the bridge) keep ONLY `entry.pendingPermissionIds`
 * for the per-session cap check; the mediator is the source of truth.
 */
export class MultiClientPermissionMediator implements PermissionMediator {
  readonly policy: PermissionPolicy;

  private readonly deps: MediatorDeps;
  private readonly pending = new Map<string, MediatorPending>();
  private readonly resolved = new Map<string, PermissionResolutionRecord>();
  private readonly resolvedOrder: string[] = [];
  /**
   * Wenshao review #4335 / 3272493829 — dedup flag for the
   * unanimity-required stderr breadcrumb. Without this, every
   * permission request on a 2-client consensus session would emit
   * an identical line (the unanimity condition is the NORMAL
   * operating mode for M=2, not a rare edge); a busy session with
   * many tool calls would produce dozens of duplicate stderr lines
   * within seconds. One emit per mediator (= per daemon lifetime
   * since the bridge constructs one) is enough to make the
   * configuration visible without spam.
   */
  private unanimityBreadcrumbEmitted = false;

  constructor(policy: PermissionPolicy, deps: MediatorDeps) {
    this.policy = policy;
    this.deps = deps;
  }

  /**
   * Register a fresh permission request from the agent.
   *
   * **Promise contract — once the Promise is returned, it never
   * rejects.** All runtime failure modes (timeout, session closure,
   * voter cancel, emit/audit publisher exceptions) are encoded as
   * `PermissionResolution { kind:'cancelled', reason:... }`.
   * Consumers can `await` the returned Promise and forward the
   * result without a `.catch()` block.
   *
   * **Synchronous-throw exception** (DeepSeek review #4335 /
   * 3271627444): when the agent's `allowedOptionIds` contains the
   * cancel-vote sentinel string, this method throws
   * `CancelSentinelCollisionError` synchronously BEFORE constructing
   * the Promise. The synchronous shape is intentional — a
   * never-settling Promise alongside a thrown error would be worse
   * than a clean fail-fast — but callers must wrap this method
   * itself in `try/catch` (or call it from an `async` function so
   * the throw bubbles via the function's own Promise machinery).
   * `bridgeClient.ts` currently has its own pre-check at the bridge
   * layer; embedded callers must do the same. See `@throws` below.
   *
   * **N1 synchronous-register invariant**: pending entry, audit
   * record, and timer setup all happen inside the Promise executor
   * without `await`. The bridge's `publish → mediator.request → await`
   * sequence relies on this — a `forgetSession` between publish and
   * await would otherwise miss the new pending and leak it until
   * timeout.
   *
   * @throws `CancelSentinelCollisionError` SYNCHRONOUSLY (not as a
   *   Promise rejection) if `record.allowedOptionIds` contains the
   *   cancel-vote sentinel string. This is a contract violation
   *   between agent and daemon and fails loudly at issue time
   *   rather than silently miscounting votes downstream. Callers
   *   inside an `async` function get the thrown error through the
   *   function's own Promise; synchronous callers must use
   *   `try/catch`.
   */
  request(
    record: PermissionRequestRecord,
    timeoutMs: number,
  ): Promise<PermissionResolution> {
    // Collision defense — fail loudly if an agent legitimately uses
    // the sentinel string as an option label. Throws synchronously
    // BEFORE constructing the Promise so the caller doesn't end up
    // holding a never-settling Promise alongside a thrown error.
    if (record.allowedOptionIds.has(CANCEL_VOTE_SENTINEL)) {
      throw new CancelSentinelCollisionError(
        record.requestId,
        CANCEL_VOTE_SENTINEL,
      );
    }
    return new Promise<PermissionResolution>((resolve) => {
      // === BEGIN SYNCHRONOUS REGISTER (no awaits permitted) ===
      const policy = this.policy;
      const votersAtIssue = this.deps.votersForSession(record.sessionId);
      const pending: MediatorPending = {
        requestId: record.requestId,
        sessionId: record.sessionId,
        policy,
        originatorClientId: record.originatorClientId,
        allowedOptionIds: record.allowedOptionIds,
        issuedAtMs: record.issuedAtMs,
        timeoutMs,
        resolve,
        tallies: new Map(),
        votersAtIssue,
        timer: undefined,
        consensusQuorumCapNoted: false,
      };
      this.pending.set(record.requestId, pending);
      this.safeAudit(() =>
        this.deps.audit.recordRequested(record, policy, votersAtIssue),
      );
      // Wenshao review #4335 / 3271185594 — when consensus is in
      // force but the bridge captured zero eligible voters at
      // issue time, the request can ONLY resolve via timeout (no
      // vote will ever pass `votersAtIssue.has(clientId)`). Emit
      // a stderr breadcrumb so operators don't have to derive that
      // from "5 minutes of silence + permission_request frame".
      // Doesn't change semantics; the timer still fires per the
      // configured `permissionTimeoutMs`.
      if (policy === 'consensus' && votersAtIssue.size === 0) {
        try {
          process.stderr.write(
            `permissionMediator: consensus request ${record.requestId} ` +
              `for session ${record.sessionId} issued with empty ` +
              `votersAtIssue; can only resolve via permissionTimeoutMs ` +
              `(${timeoutMs}ms)\n`,
          );
        } catch {
          // Stderr unavailable — silent drop.
        }
      }
      // Wenshao review #4335 / 3271978356 — for even-sized voter
      // sets the default formula `floor(M/2)+1` requires unanimity
      // ONLY when M=2 (the practical surprise case); M=4 → quorum=3
      // is supermajority; M=6 → quorum=4 is supermajority too. The
      // condition `floor(M/2)+1 === M` is true only for M=1
      // (single-voter; quorum=1 = M trivially) and M=2.
      //
      // Wenshao review #4335 / 3272493829 — dedup to one emit per
      // mediator lifetime via `unanimityBreadcrumbEmitted`. Without
      // this, a 2-client consensus session emits the line on EVERY
      // permission request (unanimity is the M=2 normal operating
      // mode, not a rare edge). The flag also ensures the line is
      // visible at least once when the daemon boots into this
      // configuration — operators see it on the first
      // requestPermission and can ignore the dedup'd silence
      // afterward.
      if (
        policy === 'consensus' &&
        this.deps.consensusQuorum === undefined &&
        votersAtIssue.size >= 2 &&
        Math.floor(votersAtIssue.size / 2) + 1 === votersAtIssue.size &&
        !this.unanimityBreadcrumbEmitted
      ) {
        this.unanimityBreadcrumbEmitted = true;
        try {
          process.stderr.write(
            `permissionMediator: consensus request ${record.requestId} ` +
              `for session ${record.sessionId} requires unanimity ` +
              `(votersAtIssue.size=${votersAtIssue.size}, default ` +
              `quorum=floor(M/2)+1=${votersAtIssue.size}); split votes ` +
              `will only resolve via permissionTimeoutMs (${timeoutMs}ms). ` +
              `This breadcrumb fires once per mediator lifetime; ` +
              `subsequent unanimity-required requests are silent.\n`,
          );
        } catch {
          // Stderr unavailable — silent drop.
        }
      }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          // Timer fires asynchronously — guard against the entry
          // already having been resolved by a vote OR replaced by a
          // fresh request that reused the same requestId after LRU
          // eviction. The identity check (`!== pending`) covers
          // both cases — `this.pending.has(requestId)` would mistake
          // a fresh request for a stale-timer fire on the old one.
          if (this.pending.get(record.requestId) !== pending) return;
          const firedAtMs = this.deps.now();
          // F3 Commit 2 — restore pre-F3 stderr breadcrumb (wenshao
          // review #4335 / 3270622304). Pre-F3 wrote "timed out
          // after Xms" directly to daemon stderr; F3 delegated to
          // the audit publisher, but production audit can still be
          // a no-op for embedded callers, so emit the breadcrumb
          // here unconditionally. Wrapped in try/catch because
          // process.stderr.write can synchronously throw on EPIPE
          // (closed stderr) — losing observability is preferable
          // to crashing the daemon's timer queue.
          try {
            process.stderr.write(
              `qwen serve: permission ${record.requestId} ` +
                `(session ${record.sessionId}) timed out after ${timeoutMs}ms\n`,
            );
          } catch {
            // Stderr unavailable — drop the breadcrumb and continue.
          }
          this.safeAudit(() => this.deps.audit.recordTimeout(record));
          this.resolveEntry(
            pending,
            { kind: 'cancelled', reason: 'timeout' },
            {
              type: 'timeout',
              issuedAtMs: pending.issuedAtMs,
              timeoutMs: pending.timeoutMs,
              firedAtMs,
            },
            undefined,
          );
        }, timeoutMs);
        // Use a `'unref' in` guard rather than `as { unref?: ... }`
        // so the type narrowing is enforced rather than asserted.
        const t = pending.timer;
        if (
          t !== undefined &&
          typeof t === 'object' &&
          'unref' in t &&
          typeof (t as { unref: unknown }).unref === 'function'
        ) {
          (t as { unref: () => void }).unref();
        }
      }
      // === END SYNCHRONOUS REGISTER ===
    });
  }

  vote(vote: PermissionVote): PermissionVoteOutcome {
    const pending = this.pending.get(vote.requestId);

    if (!pending) {
      const prior = this.resolved.get(vote.requestId);
      if (prior && prior.sessionId === vote.sessionId) {
        // Re-emit `permission_already_resolved` so late SSE
        // subscribers see the conclusion. C2 (Commit 3 review):
        // pre-F3 `publishPermissionAlreadyResolved` did NOT stamp
        // `originatorClientId` on this event. Preserve byte-for-byte
        // — `httpAcpBridge.test.ts:2880` asserts
        // `originatorClientId: undefined`. Resolver attribution lives
        // in the audit log via `decisionReason.resolverClientId`,
        // not on the wire frame.
        const optionId =
          prior.resolution.kind === 'option'
            ? prior.resolution.optionId
            : CANCEL_VOTE_SENTINEL;
        this.safeEmit(prior.sessionId, {
          type: 'permission_already_resolved',
          data: {
            requestId: prior.requestId,
            sessionId: prior.sessionId,
            outcome: this.toAcpOutcome(prior.resolution),
          },
        });
        return { kind: 'already_resolved', resolvedOptionId: optionId };
      }
      return { kind: 'unknown_request' };
    }

    if (pending.sessionId !== vote.sessionId) {
      return { kind: 'unknown_request' };
    }

    // Voter cancel — bypasses policy dispatch; resolves cancelled
    // regardless of who voted (the bridge already validated `clientId`).
    if (vote.optionId === CANCEL_VOTE_SENTINEL) {
      const outcome: PermissionVoteOutcome = {
        kind: 'resolved',
        resolvedOptionId: CANCEL_VOTE_SENTINEL,
      };
      // Audit ordering invariant: `voted` before `resolved`.
      this.safeAudit(() =>
        this.deps.audit.recordVoted(this.toRecord(pending), vote, outcome),
      );
      this.resolveEntry(
        pending,
        { kind: 'cancelled', reason: 'agent_cancelled' },
        {
          type: 'voter-cancelled',
          resolverClientId: vote.clientId,
        },
        vote.clientId,
      );
      return outcome;
    }

    // Validate optionId against the agent-declared allow set. Throws
    // `InvalidPermissionOptionError`; the route layer maps to 400.
    if (!pending.allowedOptionIds.has(vote.optionId)) {
      throw new InvalidPermissionOptionError(vote.requestId, vote.optionId);
    }

    // Per-policy handlers own their own audit.recordVoted call to
    // preserve the `voted → resolved` ordering invariant (the
    // resolveEntry call inside each handler is what triggers the
    // `resolved` audit record).
    switch (pending.policy) {
      case 'first-responder':
        return this.voteFirstResponder(pending, vote);
      case 'designated':
        return this.voteDesignated(pending, vote);
      case 'consensus':
        return this.voteConsensus(pending, vote);
      case 'local-only':
        return this.voteLocalOnly(pending, vote);
      default: {
        // Exhaustiveness — a future PermissionPolicy literal added
        // without a case here will fail compilation at this line.
        const _exhaustive: never = pending.policy;
        void _exhaustive;
        throw new Error(`Unknown permission policy "${pending.policy}"`);
      }
    }
  }

  forgetSession(sessionId: string): void {
    // Snapshot the keys to avoid mutating the Map during iteration.
    const requestIds: string[] = [];
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) requestIds.push(id);
    }
    for (const id of requestIds) {
      // Defensive — JS is single-threaded so today this re-lookup
      // can't return a different entry, but resolveEntry's emit /
      // audit calls fire synchronously and a future maintainer
      // adding `await` or a re-entrant hook would invalidate the
      // assumption. The Map.get is cheap insurance and not dead
      // code if the loop body is ever modified.
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.resolveEntry(
        pending,
        { kind: 'cancelled', reason: 'session_closed' },
        { type: 'session-closed' },
        undefined,
      );
    }
  }

  /**
   * Lookup the sessionId for a given requestId. Used by the legacy
   * `bridge.respondToPermission(requestId, ...)` route which doesn't
   * carry a sessionId in the URL. NOT part of the
   * `PermissionMediator` interface contract — bridge holds the
   * concrete class reference and calls this directly.
   */
  peekSessionFor(requestId: string): string | undefined {
    const pending = this.pending.get(requestId);
    if (pending) return pending.sessionId;
    const prior = this.resolved.get(requestId);
    return prior?.sessionId;
  }

  /**
   * Daemon-wide in-flight pending count for diagnostics. The bridge
   * exposes this through its `pendingPermissionCount` getter so
   * operators can spot stuck FIFOs without reaching into mediator
   * internals. NOT part of the `PermissionMediator` interface
   * contract.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  // ===========================================================
  // Per-policy vote handlers
  // ===========================================================

  private voteFirstResponder(
    pending: MediatorPending,
    vote: PermissionVote,
  ): PermissionVoteOutcome {
    // Bit-for-bit preservation of pre-F3 behavior: any validated voter
    // (the route layer already enforced clientId / optionId / session
    // ownership) wins immediately.
    const outcome: PermissionVoteOutcome = {
      kind: 'resolved',
      resolvedOptionId: vote.optionId,
    };
    // Ordering invariant: `voted` audit record fires BEFORE `resolved`
    // (resolveEntry triggers `resolved`).
    this.safeAudit(() =>
      this.deps.audit.recordVoted(this.toRecord(pending), vote, outcome),
    );
    this.resolveEntry(
      pending,
      {
        kind: 'option',
        optionId: vote.optionId,
        ...(vote.metadata ? { metadata: vote.metadata } : {}),
      },
      {
        type: 'first-responder',
        resolverClientId: vote.clientId,
      },
      vote.clientId,
    );
    return outcome;
  }

  private voteDesignated(
    pending: MediatorPending,
    vote: PermissionVote,
  ): PermissionVoteOutcome {
    // Anonymous prompt (originator undefined): fall back to
    // first-responder. Documented relaxation — strict deployments
    // must mandate `X-Qwen-Client-Id` on the prompt route. F3 plan
    // §"Designated fallback" explains the rationale.
    if (pending.originatorClientId === undefined) {
      return this.voteFirstResponder(pending, vote);
    }
    if (vote.clientId !== pending.originatorClientId) {
      // Reject — voter is not the prompt originator.
      this.safeAudit(() =>
        this.deps.audit.recordForbidden(
          this.toRecord(pending),
          vote,
          'designated_mismatch',
        ),
      );
      this.safeEmit(pending.sessionId, {
        type: 'permission_forbidden',
        data: {
          requestId: pending.requestId,
          sessionId: pending.sessionId,
          ...(vote.clientId !== undefined ? { clientId: vote.clientId } : {}),
          reason: 'designated_mismatch',
        },
        // N3 — new events stamp prompt originator (NOT voter).
        ...(pending.originatorClientId !== undefined
          ? { originatorClientId: pending.originatorClientId }
          : {}),
      });
      this.writeForbiddenStderr(
        pending,
        vote,
        'designated_mismatch (voter is not the prompt originator)',
      );
      return { kind: 'forbidden', reason: 'designated_mismatch' };
    }
    // Originator's vote — resolve immediately (semantically a
    // first-responder for the designated voter).
    const outcome: PermissionVoteOutcome = {
      kind: 'resolved',
      resolvedOptionId: vote.optionId,
    };
    this.safeAudit(() =>
      this.deps.audit.recordVoted(this.toRecord(pending), vote, outcome),
    );
    this.resolveEntry(
      pending,
      {
        kind: 'option',
        optionId: vote.optionId,
        ...(vote.metadata ? { metadata: vote.metadata } : {}),
      },
      {
        type: 'designated-originator',
        originatorClientId: pending.originatorClientId,
      },
      vote.clientId,
    );
    return outcome;
  }

  private voteConsensus(
    pending: MediatorPending,
    vote: PermissionVote,
  ): PermissionVoteOutcome {
    // Voter must be in the issue-time snapshot. Anonymous voters
    // and clients that connected AFTER the prompt issued are
    // rejected.
    //
    // TODO(forward-compat): DeepSeek review #4335 / 3271627459 — the
    // `designated_mismatch` reason code is overloaded here for "not
    // in voter set" (consensus-specific) AND for "voter is not the
    // prompt originator" (designated-policy semantics). Both cases
    // surface the same string on the wire (`permission_forbidden`
    // SSE) and the same audit reason. A future PR can split these
    // into distinct reason codes (e.g. `voter_not_eligible`,
    // `not_originator`) once an SDK consumer needs to disambiguate
    // them — until then, F3 v1 keeps the overload to avoid
    // protocol churn while semantics stabilize.
    if (
      vote.clientId === undefined ||
      !pending.votersAtIssue.has(vote.clientId)
    ) {
      this.safeAudit(() =>
        this.deps.audit.recordForbidden(
          this.toRecord(pending),
          vote,
          'designated_mismatch',
        ),
      );
      this.safeEmit(pending.sessionId, {
        type: 'permission_forbidden',
        data: {
          requestId: pending.requestId,
          sessionId: pending.sessionId,
          ...(vote.clientId !== undefined ? { clientId: vote.clientId } : {}),
          reason: 'designated_mismatch',
        },
        ...(pending.originatorClientId !== undefined
          ? { originatorClientId: pending.originatorClientId }
          : {}),
      });
      this.writeForbiddenStderr(
        pending,
        vote,
        'designated_mismatch (voter not in consensus votersAtIssue snapshot)',
      );
      return { kind: 'forbidden', reason: 'designated_mismatch' };
    }

    // Idempotent re-vote: if this clientId already cast a vote (any
    // option), keep the original. Return `recorded` with the current
    // votesNeeded; do NOT emit a partial_vote frame (the tally hasn't
    // changed).
    //
    // Wenshao review #4335 / 3271041464 — the audit entry must
    // reflect the ORIGINALLY-recorded optionId (the one in the
    // tally), not the new attempt. Otherwise the audit ring shows
    // `client_X voted for option_B` while the tally has client_X in
    // option_A's bucket; an operator reading the ring would see a
    // vote that never counted toward quorum. Look up the original
    // option from the tally and substitute it into the audit
    // record.
    for (const [originalOptionId, set] of pending.tallies.entries()) {
      if (vote.clientId !== undefined && set.has(vote.clientId)) {
        const outcome: PermissionVoteOutcome = {
          kind: 'recorded',
          votesNeeded: this.votesNeededFor(pending),
        };
        this.safeAudit(() =>
          this.deps.audit.recordVoted(
            this.toRecord(pending),
            { ...vote, optionId: originalOptionId },
            outcome,
          ),
        );
        return outcome;
      }
    }

    // Record the vote.
    let bucket = pending.tallies.get(vote.optionId);
    if (!bucket) {
      bucket = new Set<string>();
      pending.tallies.set(vote.optionId, bucket);
    }
    bucket.add(vote.clientId);

    const quorum = this.consensusQuorumFor(pending);
    if (bucket.size >= quorum) {
      const outcome: PermissionVoteOutcome = {
        kind: 'resolved',
        resolvedOptionId: vote.optionId,
      };
      this.safeAudit(() =>
        this.deps.audit.recordVoted(this.toRecord(pending), vote, outcome),
      );
      this.resolveEntry(
        pending,
        {
          kind: 'option',
          optionId: vote.optionId,
          ...(vote.metadata ? { metadata: vote.metadata } : {}),
        },
        {
          type: 'consensus-quorum',
          resolvedOptionId: vote.optionId,
          quorum,
          tally: bucket.size,
        },
        vote.clientId,
      );
      return outcome;
    }

    // Recorded — emit partial_vote progress + return votesNeeded.
    const outcome: PermissionVoteOutcome = {
      kind: 'recorded',
      votesNeeded: this.votesNeededFor(pending),
    };
    this.safeAudit(() =>
      this.deps.audit.recordVoted(this.toRecord(pending), vote, outcome),
    );
    this.safeEmit(pending.sessionId, {
      type: 'permission_partial_vote',
      data: {
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        votesReceived: this.totalTalliedFor(pending),
        votesNeeded: outcome.votesNeeded,
        quorum,
        optionTallies: this.optionTalliesFor(pending),
      },
      ...(pending.originatorClientId !== undefined
        ? { originatorClientId: pending.originatorClientId }
        : {}),
    });
    return outcome;
  }

  /**
   * Vote dispatch for `local-only` policy: only `fromLoopback: true`
   * voters can resolve a permission.
   *
   * **Cancel-sentinel asymmetry** (wenshao review #4335 / 3271978336).
   * `vote()` recognizes the cancel sentinel BEFORE calling this
   * method (cross-policy escape hatch — see the
   * `CANCEL_VOTE_SENTINEL` JSDoc for the rationale), so a remote
   * voter under `local-only` CAN abort a pending permission via
   * `{outcome:'cancelled'}` even though they cannot RESOLVE one. The
   * settings-side description for `local-only` and the F3 plan call
   * out this gap explicitly. Operators who want strict-cancel-too
   * semantics must (a) deploy a dedicated daemon process at
   * loopback bind, OR (b) wait for the follow-up PR that lifts
   * cancel into per-policy gating; F3 v1 keeps the current
   * cross-policy cancel for consistency with first-responder /
   * designated / consensus.
   */
  private voteLocalOnly(
    pending: MediatorPending,
    vote: PermissionVote,
  ): PermissionVoteOutcome {
    if (!vote.fromLoopback) {
      this.safeAudit(() =>
        this.deps.audit.recordForbidden(
          this.toRecord(pending),
          vote,
          'remote_not_allowed',
        ),
      );
      this.safeEmit(pending.sessionId, {
        type: 'permission_forbidden',
        data: {
          requestId: pending.requestId,
          sessionId: pending.sessionId,
          ...(vote.clientId !== undefined ? { clientId: vote.clientId } : {}),
          reason: 'remote_not_allowed',
        },
        ...(pending.originatorClientId !== undefined
          ? { originatorClientId: pending.originatorClientId }
          : {}),
      });
      this.writeForbiddenStderr(
        pending,
        vote,
        'remote_not_allowed (local-only policy; vote not from loopback)',
      );
      return { kind: 'forbidden', reason: 'remote_not_allowed' };
    }
    const outcome: PermissionVoteOutcome = {
      kind: 'resolved',
      resolvedOptionId: vote.optionId,
    };
    this.safeAudit(() =>
      this.deps.audit.recordVoted(this.toRecord(pending), vote, outcome),
    );
    this.resolveEntry(
      pending,
      {
        kind: 'option',
        optionId: vote.optionId,
        ...(vote.metadata ? { metadata: vote.metadata } : {}),
      },
      {
        type: 'local-only-loopback',
        resolverClientId: vote.clientId,
      },
      vote.clientId,
    );
    return outcome;
  }

  // ===========================================================
  // Consensus tally helpers
  // ===========================================================

  /**
   * Compute the quorum size for a `consensus` request. Default
   * `floor(M/2) + 1` of `votersAtIssue.size`; overridden by
   * `deps.consensusQuorum` when set, capped to `M` so an operator
   * misconfig (N > M) can't deadlock.
   *
   * Wenshao review #4335 / 3271185594 — when the cap fires, write
   * a one-time stderr breadcrumb per request so operators don't
   * have to diff their `policy.consensusQuorum` against
   * `votersAtIssue.size` manually to understand why a quorum
   * resolved sooner than configured. Tracked on `MediatorPending`
   * so the breadcrumb fires once even though `consensusQuorumFor`
   * may be called multiple times per request (vote tally + final
   * resolution).
   */
  private consensusQuorumFor(pending: MediatorPending): number {
    const m = pending.votersAtIssue.size;
    const override = this.deps.consensusQuorum;
    if (override !== undefined) {
      const capped = Math.min(override, Math.max(m, 1));
      if (capped < override && !pending.consensusQuorumCapNoted) {
        pending.consensusQuorumCapNoted = true;
        try {
          process.stderr.write(
            `permissionMediator: consensusQuorum override ${override} ` +
              `capped to ${capped} (votersAtIssue.size=${m}) for ` +
              `request ${pending.requestId} session ${pending.sessionId}\n`,
          );
        } catch {
          // Stderr unavailable — silent drop.
        }
      }
      return capped;
    }
    return Math.max(1, Math.floor(m / 2) + 1);
  }

  private totalTalliedFor(pending: MediatorPending): number {
    let total = 0;
    for (const set of pending.tallies.values()) total += set.size;
    return total;
  }

  /**
   * `votesNeeded` = `quorum - max(tally per option)`. When no
   * option has any votes (degenerate; `permission_partial_vote`
   * is only emitted AFTER the first vote, so this should never
   * appear on the wire), returns `quorum` itself. Always ≥ 1
   * because the resolved-on-quorum path returns before this
   * helper runs.
   */
  private votesNeededFor(pending: MediatorPending): number {
    const quorum = this.consensusQuorumFor(pending);
    let max = 0;
    for (const set of pending.tallies.values()) {
      if (set.size > max) max = set.size;
    }
    return Math.max(quorum - max, 1);
  }

  private optionTalliesFor(pending: MediatorPending): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [optionId, set] of pending.tallies) {
      out[optionId] = set.size;
    }
    return out;
  }

  // ===========================================================
  // Resolution + cleanup
  // ===========================================================

  /**
   * Settle a pending entry. Cleanup order is hardened (N2 invariant):
   *   1. clearTimeout (so a timer can never fire on a half-cleaned entry).
   *   2. Delete from `pending` (state-first half — entry no longer
   *      reachable for new votes).
   *   3. emit wire `permission_resolved` (best-effort — emit failures
   *      do not block the Promise settle). MUST come before step 4
   *      so a re-entrant subscriber synchronously casting another
   *      vote during emit sees `pending === undefined && resolved
   *      === undefined` (silent false), matching pre-F3 ordering.
   *      See I5 (Commit 3 review) inline comment below.
   *   4. write to `resolved` (the second half of state move — late
   *      voters arriving after this see `permission_already_resolved`).
   *   5. audit.recordResolved (best-effort, same).
   *   6. Settle the Promise (LAST — callbacks running re-entrantly
   *      see consistent state).
   *
   * Wenshao review #4335 / 3272581553 — pre-fix the spec bundled
   * "delete pending + write resolved" into step 2 ahead of emit,
   * which contradicted the code (and the I5 comment). The fix
   * splits the two halves of the state move around the emit so
   * the spec faithfully describes the ordering invariant.
   *
   * @param resolverClientId  pre-F3 wire compat (O8 invariant): the
   *   `permission_resolved` SSE frame stamps this as
   *   `originatorClientId`. Pre-F3 `resolvePending` in
   *   `httpAcpBridge.ts:1518-1523` filled it from the voter's
   *   trusted clientId. We preserve byte-for-byte; vote-driven
   *   paths pass `vote.clientId` (which may be undefined for
   *   loopback no-header voters); timer + session-closed paths
   *   pass undefined (no voter).
   */
  private resolveEntry(
    pending: MediatorPending,
    resolution: PermissionResolution,
    decisionReason: PermissionDecisionReason | undefined,
    resolverClientId: string | undefined,
  ): void {
    if (this.pending.get(pending.requestId) !== pending) {
      // Already resolved on a different path (race between timer and
      // a final vote arriving in the same tick). Idempotent no-op.
      return;
    }
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    this.pending.delete(pending.requestId);
    // I5 (Commit 3 review) — emit the SSE `permission_resolved` BEFORE
    // writing to the resolved-LRU. Pre-F3 ordered emit-then-LRU and a
    // re-entrant subscriber synchronously casting another vote during
    // emit would have seen `pending === undefined && resolved ===
    // undefined` (silent false). Reversing that order would let the
    // re-entrant vote find the new LRU record and emit a redundant
    // `permission_already_resolved`. Match pre-F3 ordering for
    // wire-shape preservation.
    this.safeEmit(pending.sessionId, {
      type: 'permission_resolved',
      data: {
        requestId: pending.requestId,
        outcome: this.toAcpOutcome(resolution),
        // A4 (doudouOUC #4484 follow-up): `voterClientId` is the canonical,
        // unambiguous name for "who cast the resolving vote". The envelope
        // `originatorClientId` below carries the SAME value for pre-F3 wire
        // compat (it is semantically the voter on `permission_resolved`,
        // unlike on `permission_request` where it is the prompt originator).
        // Both are optional and omitted together for no-voter resolutions
        // (timer expiry / session-closed / loopback voter with no clientId).
        ...(resolverClientId !== undefined
          ? { voterClientId: resolverClientId }
          : {}),
      },
      // O8 — preserve pre-F3 behavior: voter's clientId is stamped
      // here (not the prompt originator's). Documented inconsistency
      // with `permission_request.originatorClientId` (which IS the
      // prompt originator); F3 does not fix the inconsistency to
      // avoid breaking the wire shape. A4 keeps it as a deprecated
      // alias of `data.voterClientId`.
      ...(resolverClientId !== undefined
        ? { originatorClientId: resolverClientId }
        : {}),
    });
    this.rememberResolved({
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      resolution,
      resolverClientId,
    });
    if (decisionReason !== undefined) {
      this.safeAudit(() =>
        this.deps.audit.recordResolved(
          this.toRecord(pending),
          resolution,
          decisionReason,
        ),
      );
    }
    pending.resolve(resolution);
  }

  private rememberResolved(record: PermissionResolutionRecord): void {
    if (!this.resolved.has(record.requestId)) {
      this.resolvedOrder.push(record.requestId);
    }
    this.resolved.set(record.requestId, record);
    while (this.resolvedOrder.length > MAX_RESOLVED_PERMISSION_RECORDS) {
      const oldest = this.resolvedOrder.shift();
      if (oldest !== undefined) this.resolved.delete(oldest);
    }
  }

  private safeEmit(
    sessionId: string,
    event: Omit<BridgeEvent, 'id' | 'v'>,
  ): void {
    try {
      this.deps.emit(sessionId, event);
    } catch (err) {
      // Emit failures (bus closed mid-shutdown) never block settle.
      // I4 (Commit 3 review) — surface as a stderr breadcrumb so
      // silent regressions in the host's emit path (e.g. a future
      // contract violation that throws instead of returning
      // undefined) don't disappear unnoticed.
      //
      // Wenshao review #4335 / 3271041461 — the breadcrumb itself
      // must be defensive. `process.stderr.write` can synchronously
      // throw on EPIPE during daemon shutdown; if it does, the
      // exception escapes `safeEmit` and propagates out of
      // `resolveEntry`, leaving the pending Promise unsettled
      // (request already deleted from `this.pending`). The agent
      // would hang on `requestPermission` until the timeout fires.
      // Mirror the timer callback's `try/catch` posture: losing
      // observability is preferable to a stuck Promise.
      try {
        process.stderr.write(
          `permissionMediator: emit failed for session=${JSON.stringify(sessionId)} type=${JSON.stringify(event.type)}: ${stringifyError(err)}\n`,
        );
      } catch {
        // Stderr unavailable — drop the breadcrumb and continue.
      }
    }
  }

  /**
   * DeepSeek review #4335 / 3271627457 — emit a stderr breadcrumb
   * for every vote rejection (the three forbidden paths in
   * voteDesignated / voteConsensus / voteLocalOnly). Mirrors the
   * timeout breadcrumb pattern: audit ring + SSE event are
   * transient observability surfaces (no v1 query route, SSE drops
   * on disconnect), so an operator tailing daemon stderr would see
   * zero indication of permission rejections without this.
   *
   * Wrapped in `try/catch` because `process.stderr.write` can
   * synchronously throw on EPIPE during shutdown — a stderr
   * unavailability must not propagate up through `safeEmit` /
   * `safeAudit` and break the resolveEntry cleanup ladder. Mirrors
   * the safeEmit/safeAudit defensive posture (see wenshao review
   * #4335 / 3271041461 for the matching hang scenario).
   */
  private writeForbiddenStderr(
    pending: MediatorPending,
    vote: PermissionVote,
    reasonDetail: string,
  ): void {
    try {
      const voterDescriptor =
        vote.clientId === undefined
          ? '<anonymous>'
          : JSON.stringify(vote.clientId);
      process.stderr.write(
        `qwen serve: permission ${pending.requestId} ` +
          `(session ${pending.sessionId}): vote rejected ` +
          `(${reasonDetail}) by client ${voterDescriptor}\n`,
      );
    } catch {
      // Stderr unavailable — drop the breadcrumb and continue.
    }
  }

  /**
   * Run an audit-publisher call defensively. The audit ring is
   * best-effort observability — a publisher exception (ring full,
   * host bug, transient I/O) MUST NOT throw out of `request()`,
   * `vote()`, or the timer callback. Without this guard, the
   * Promise the agent is awaiting would be left unsettled and the
   * pending entry would leak.
   *
   * Single helper used at all five audit call sites so the
   * "audit is best-effort" invariant is uniformly enforced (the
   * pre-fix asymmetric `try/catch` at 2 of 5 sites was a real
   * silent-failure hole; see Commit 1 review notes).
   *
   * Wenshao review #4335 / 3272567323 — JSDoc was previously
   * stacked above `writeForbiddenStderr` so IDE hover and API
   * doc generation showed the wrong attribution. Moved adjacent
   * to its actual definition.
   */
  private safeAudit(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // Wenshao review #4335 / 3271041461 — see the matching
      // try/catch on the breadcrumb in `safeEmit`. The audit-failure
      // breadcrumb must not itself crash the safe wrapper, or the
      // `resolveEntry` cleanup ladder could leave the pending
      // Promise unsettled.
      try {
        process.stderr.write(
          `permissionMediator: audit publisher threw: ${stringifyError(err)}\n`,
        );
      } catch {
        // Stderr unavailable — drop the breadcrumb and continue.
      }
    }
  }

  private toRecord(pending: MediatorPending): PermissionRequestRecord {
    return {
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      originatorClientId: pending.originatorClientId,
      allowedOptionIds: pending.allowedOptionIds,
      issuedAtMs: pending.issuedAtMs,
    };
  }

  private toAcpOutcome(
    resolution: PermissionResolution,
  ): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
    if (resolution.kind === 'option') {
      return { outcome: 'selected', optionId: resolution.optionId };
    }
    return { outcome: 'cancelled' };
  }
}
