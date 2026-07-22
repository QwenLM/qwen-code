/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RcScope } from '../scopes.js';
import { APPROVE, SESSION_READ } from '../scopes.js';
import type { TokenStore } from '../tokenStore.js';
import type { PushStore } from '../pushStore.js';
import type { AuditRecorder } from '../auditLog.js';
import type { SnoozeStore } from '../routing/snooze.js';
import type { WorkingDeviceTracker } from '../routing/workingDevice.js';
import type { RoutingMatcher, RoutingEvent } from '../routing/rules.js';
import { parseTimeOfDay, isWithinTimeOfDay } from '../policy/conditions.js';
import type { PushSender } from './sender.js';
import {
  buildPayload,
  buildDigestPayload,
  type PushPayload,
} from './payload.js';
import { type PushRateLimiter, DEFAULT_MAX_PER_HOUR } from './rateLimiter.js';
import type { PushCoalescer } from './coalescer.js';
import type { PushDigest, DigestSummary } from './digest.js';
import { QuietDigestWatcher } from './quietDigestWatcher.js';
import type {
  ApnsStore,
  ApnsSubscriptionRecord,
} from '../nativePush/apnsStore.js';
import type { OwnerEventBus } from '../ownerEvents.js';

/**
 * Event kinds that are considered "critical" and bypass the snooze floor.
 * These events MUST always be deliverable regardless of snooze state.
 */
export const SNOOZE_BYPASS_KINDS = new Set([
  'session.died',
  'policy.deny',
  // A blocked agent needs a human — quiet-hours/snooze bypass (design:
  // "agent_blocked is a candidate critical kind").
  'agent.blocked',
]);

/**
 * The APNs send seam the notifier drives (satisfied by `ApnsSender`). Kept
 * structural so the notifier needn't import the http2 transport. The orphan
 * guard (`isTokenLive`) and 410/400 removal + 429/5xx backoff live in the sender.
 */
export interface ApnsNotifier {
  send(sub: ApnsSubscriptionRecord, payload: PushPayload): Promise<unknown>;
}

/**
 * Per-kind required scope. A subscription only receives a kind if its owning
 * token holds the mapped scope; scope mismatches are silently skipped (no audit
 * noise, per the design).
 */
export const KIND_SCOPE: Record<string, RcScope> = {
  'permission.required': APPROVE,
  'task.completed': SESSION_READ,
  'agent.spawned': SESSION_READ,
  'agent.completed': SESSION_READ,
  'agent.failed': SESSION_READ,
  'agent.blocked': SESSION_READ,
  'agent.cancelled': SESSION_READ,
  'workflow.completed': SESSION_READ,
  'workflow.failed': SESSION_READ,
  'session.rewound': SESSION_READ,
  'review.completed': SESSION_READ,
  'review.failed': SESSION_READ,
};

/**
 * Scope-filtered fan-out of push payloads. The notifier resolves each
 * subscription's owning-token scopes via TokenStore.scopesFor and only calls
 * the (best-effort, never-throwing) sender when the scope gate passes.
 */
export class PushNotifier {
  constructor(
    private readonly tokens: TokenStore,
    private readonly store: PushStore,
    private readonly sender: PushSender,
    private readonly snooze?: SnoozeStore,
    private readonly audit?: AuditRecorder,
    private readonly workingDevice?: WorkingDeviceTracker,
    private routing?: RoutingMatcher,
    private readonly rateLimiter?: PushRateLimiter,
    private readonly coalescer?: PushCoalescer,
    private readonly digest?: PushDigest,
    /**
     * APNs transport for the iOS native shell (add-native-mobile-shells). When
     * present, `notify` fans the SAME payload out to APNs device subscriptions
     * through the token-level + global gates (see {@link notifyApns}). Absent
     * (no loadable P-8 key) → APNs is simply not delivered.
     */
    private readonly apns?: { store: ApnsStore; sender: ApnsNotifier },
    /**
     * Owner event bus for `routing_decision` SSE events. When present, the
     * notifier emits one `routing_decision` frame per evaluated event — before
     * any send — so an operator can observe routing behavior in real time.
     * Absent → no SSE emission (no behavioral change).
     */
    private readonly ownerBus?: OwnerEventBus,
  ) {}

