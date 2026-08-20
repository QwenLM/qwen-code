/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { OWNER, hasScope } from '../scopes.js';
import {
  sanitizeReviewTarget,
  TERMINAL_REVIEW_STATUSES,
  type ReviewRecord,
  type ReviewRegistry,
  type ReviewStatus,
  type ReviewTarget,
} from '../reviews/reviewRegistry.js';
import type { ReviewLifecycle } from '../reviews/reviewLifecycle.js';
import type { ReviewPermissionBridge } from '../reviews/reviewPermissionBridge.js';
import { PromptQueue } from './promptQueue.js';

const REVIEW_STATUSES: readonly ReviewStatus[] = [
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'orphaned',
];

/**
 * Dependencies for the review control-plane routes (D.2 trigger; D.3 reuses
 * this shape for list/detail/cancel). The `bridge` and `lifecycle` are
 * constructed by the boot wiring (server.ts) and injected here — the trigger
 * saga OWNS neither, it only drives `open`/`close` and lifecycle emits.
 */
export interface ReviewRoutesDeps {
  daemon: SessionDaemon;
  registry: ReviewRegistry;
  lifecycle: ReviewLifecycle;
  bridge: ReviewPermissionBridge;
  audit?: AuditRecorder;
  /** Read-time cost rollup keyed by sessionId (used by D.3 list/detail). */
  costFor?: (sessionId: string) => number | undefined;
  /**
   * Per-session FIFO serialiser for daemon.prompt() calls — SHARED with the
   * prompt/agent routes so a review's `/review` prompt never races another
   * turn on the same session. Injected by tests; defaults to a module-local
   * shared queue.
   */
  promptQueue?: PromptQueue;
  /**
   * ms to wait for an EARLY prompt rejection before accepting the trigger.
   * daemon.prompt() is long-lived (resolves at end of turn), so a bounded
   * race distinguishes "prompt SEND failed" from "turn running". Default 1000;
   * tests inject 25.
   */
  promptAcceptWindowMs?: number;
}

/** Fallback queue when a route set is wired without an explicit promptQueue. */
const defaultPromptQueue = new PromptQueue();

/** ms to wait for the per-session prompt slot before giving up (generous —
 * review turns are long-lived; this only guards against a stuck prior turn). */
const PROMPT_QUEUE_WAIT_MS = 10 * 60 * 1000;

/**
 * Send the `/review` prompt through the per-session FIFO slot so it never
 * reaches daemon.prompt() concurrently with another turn on the same session
 * (mirror of routes/agents.ts's `sendSerializedPrompt`).
 */
function sendSerializedPrompt(
  deps: ReviewRoutesDeps,
  sessionId: string,
  text: string,
): Promise<unknown> {
  const queue = deps.promptQueue ?? defaultPromptQueue;
  return (async () => {
    const release = await queue.acquire(sessionId, PROMPT_QUEUE_WAIT_MS);
    try {
      return await deps.daemon.prompt(sessionId, {
        prompt: [{ type: 'text', text }],
      });
    } finally {
      release();
    }
  })();
}

/**
 * Parse the wire `target` (`{pr:number}` | `{path:string}` | `{local:true}`,
 * default local when absent) into a `ReviewTarget`. Returns `null` for any
 * malformed shape — a `pr` MUST be a positive integer, a `path` a non-empty
 * string — so the caller can 400 `invalid_target`. Fail-closed: anything that
 * is not exactly one of the three sanctioned shapes is rejected.
 *
 * SECURITY-CRITICAL path sanitization: `targetToPrompt` concatenates `path`
 * directly after `/review ` as a command argument, so a `path` that is
 * flag-shaped (`--comment`) or multi-token (`42 --comment`, or one carrying a
 * newline) would smuggle an owner-gated flag — or arbitrary prompt text — past
 * the owner-scope gate on a WRITE-only token. A flag/multi-token path is
 * INDISTINGUISHABLE from a real flag once it lands as an argument, so we reject
 * any `path` that begins with `-` or contains ANY whitespace/newline character.
 */
