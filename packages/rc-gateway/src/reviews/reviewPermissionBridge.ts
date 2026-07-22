/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath, lstat } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { selectAllowOnceOptionId } from '../permissionOptions.js';
import {
  classifyReviewToolCall,
  EDIT_PATH_FIELDS,
  type ReviewPolicy,
  type ReviewToolCall,
} from './reviewClassifier.js';

/**
 * SECURITY-CRITICAL: the enforcement point for a remote review's permission
 * policy. For each opened review session the bridge owns a DEDICATED
 * `subscribeEvents(sessionId, { lastEventId: 0 })` subscription — seeded at 0 to
 * force a full ring replay so no early `permission_request` is missed — and, on
 * each frame, either VOTES (auto-approve, one-time only) or ESCALATES (leaves the
 * permission pending for the owner). It NEVER sends a `cancelled` (deny) outcome:
 * a human decides deny. Escalate-by-default — anything we cannot prove safe is
 * escalated, never approved.
 *
 * Two enforcement layers sit in front of a vote:
 *
 *   1. The classifier (`classifyReviewToolCall`, C.1) — the first filter. It is a
 *      pure function keyed on `toolCall.kind` + `rawInput`, string-level path math
 *      only (no fs).
 *
 *   2. Guard 2 (below) — a SECOND gate layered only on `edit` approvals. After the
 *      classifier approves an `edit`, the bridge `fs.realpath`-verifies every
 *      target path field actually lands inside the worktree, defeating an in-tree
 *      symlink that points outside (which the string-level classifier cannot see).
 *
 * GUARD 3 — `kind` INTEGRITY (trust boundary, documented, no code needed):
 * The classifier auto-approves `read`/`search` on `toolCall.kind` ALONE. That is
 * sound ONLY because `kind` is assigned by the daemon from each tool's registered
 * `Kind` enum, NOT from the model or the reviewed diff. The `permission_request`
 * frames this bridge consumes originate from the daemon's ACP HTTP bridge
 * (`httpAcpBridge.ts`) over the same authenticated gateway↔daemon boundary as
 * every other daemon read — they are not model-controlled JSON. So a
 * prompt-injected diff cannot forge a benign `kind` to smuggle a dangerous call
 * past the on-kind-alone shortcut. If a future change ever let untrusted input set
 * `kind`, this assumption — and the read/search shortcut — would break; it holds
 * within the current trust model.
 */

/** Minimal structural view of DaemonClient the bridge needs. */
export interface ReviewBridgeDaemon {
  subscribeEvents(
    sessionId: string,
    opts?: { lastEventId?: number; signal?: AbortSignal },
  ): AsyncIterable<{ type: string; data: unknown }>;
  respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: {
      outcome:
        | { outcome: 'selected'; optionId: string }
        | { outcome: 'cancelled' };
    },
  ): Promise<boolean>;
}

export interface ReviewBridgeDeps {
  daemon: ReviewBridgeDaemon;
  /** Called when a call is escalated (leave pending for a human vote). */
  onEscalate?: (sessionId: string, data: PermissionRequestData) => void;
  /** Called when tool output flows again (unblock). */
  onResume?: (sessionId: string) => void;
}

export interface PermissionRequestData {
  requestId: string;
  sessionId: string;
  toolCall: ReviewToolCall;
  options: Array<{ optionId: string; kind: string }>;
}

export class ReviewPermissionBridge {
  private readonly loops = new Map<
    string,
    { abort: AbortController; done: Promise<void> }
  >();
  constructor(private readonly deps: ReviewBridgeDeps) {}

  async open(sessionId: string, policy: ReviewPolicy): Promise<void> {
    if (this.loops.has(sessionId)) return;
    const abort = new AbortController();
    const done = this.run(sessionId, policy, abort.signal).catch(() => {});
    this.loops.set(sessionId, { abort, done });
  }

  private async run(
    sessionId: string,
    policy: ReviewPolicy,
    signal: AbortSignal,
  ): Promise<void> {
    const it = this.deps.daemon.subscribeEvents(sessionId, {
      lastEventId: 0,
      signal,
    });
    for await (const ev of it) {
      if (signal.aborted) return;
      if (ev.type === 'permission_request') {
        await this.handlePermission(
          sessionId,
          policy,
          ev.data as PermissionRequestData,
        );
      } else {
        // Any tool-output / session_update frame → the tool proceeded.
        this.deps.onResume?.(sessionId);
      }
    }
  }