  /** Edge-detector for the end-of-quiet-window digest flush (D4, cycle 75). */
  private readonly quietWatcher = new QuietDigestWatcher();

  /**
   * Hot-swap the routing matcher (notification-routing hot-reload). The swap is a
   * single synchronous field assignment; `notify` captures the matcher reference
   * ONCE at the top of a fan-out, so an event in flight when a reload lands keeps
   * evaluating under the rules it began with (spec: per-event atomicity).
   */
  setRouting(routing: RoutingMatcher | undefined): void {
    this.routing = routing;
  }

  /** Per-subscription summary of pushes suppressed during quiet hours (D4 read). */
  digestSummary(): DigestSummary[] {
    return this.digest?.summary() ?? [];
  }

  /**
   * End-of-quiet-window digest flush (webpush D4, cycle 75). Polled on a timer
   * by runServe: detects each subscription that just LEFT its quiet window and,
   * if anything was suppressed while it was quiet, sends one synthetic "while
   * you were away" digest push and resets that subscription's counts.
   *
   * Sends DIRECTLY via the sender, bypassing the gate chain by design: the
   * digest must bypass the QUIET gate (else it would suppress itself at the
   * boundary), and it is one low-frequency edge push so it intentionally does
   * not consume the rate-limit budget, coalesce, or honour an active snooze
   * (see the cycle-75 design). No cross-session leak — the counts only exist for
   * pushes that already passed the scope + session-lock gates when recorded.
   *
   * Sync and never throws: `sender.send` is best-effort/never-throwing and is
   * fired-and-forgotten, so a failed digest is simply lost (like all push)
   * rather than retried next window.
   */
  flushQuietDigests(now: Date = new Date()): void {
    if (!this.digest) return;
    const records = this.store.listAll();
    const byId = new Map(records.map((r) => [r.id, r] as const));
    this.quietWatcher.tick(records, now, (id) => {
      const summary = this.digest?.summaryFor(id) ?? null;
      // Reset whether or not we send so a single window-end never re-digests.
      this.digest?.forget(id);
      if (!summary || summary.total <= 0) return;
      const rec = byId.get(id);
      if (!rec) return;
      void this.sender.send(rec, buildDigestPayload(summary));
    });
  }

  /**
   * Forget a subscription's rolling-hour rate-limit window — called when the
   * subscription is deleted so its in-memory counter doesn't linger for the
   * process lifetime as subscriptions churn. A no-op when no limiter is
   * configured. The limiter is private to the notifier, so the DELETE route
   * reaches it through here rather than holding the limiter directly.
   */
  forgetRateLimit(subId: string): void {
    this.rateLimiter?.forget(subId);
    this.coalescer?.forget(subId);
    this.digest?.forget(subId);
  }