export function parseReviewTarget(raw: unknown): ReviewTarget | null {
  if (raw === undefined || raw === null) return { kind: 'local' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  if ('pr' in t) {
    const pr = t['pr'];
    if (typeof pr === 'number' && Number.isInteger(pr) && pr > 0) {
      return { kind: 'pr', number: pr };
    }
    return null;
  }
  if ('path' in t) {
    const p = t['path'];
    if (typeof p !== 'string' || p.length === 0) return null;
    if (p.startsWith('-')) return null; // flag-shaped → indistinguishable from a flag
    if (/\s/.test(p)) return null; // whitespace/newline → multi-token / injection
    return { kind: 'path', path: p };
  }
  if ('local' in t) {
    return t['local'] === true ? { kind: 'local' } : null;
  }
  return null;
}

/**
 * Map a target + flags to the exact `/review` prompt the bundled skill
 * expects. Report-only suffix is appended whenever autofix is off, so the
 * skill never applies edits for a plain (report) review.
 */
export function targetToPrompt(
  t: ReviewTarget,
  comment: boolean,
  autofix: boolean,
): string {
  const base =
    t.kind === 'pr'
      ? `/review ${t.number}`
      : t.kind === 'path'
        ? `/review ${t.path}`
        : '/review';
  const flag = comment ? ' --comment' : '';
  const suffix = autofix
    ? ''
    : '\n\nReport only — do not apply autofixes (skip the autofix step).';
  return base + flag + suffix;
}

/**
 * POST /rc/reviews — the trigger saga. SECURITY-CRITICAL: enforces the
 * owner-scope gate (privileged flags require OWNER), the pre-flight skill
 * guard, and wires the per-review permission bridge. Every failure leg after
 * session creation best-effort ends the session and closes the bridge if it
 * was opened — no zombie sessions, no half-registered reviews. WRITE scope is
 * enforced at the mount; the OWNER gate below is the escalation for privileged
 * flags.
 */
export function createTriggerReviewRoute(
  deps: ReviewRoutesDeps,
): RequestHandler {
  const acceptMs = deps.promptAcceptWindowMs ?? 1000;
  return async (req, res) => {
    const body = (req.body ?? {}) as {
      target?: unknown;
      comment?: unknown;
      autofix?: unknown;
      autoApprove?: unknown;
    };

    // Saga leg 1: validate the target (fail-closed → 400 invalid_target).
    const target = parseReviewTarget(body.target);
    if (target === null) {
      res.status(400).json({ error: 'Invalid target', code: 'invalid_target' });
      return;
    }
    const comment = body.comment === true;
    const autofix = body.autofix === true;
    const autoApprove = body.autoApprove === true;

    // Saga leg 2: owner-scope gate. Any privileged flag (comment/autofix/
    // autoApprove) demands OWNER — a WRITE token may only run a plain
    // (vote-leg, report-only, no-comment) review. Register NOTHING on reject.
    if (
      (comment || autofix || autoApprove) &&
      !hasScope(req.rcClient?.scopes ?? [], OWNER)
    ) {
      // Audit the denial so a WRITE token attempting a privileged review is
      // logged (the mount-level scope_denied never fires — WRITE passes it).
      void deps.audit?.record({
        action: 'scope_denied',
        actorTokenId: req.rcClient?.id,
        subActor: req.rcClient?.subActor,
        detail: {
          required: 'owner',
          reason: 'privileged_review_flags',
          comment,
          autofix,
          autoApprove,
        },
      });
      res.status(403).json({
        error: 'Owner scope required',
        code: 'owner_scope_required',
      });
      return;
    }

    // Saga leg 3: create a DEDICATED daemon session (sessionScope 'thread'
    // forces a distinct session; the daemon default would coalesce it).
    let sessionId: string;
    let workspaceCwd: string | null;
    try {
      const session = await deps.daemon.createOrAttachSession({
        sessionScope: 'thread',
      });
      sessionId = session.sessionId;
      // The bridge realpath-confines edits to this root; a null root makes the
      // classifier escalate every edit (fail-safe).
      workspaceCwd =
        typeof session.workspaceCwd === 'string' && session.workspaceCwd.length
          ? session.workspaceCwd
          : null;
    } catch {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    // Saga leg 4: pre-flight skill guard. The `review` skill MUST be available
    // on the session before we send the prompt — otherwise the prompt would
    // run as an ordinary turn with no reviewer behaviour. A throw from
    // sessionSupportedCommands itself is treated as unavailable (fail-closed).
    // On unavailability: best-effort end the session, register NOTHING.
    let hasReviewSkill = false;
    try {
      const supported = await deps.daemon.sessionSupportedCommands(sessionId);
      hasReviewSkill =
        Array.isArray(supported.availableSkills) &&
        supported.availableSkills.includes('review');
    } catch {
      hasReviewSkill = false;
    }
    if (!hasReviewSkill) {
      try {
        await deps.daemon.closeSession(sessionId);
      } catch {
        // Best-effort — the daemon may already have dropped the session.
      }
      res.status(502).json({
        error: 'Review skill unavailable',
        code: 'review_skill_unavailable',
      });
      return;
    }

    // Legs 5–8 run under a rollback guard: once the session exists, ANY thrown
    // error (a `registry.register` file-persist rejection, a `bridge.open`
    // throw, an unexpected emit/audit throw) MUST NOT leak a live session +
    // open bridge or hang the client (Express 4 does not catch async-handler
    // throws). The catch best-effort closes the bridge (a no-op if never
    // opened) and ends the session, then 502 review_start_failed.
    try {
      // Saga leg 5: open the permission bridge BEFORE sending the prompt, so no
      // early permission_request is missed. worktreeRoot confines auto-approved
      // edits; a null root escalates all edits.
      await deps.bridge.open(sessionId, {
        autoApprove,
        autofix,
        comment,
        worktreeRoot: workspaceCwd,
      });

      // Saga leg 6: register the review record.
      const approvalLeg: 'vote' | 'auto' = autoApprove ? 'auto' : 'vote';
      const record = await deps.registry.register({
        sessionId,
        target,
        comment,
        autofix,
        approvalLeg,
        triggeredByTokenId: req.rcClient?.id ?? '',
      });

      // Saga leg 7: send the `/review` prompt, raced against the accept window.
      // Survival (or early resolution) accepts the trigger; an EARLY rejection
      // is a send failure → roll back (close bridge, end session, mark failed).
      const promptText = targetToPrompt(target, comment, autofix);
      const promptPromise = sendSerializedPrompt(deps, sessionId, promptText);
      let acceptTimer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        promptPromise.then(
          () => 'settled' as const,
          () => 'send_failed' as const,
        ),
        new Promise<'accepted'>((resolve) => {
          acceptTimer = setTimeout(() => resolve('accepted'), acceptMs);
          acceptTimer.unref?.();
        }),
      ]);
      clearTimeout(acceptTimer);

      if (outcome === 'send_failed') {
        // Rollback: no zombie session, no half-triggered review.
        deps.bridge.close(sessionId);
        try {
          await deps.daemon.closeSession(sessionId);
        } catch {
          // Best-effort.
        }
        await deps.registry.setStatus(record.reviewId, 'failed');
        res
          .status(502)
          .json({ error: 'Prompt send failed', code: 'prompt_send_failed' });
        return;
      }

      // Accepted. The prompt's eventual settlement drives completed/failed,
      // then the bridge closes (the review's permission window is over once its
      // prompt settles). (If it already resolved — 'settled' — this fires now.)
      void (async () => {
        try {
          await promptPromise;
          await deps.lifecycle.onPromptSettled(record.reviewId, 'completed');
        } catch {
          try {
            await deps.lifecycle.onPromptSettled(record.reviewId, 'failed');
          } catch {
            // Best-effort terminal transition.
          }
        } finally {
          deps.bridge.close(sessionId);
        }
      })();

      deps.lifecycle.emit(
        'review_started',
        deps.registry.get(record.reviewId)!,
      );
      // Audit: ids + flags + approvalLeg ONLY — NEVER the prompt/diff/report.
      // `target` is sanitized the same way as the owner-stream frame (a
      // `path` target's raw filesystem path must never reach the audit log).
      void deps.audit?.record({
        action: 'review_started',
        actorTokenId: req.rcClient?.id,
        subActor: req.rcClient?.subActor,
        target: record.reviewId,
        detail: {
          sessionId,
          target: sanitizeReviewTarget(target),
          comment,
          autofix,
          autoApprove,
          approvalLeg,
        },
      });

      res.status(202).json({ reviewId: record.reviewId, sessionId });
    } catch {
      // A leg 5–7 throw (e.g. a registry persist rejection) — roll back so no
      // zombie session or open bridge survives, and never hang the client.
      deps.bridge.close(sessionId);
      try {
        await deps.daemon.closeSession(sessionId);
      } catch {
        // Best-effort — the daemon may already have dropped the session.
      }
      if (!res.headersSent) {
        res.status(502).json({
          error: 'Review start failed',
          code: 'review_start_failed',
        });
      }
    }
  };
}