  private async handlePermission(
    sessionId: string,
    policy: ReviewPolicy,
    data: PermissionRequestData,
  ): Promise<void> {
    const toolCall = data.toolCall ?? ({} as ReviewToolCall);
    const decision = classifyReviewToolCall(toolCall, policy);
    if (decision === 'approve') {
      // GUARD 2 — symlink realpath confinement for `edit` approvals only.
      // The classifier confined the path at the STRING level (path.resolve, no
      // symlinks). Before honoring an edit approval we additionally realpath the
      // target to defeat an in-tree symlink pointing OUTSIDE the worktree (e.g. a
      // PR commits `evil -> ~/.ssh/authorized_keys`). If confinement cannot be
      // proven, escalate.
      const confined =
        toolCall.kind === 'edit'
          ? await this.confineEditRealpath(policy, toolCall)
          : true;
      if (confined) {
        // One-time approval ONLY. If no `allow_once` option is offered we refuse
        // to vote (never escalate a single call into a standing grant) and fall
        // through to escalation.
        const optionId = selectAllowOnceOptionId(data.options);
        if (optionId !== undefined) {
          await this.deps.daemon.respondToSessionPermission(
            sessionId,
            data.requestId,
            { outcome: { outcome: 'selected', optionId } },
          );
          return;
        }
      }
      // confined === false OR no allow_once → fall through to escalate.
    }
    // Escalate: leave the permission pending for the human; NEVER send cancelled.
    this.deps.onEscalate?.(sessionId, data);
  }

  /**
   * GUARD 2: realpath-verify EVERY present edit path field lands inside the
   * worktree. Returns true only if every field is provably in-tree; any
   * ambiguity (missing root, no path field, non-string field, fs error other
   * than a clean not-yet-existing file, a symlink escaping the tree) → false
   * (escalate). Reuses the SAME `EDIT_PATH_FIELDS` the classifier confines so the
   * two layers can never drift.
   */
  private async confineEditRealpath(
    policy: ReviewPolicy,
    toolCall: ReviewToolCall,
  ): Promise<boolean> {
    const worktreeRoot = policy.worktreeRoot;
    if (typeof worktreeRoot !== 'string' || worktreeRoot.length === 0) {
      return false;
    }
    // Realpath the ROOT too: mkdtemp/`/tmp` are often themselves symlinks, so
    // comparing against the raw root would false-positive (or false-negative).
    let realRoot: string;
    try {
      realRoot = await realpath(worktreeRoot);
    } catch {
      return false; // cannot verify the root → escalate
    }

    const rawInput = toolCall.rawInput;
    let sawPath = false;
    for (const key of EDIT_PATH_FIELDS) {
      const v = rawInput?.[key];
      if (v === undefined || v === null) continue; // field absent
      sawPath = true;
      if (typeof v !== 'string' || v.length === 0) return false;

      const target = resolve(worktreeRoot, v);
      let real: string;
      try {
        real = await realpath(target);
      } catch (err) {
        // ONLY a clean ENOENT may fall through to the parent dir (a genuinely
        // new file for write_file). EACCES / ELOOP / anything else is ambiguous
        // → escalate.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        // ENOENT is ALSO what a DANGLING symlink throws (final component is a
        // link whose destination does not exist yet). Trusting it as "new file"
        // would let write_file create the destination OUTSIDE the tree via the
        // link (e.g. create `~/.ssh/authorized_keys`). Distinguish with lstat:
        // if the path itself exists (as a link) it is NOT a plain new file →
        // escalate. Only when the final component truly does not exist do we
        // confine via its parent directory.
        const existsAsLink = await lstat(target).then(
          () => true,
          () => false,
        );
        if (existsAsLink) return false; // dangling symlink → escalate
        try {
          real = await realpath(dirname(target));
        } catch {
          return false; // parent unresolvable → escalate
        }
      }
      if (!isInside(realRoot, real)) return false;
    }
    if (!sawPath) return false; // no path field to confine → escalate
    return true;
  }

  close(sessionId: string): void {
    const loop = this.loops.get(sessionId);
    if (!loop) return;
    loop.abort.abort();
    this.loops.delete(sessionId);
  }

  closeAll(): void {
    for (const sid of [...this.loops.keys()]) this.close(sid);
  }

  /** Test helper: await the subscription loop draining a finite fake stream. */
  async drain(sessionId: string): Promise<void> {
    await this.loops.get(sessionId)?.done;
  }
}

/** True iff realpath'd `p` is the root itself or a descendant of it. */
function isInside(realRoot: string, p: string): boolean {
  const rel = relative(realRoot, p);
  if (rel.length === 0) return true; // p === root (degenerate, inside)
  if (isAbsolute(rel)) return false; // different filesystem root
  if (rel === '..' || rel.startsWith('..' + sep)) return false; // escapes
  return true;
}