  /**
   * Fan a daemon event out to all scope-eligible subscriptions. `now` is
   * injected (default the wall clock) so quiet-hours can be tested against a
   * fixed instant, mirroring the policy evaluator's `evaluate(…, now)`.
   */
  async notify(
    event: { type: string; data: unknown },
    ctx: { sessionId: string; sessionName?: string },
    now: Date = new Date(),
  ): Promise<void> {
    const payload = buildPayload(event, ctx);
    if (!payload) return;
    // Capture the routing matcher ONCE: a hot-reload (setRouting) landing mid
    // fan-out must not swap the rules an in-flight event evaluates under
    // (per-event atomicity — spec "an in-flight event begun before reload
    // completes under the rules it began with").
    const routing = this.routing;
    // Routing gate: a snooze suppresses the WHOLE fan-out once, before any
    // send (snooze is event-global, not per-subscription). The /test path
    // (notifyToken) is deliberately NOT gated.
    // CRITICAL-KIND BYPASS: session.died and policy.deny bypass snooze so the
    // operator is always alerted when a session ends unexpectedly or a policy
    // denies a critical action, even during a snooze window.
    const isCriticalKind = SNOOZE_BYPASS_KINDS.has(payload.kind);
    if (!isCriticalKind && this.snooze?.isSnoozed(payload.kind)) {
      void this.audit?.record({
        action: 'push_suppressed',
        target: ctx.sessionId,
        detail: { kind: payload.kind, reason: 'snoozed' },
      });
      return;
    }
    // Routing drop gate (cycle 25): an operator routing.yaml `drop` rule
    // matching this event's kind/sessionTag suppresses the WHOLE fan-out, like
    // snooze — event-global, before any per-subscription work. Suppress-only:
    // a rule can never cause a push the gates below would have blocked. The
    // /test path (notifyToken) is NOT gated.
    const routingEv: RoutingEvent = {
      kind: payload.kind,
      sessionName: ctx.sessionName,
    };
    const dropRuleId = routing?.firstDrop(routingEv);
    // Emit routing_decision SSE event (before any send or return)
    if (this.ownerBus && routing !== undefined) {
      this.ownerBus.publish({
        type: 'routing_decision',
        kind: payload.kind,
        ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
        decision: dropRuleId ? 'drop' : 'pass',
        ...(dropRuleId ? { ruleId: dropRuleId } : {}),
        evaluatedAt: now.toISOString(),
      });
    }
    if (dropRuleId) {
      void this.audit?.record({
        action: 'push_suppressed',
        target: ctx.sessionId,
        detail: {
          kind: payload.kind,
          reason: 'routing_rule',
          ruleId: dropRuleId,
        },
      });
      return;
    }
    const need = KIND_SCOPE[payload.kind];
    if (!need) return;
    await Promise.all(
      this.store.listAll().map(async (r) => {
        const scopes = this.tokens.scopesFor(r.tokenId);
        if (!scopes || !scopes.includes(need)) return;
        // Session-lock confinement: a share token is locked to one session and
        // must never receive another session's notification metadata via push.
        // (scopesFor already drops expired tokens, so an expired share is gone.)
        const lock = this.tokens.sessionLockFor(r.tokenId);
        if (lock !== undefined && lock !== ctx.sessionId) return;
        // Per-subscription routing drop (cycle 33): an operator routing.yaml
        // rule carrying scopeIn/tokenIdsIn can suppress THIS subscription (by
        // its owning-token scopes or id) without silencing the whole fan-out.
        // Suppress-only and ahead of the implicit prefs/quiet/working gates so
        // "why no push" surfaces the explicit operator decision first. Same
        // reason token as the global drop, discriminated by subscriptionId.
        // Optional method → a matcher without it performs no per-sub drop.
        const perSubDrop = routing?.firstDropForSubscription?.(
          { kind: payload.kind, sessionName: ctx.sessionName },
          { tokenId: r.tokenId, scopes },
        );
        if (perSubDrop) {
          void this.audit?.record({
            action: 'push_suppressed',
            target: ctx.sessionId,
            detail: {
              kind: payload.kind,
              reason: 'routing_rule',
              ruleId: perSubDrop,
              subscriptionId: r.id,
            },
          });
          return;
        }
        // Per-subscription prefs filter (cycle 16): absent prefs → receive all;
        // a list → only those kinds; [] → nothing. Runs after scope + snooze.
        // AUDITED (cycle 53, reason:'prefs'): prefs is a suppression DECISION
        // ("we could have sent, we chose not to") like quiet_hours/
        // working_device on either side of it - NOT a permission/security
        // boundary like the silent scope/session-lock skips - so it belongs in
        // the "why no push" feed (R6). Per-event like its siblings (no firstDrop
        // dedup); as an always-on allowlist this is the highest-volume reason,
        // which is correct - the operator asked, the honest answer is "this
        // filter, repeatedly" (cycle-49 /rc/events backpressure absorbs it,
        // /rc/audit stays complete).
        if (r.prefs !== undefined && !r.prefs.includes(payload.kind)) {
          void this.audit?.record({
            action: 'push_suppressed',
            target: ctx.sessionId,
            detail: {
              kind: payload.kind,
              reason: 'prefs',
              subscriptionId: r.id,
            },
          });
          return;
        }
        // Quiet-hours skip (cycle 29): if `now` falls inside this
        // subscription's own quiet window, suppress (any kind — quiet hours
        // silences the device entirely). Runs after prefs, before
        // working-device. Fail-OPEN: an unparseable stored window (shouldn't
        // occur post-validation) is treated as "no quiet hours" → send.
        // parseTimeOfDay / isWithinTimeOfDay are internally try/caught and
        // never throw into the fan-out.
        // CRITICAL-KIND BYPASS: policy.deny and session.died bypass quiet hours
        // so the operator is always alerted for these critical events even when
        // a device is in a quiet window (spec: add-webpush-notifications §3).
        if (!isCriticalKind && r.quietHours) {
          const window = parseTimeOfDay(r.quietHours);
          if (window && isWithinTimeOfDay(window, now)) {
            void this.audit?.record({
              action: 'push_suppressed',
              target: ctx.sessionId,
              detail: {
                kind: payload.kind,
                reason: 'quiet_hours',
                subscriptionId: r.id,
              },
            });
            // Track what quiet hours suppressed for the D4 "while you were away"
            // digest (record-only; never affects delivery).
            this.digest?.record(r.id, payload.kind);
            return;
          }
        }
        // Working-device skip (this cycle): a permission.required push to a
        // subscription whose own token posted recently is redundant — you're
        // already on that device. permission.required-ONLY (completions et al.
        // are unaffected). Audited (so "why no push" is visible in the feed).
        if (
          payload.kind === 'permission.required' &&
          this.workingDevice?.isWorking(r.tokenId)
        ) {
          void this.audit?.record({
            action: 'push_suppressed',
            target: ctx.sessionId,
            detail: {
              kind: payload.kind,
              reason: 'working_device',
              subscriptionId: r.id,
            },
          });
          return;
        }
        // Same-kind coalescing (cycle 63): collapse a same-(kind,session) burst
        // to one push within the operator's window. Runs just BEFORE the rate
        // limiter so coalesced duplicates never consume the maxPerHour budget.
        // Leading-edge: the first push passes, repeats within the window are
        // suppressed. DISABLED by default (window 0) -> tryPass always true ->
        // no behavior change. Pure/total (never throws -> no try/catch). Audited
        // (so "why no push" stays visible) but NOT a new action (reason VALUE).
        if (this.coalescer) {
          const { allowed, firstSuppress } = this.coalescer.tryPass(
            r.id,
            payload.kind,
            ctx.sessionId,
            now.getTime(),
          );
          if (!allowed) {
            // Audit only the transition into coalescing (firstSuppress) so a
            // storm produces one row, not thousands (mirrors the rate limiter).
            if (firstSuppress) {
              void this.audit?.record({
                action: 'push_suppressed',
                target: ctx.sessionId,
                detail: {
                  kind: payload.kind,
                  reason: 'coalesced',
                  subscriptionId: r.id,
                },
              });
            }
            return;
          }
        }
        // Per-subscription rate limit (cycle 46): cap actual sends to maxPerHour
        // within a rolling hour (default 30). Runs LAST — only pushes that
        // survived every other gate count. tryConsume is pure/total (never
        // throws → no try/catch needed to keep the gate fail-open). Audit ONLY
        // the transition into the rate-limited state (firstDrop) so a storm
        // produces one row, not thousands. No limiter wired → no cap.
        if (this.rateLimiter) {
          // Defensive clamp upholds the FAIL-OPEN invariant: a stored cap that
          // is absent/0/negative/NaN (only reachable via a hand-edited store —
          // the route validates [1,240]) must fall back to the default, never
          // become a 0-cap that silently drops EVERY push.
          const cap =
            typeof r.maxPerHour === 'number' && r.maxPerHour > 0
              ? r.maxPerHour
              : DEFAULT_MAX_PER_HOUR;
          const { allowed, firstDrop } = this.rateLimiter.tryConsume(
            r.id,
            cap,
            now.getTime(),
          );
          if (!allowed) {
            if (firstDrop) {
              void this.audit?.record({
                action: 'push_rate_limited',
                target: ctx.sessionId,
                detail: { kind: payload.kind, subscriptionId: r.id },
              });
            }
            return;
          }
        }
        await this.sender.send(r, payload);
      }),
    );
    // Second transport: fan the same payload out to APNs device subscriptions
    // (add-native-mobile-shells), under the same global gates already applied
    // above (snooze, routing drop) plus the token-level gates re-checked per sub.
    await this.notifyApns(payload, ctx, routing, need, now);
  }