/** A record plus its read-time cost rollup (mirrors routes/agents.ts's `withCost`). */
export function withReviewCost(
  rec: ReviewRecord,
  costFor?: (sessionId: string) => number | undefined,
): ReviewRecord & { costMicrocents?: number } {
  const cost = costFor?.(rec.sessionId);
  return cost !== undefined ? { ...rec, costMicrocents: cost } : { ...rec };
}

/**
 * GET /rc/reviews?status= — SESSION_READ scope at the mount, which admits a
 * session-locked SHARE token. add-link-share: a session-locked token gets
 * `read` on `session_lock_id` ONLY and SHALL NOT access other sessions — this
 * is a workspace-wide list, so a locked caller is confined here, in-handler
 * (mirroring routes/search.ts's `req.rcClient.sessionLockId` confinement), to
 * reviews whose OWN `sessionId` (the dedicated daemon session the trigger saga
 * created for the review) equals the lock. A non-locked (owner/write) token
 * is unaffected — full list, as before.
 */
export function createListReviewsRoute(deps: ReviewRoutesDeps): RequestHandler {
  return (req, res) => {
    const statusRaw = req.query['status'];
    let status: ReviewStatus | undefined;
    if (typeof statusRaw === 'string' && statusRaw.length > 0) {
      if (!REVIEW_STATUSES.includes(statusRaw as ReviewStatus)) {
        res
          .status(400)
          .json({ error: 'Invalid status', code: 'invalid_status' });
        return;
      }
      status = statusRaw as ReviewStatus;
    }
    const lock = req.rcClient?.sessionLockId;
    const reviews = deps.registry
      .list({ status })
      .filter((r) => lock === undefined || r.sessionId === lock)
      .map((r) => withReviewCost(r, deps.costFor));
    res.status(200).json({ reviews });
  };
}

