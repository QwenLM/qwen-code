/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonClient } from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';
import type { Policy } from './loader.js';
import {
  evaluate,
  type ToolCallContext,
  type QuotaOracle,
} from './evaluator.js';
import type { QuotaStore } from './quotas.js';
import { selectAllowOnceOptionId } from '../permissionOptions.js';

/** Safe optional read of a string field from an unknown record. */
function readString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

/** Safe optional read of a nested record (plain object) field. */
function readRecord(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = obj[key];
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Evaluates `permission_request` events against a {@link Policy} and, on an
 * `allow`/`deny` decision, auto-casts the cycle-6 nested vote against the
 * daemon. `prompt` (the fail-closed default) and any fail-safe miss return
 * false so the caller falls through to push.
 *
 * Security contract:
 * - **Fail-closed:** empty/absent policy → evaluator returns `prompt` → never
 *   votes → behavior identical to pre-policy.
 * - **Fail-safe:** an `allow`/`deny` with no usable `requestId` (or, for allow,
 *   no `approveOptionId`) → DO NOT vote; return false. Never fabricate an id.
 * - **Never throws:** every daemon call is wrapped; a thrown/false vote audits
 *   `voted:false` and returns false (fall through to push).
 * - **Audit hygiene:** `policy_decision` detail carries only
 *   `{requestId, action, ruleId?, voted, decisionSource}` — NEVER the tool
 *   args/paths/prompt. `decisionSource` is `'policy'|'default'` (a fixed token).
 */
export class PolicyEnforcer {
  constructor(
    private readonly daemon: DaemonClient,
    private policy: Policy,
    private readonly audit?: AuditRecorder,
    /**
     * Optional rolling-window quota store (cycle 43). When present, a matched
     * `maxPerWindow` rule with room auto-allows (and is consumed after a
     * successful vote); exhausted falls through; absent → maxPerWindow stays a
     * prompt (the pre-quota behavior). The store's `limitsFor` must reflect the
     * active policy (hot-reload, Phase 3, would rebuild it on `setPolicy`).
     */
    private readonly quota?: QuotaStore,
    /** Injected clock (epoch-ms) for deterministic tests. */
    private readonly nowFn: () => number = Date.now,
  ) {}

  /** Swap the active policy (for a future hot-reload). */
  setPolicy(policy: Policy): void {
    this.policy = policy;
  }

  /**
   * Evaluate a permission_request event and, on allow/deny, cast the vote.
   * Returns true iff the event was auto-handled (caller should NOT push).
   * Never throws.
   */
  async handlePermission(
    sessionId: string,
    event: { type: string; data: unknown },
  ): Promise<boolean> {
    if (event.type !== 'permission_request') return false;

    // Defensive ctx extraction (design §2): event.data shape is untrusted.
    const data: Record<string, unknown> =
      typeof event.data === 'object' &&
      event.data !== null &&
      !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : {};
    const toolCall = readRecord(data, 'toolCall');
    const tool =
      (toolCall &&
        (readString(toolCall, 'name') ?? readString(toolCall, 'title'))) ||
      readString(data, 'toolName') ||
      '';
    const args = toolCall?.['input'] ?? toolCall?.['args'] ?? toolCall ?? {};
    const requestId = readString(data, 'requestId');
    // The ONE-TIME approve option (kind 'allow_once'), never options[0] — that
    // is typically 'allow_always', which would persist a standing grant / flip
    // the session to auto-edit, escalating a single policy match into a blanket
    // bypass of all future gateway evaluation. Absent → we do NOT vote (below).
    const approveOptionId = selectAllowOnceOptionId(data['options']);

    // One instant for the whole decision: the quota CHECK (in evaluate) and the
    // post-vote CONSUME prune against the SAME window boundary.
    const nowMs = this.nowFn();
    const now = new Date(nowMs);
    const oracle: QuotaOracle | undefined = this.quota
      ? { state: (id, ms) => this.quota!.state(id, ms) }
      : undefined;

    const ctx: ToolCallContext = { tool, args };
    const d = evaluate(this.policy, ctx, now, oracle);

    if (d.action === 'allow') {
      if (requestId && approveOptionId) {
        try {
          const ok = await this.daemon.respondToSessionPermission(
            sessionId,
            requestId,
            { outcome: { outcome: 'selected', optionId: approveOptionId } },
          );
          if (ok) {
            // Consume the quota ONLY now — after a successful vote (the gateway's
            // commit-to-invoke, design.md:68) — and ONLY for a tracked quota rule
            // (remaining !== undefined), so non-quota allows don't churn the WAL.
            let quotaRemaining: number | undefined;
            if (
              this.quota &&
              d.ruleId &&
              this.quota.remaining(d.ruleId, nowMs) !== undefined
            ) {
              await this.quota.consume(d.ruleId, nowMs);
              quotaRemaining = this.quota.remaining(d.ruleId, nowMs);
            }
            void this.audit?.record({
              action: 'policy_decision',
              target: sessionId,
              detail: {
                requestId,
                action: 'allow',
                ruleId: d.ruleId,
                voted: true,
                decisionSource: d.source,
                ...(quotaRemaining !== undefined ? { quotaRemaining } : {}),
              },
            });
            return true;
          }
        } catch {
          // Swallow — fall through to the fail-safe below.
        }
      }
      void this.audit?.record({
        action: 'policy_decision',
        target: sessionId,
        detail: {
          requestId,
          action: 'allow',
          ruleId: d.ruleId,
          voted: false,
          decisionSource: d.source,
        },
      });
      return false;
    }

    if (d.action === 'deny') {
      if (requestId) {
        try {
          const ok = await this.daemon.respondToSessionPermission(
            sessionId,
            requestId,
            { outcome: { outcome: 'cancelled' } },
          );
          if (ok) {
            void this.audit?.record({
              action: 'policy_decision',
              target: sessionId,
              detail: {
                requestId,
                action: 'deny',
                ruleId: d.ruleId,
                voted: true,
                decisionSource: d.source,
              },
            });
            return true;
          }
        } catch {
          // Swallow — fall through to the fail-safe below.
        }
      }
      void this.audit?.record({
        action: 'policy_decision',
        target: sessionId,
        detail: {
          requestId,
          action: 'deny',
          ruleId: d.ruleId,
          voted: false,
          decisionSource: d.source,
        },
      });
      return false;
    }

    // prompt (incl. fail-closed default): never vote, fall through to push.
    // decisionSource discriminates a rule-caused prompt ('policy') from the
    // no-rule-match default fall-through ('default') — which `ruleId` cannot,
    // since a matched rule may be id-less.
    void this.audit?.record({
      action: 'policy_decision',
      target: sessionId,
      detail: {
        requestId,
        action: 'prompt',
        ruleId: d.ruleId,
        voted: false,
        decisionSource: d.source,
      },
    });
    return false;
  }
}