  /**
   * APNs fan-out for the iOS native shell. APNs subscriptions are token-bound but
   * carry NO per-subscription prefs/quiet/maxPerHour (the registration captures
   * none), so only the applicable gates run:
   *
   *  - **scope + session-lock** — confinement, MUST apply (a share token locked to
   *    one session must never receive another session's metadata via APNs);
   *  - **per-subscription routing drop** — an operator rule by token scopes/id;
   *  - **coalescing (D6)** — reuse the shared coalescer keyed by the APNs sub id.
   *
   * Intentionally NOT applied:
   *  - **prefs / quiet-hours** — no such field on an APNs record (nothing to read);
   *  - **working-device** — it keys on tokenId (so it *could* run), but its meaning
   *    ("you're looking at this device right now") doesn't transfer: a phone whose
   *    token merely polled recently is NOT foregrounded, and that is exactly when a
   *    `permission.required` push must still arrive — so suppressing here would
   *    defeat the point of mobile push;
   *  - **rate-limit** — a deliberate choice, not an oversight: the spec names only
   *    coalescing, and coalescing + the sender's 429 backoff cover bursts/abuse;
   *    the default-cap path exists if symmetry is wanted later.
   *
   * The orphan guard (a revoked token's device must never be delivered to) lives
   * in the sender's `isTokenLive`. Best-effort: `sender.send` never throws.
   */
  private async notifyApns(
    payload: PushPayload,
    ctx: { sessionId: string; sessionName?: string },
    routing: RoutingMatcher | undefined,
    need: RcScope,
    now: Date,
  ): Promise<void> {
    const apns = this.apns;
    if (!apns) return;
    await Promise.all(
      apns.store.listAll().map(async (rec) => {
        const scopes = this.tokens.scopesFor(rec.tokenId);
        if (!scopes || !scopes.includes(need)) return; // scope gate (silent)
        const lock = this.tokens.sessionLockFor(rec.tokenId);
        if (lock !== undefined && lock !== ctx.sessionId) return; // session-lock
        const perSubDrop = routing?.firstDropForSubscription?.(
          { kind: payload.kind, sessionName: ctx.sessionName },
          { tokenId: rec.tokenId, scopes },
        );
        if (perSubDrop) {
          void this.audit?.record({
            action: 'push_suppressed',
            target: ctx.sessionId,
            detail: {
              kind: payload.kind,
              reason: 'routing_rule',
              ruleId: perSubDrop,
              subscriptionId: rec.id,
            },
          });
          return;
        }
        if (this.coalescer) {
          const { allowed, firstSuppress } = this.coalescer.tryPass(
            rec.id,
            payload.kind,
            ctx.sessionId,
            now.getTime(),
          );
          if (!allowed) {
            if (firstSuppress) {
              void this.audit?.record({
                action: 'push_suppressed',
                target: ctx.sessionId,
                detail: {
                  kind: payload.kind,
                  reason: 'coalesced',
                  subscriptionId: rec.id,
                },
              });
            }
            return;
          }
        }
        // Best-effort, like the web-push sender: the LIVE APNs transport REJECTS
        // on a connection/TLS/DNS error (Apple unreachable — not a 429/5xx, so the
        // sender's retry loop never sees it). Swallow it here so a transient Apple
        // outage can never reject `notify()` (web-push already sent above) or
        // surface as an unhandled rejection. Audited as push_send_failed.
        await apns.sender.send(rec, payload).catch(() => {
          void this.audit?.record({
            action: 'push_send_failed',
            target: ctx.sessionId,
            detail: {
              kind: payload.kind,
              transport: 'apns',
              subscriptionId: rec.id,
            },
          });
        });
      }),
    );
  }

  /** Send a synthetic payload to one token's own subscriptions (test route). */
  async notifyToken(tokenId: string, payload: PushPayload): Promise<void> {
    const need = KIND_SCOPE[payload.kind];
    if (!need) return;
    const scopes = this.tokens.scopesFor(tokenId);
    if (!scopes || !scopes.includes(need)) return;
    await Promise.all(
      this.store.listFor(tokenId).map((r) => this.sender.send(r, payload)),
    );
  }
}