/**
 * GET /rc/reviews/:id — SESSION_READ scope at the mount, which admits a
 * session-locked SHARE token. Mirrors createListReviewsRoute's confinement: a
 * locked caller may only fetch a review whose OWN `sessionId` equals the
 * lock. A record that fails the tie is reported 404 — the SAME shape as a
 * missing id — so a locked token cannot distinguish "exists in another
 * session" from "doesn't exist". A non-locked (owner/write) token is
 * unaffected — full access, as before.
 */
export function createGetReviewRoute(deps: ReviewRoutesDeps): RequestHandler {
  return (req, res) => {
    const rec = deps.registry.get(req.params.id);
    const lock = req.rcClient?.sessionLockId;
    const visible =
      rec !== undefined && (lock === undefined || rec.sessionId === lock);
    if (!visible) {
      res
        .status(404)
        .json({ error: 'Unknown review', code: 'review_not_found' });
      return;
    }
    res.status(200).json(withReviewCost(rec, deps.costFor));
  };
}

/**
 * POST /rc/reviews/:id/cancel — proxies to the daemon's session end (the
 * same call the trigger saga's rollback makes) and marks the record
 * cancelled. WRITE scope at the mount. 409 review_not_running on terminal
 * records (mirrors routes/agents.ts's createAgentCancelRoute).
 */
export function createCancelReviewRoute(
  deps: ReviewRoutesDeps,
): RequestHandler {
  return async (req, res) => {
    const rec = deps.registry.get(req.params.id);
    if (!rec) {
      res
        .status(404)
        .json({ error: 'Unknown review', code: 'review_not_found' });
      return;
    }
    if (TERMINAL_REVIEW_STATUSES.has(rec.status)) {
      res
        .status(409)
        .json({ error: 'Review not running', code: 'review_not_running' });
      return;
    }
    try {
      await deps.daemon.closeSession(rec.sessionId);
    } catch {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }
    // Atomic terminal transition: two concurrent cancels can both pass the
    // pre-check above and both reach here. setStatus is the single source of
    // truth for "who won" — only the caller whose transition actually landed
    // audits/emits/200s; the loser gets 409, matching the pre-check's
    // terminal-status response.
    const transitioned = await deps.registry.setStatus(
      rec.reviewId,
      'cancelled',
    );
    if (!transitioned) {
      res
        .status(409)
        .json({ error: 'Review not running', code: 'review_not_running' });
      return;
    }
    await deps.lifecycle.onCancelled(rec.reviewId);
    void deps.audit?.record({
      action: 'review_cancelled',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      target: rec.reviewId,
      detail: { sessionId: rec.sessionId },
    });
    res.status(200).json({ reviewId: rec.reviewId, status: 'cancelled' });
  };
}
