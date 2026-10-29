/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Consumes the clean-review handoff and spawns the deep-verification round.
 *
 * A review round that ended clean writes one durable event
 * (commands/review/lib/review-events.ts). This automation reads it and runs
 * `/verify-pr <n> --publish` in a fresh session, so the maintainer does not have
 * to notice the verdict and start the evidence round by hand.
 *
 * The producer is not assumed to be qwen-code. Two spawn paths follow from who
 * did the review:
 *  - Event names a session (qwen-code's own `save-artifact` wrote it) → the
 *    workspace's sub-session launcher, with that session as the parent, so the
 *    per-caller caps and the depth-1 gate apply.
 *  - Event names none (another agent, a human, or CI recorded it through
 *    `qwen review verify-event`) → a top-level automation session via the
 *    bridge. There is no parent to charge a bucket to, so the bridge's own
 *    session admission is the bound.
 *
 * Shape and lifecycle mirror `scheduled-task-keepalive.ts`: an interval tick as
 * the backstop, an `fs.watch` + debounce on the durable directory for
 * immediacy, one pass in flight at a time, `unref`'d timers so the automation
 * never holds the daemon open, and an `activeWork` signal the workspace
 * lifecycle reads before it closes a runtime.
 *
 * Two rules are deliberate and load-bearing:
 *  - Write-ahead dedupe. The head is recorded in `spawned.json` BEFORE the
 *    spawn, so a daemon that dies in between never replays a round that may
 *    already have published a comment. The cost is that a failed spawn is not
 *    retried; it is logged, and the operator can run `/verify-pr` by hand.
 *  - Declined events are dropped, not queued. Nothing about an event becomes
 *    actionable later without a new review round, which writes a new event.
 */

import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type {
  CreateSubSessionInfo,
  CreateSubSessionResult,
} from '@qwen-code/acp-bridge/bridgeOptions';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import {
  pendingEventsDir,
  readPendingReviewEvents,
  readSpawnedKeys,
  recordSpawnedKey,
  removePendingEvent,
  reviewEventDedupeKey,
  type ReviewCleanEventV1,
} from '../commands/review/lib/review-events.js';
import { operatorReviewSettings } from '../commands/review/lib/review-settings.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';

const log = createDebugLogger('REVIEW_VERIFY');

/** The slice of the bridge the parentless path needs. Narrow so the automation
 *  stays testable without a bridge, and so it cannot reach for lifecycle
 *  operations it has no business calling. */
export type ReviewVerifyBridge = Pick<
  AcpSessionBridge,
  'spawnOrAttach' | 'updateSessionMetadata' | 'sendPrompt'
>;

/**
 * Spawn a TOP-LEVEL verification session for an event with no originating
 * qwen-code session — a review performed by another agent, a human, or CI.
 *
 * The sub-session launcher cannot serve this case: its `callerSessionId` is
 * required, and it keys both the per-caller concurrency bucket and the depth-1
 * gate on it. So this goes straight to the bridge, exactly as the launcher's
 * own non-standalone path does (`spawnOrAttach` thread scope → name →
 * `sendPrompt`), minus the parent lineage and the completion await.
 *
 * Fire-and-forget: the turn runs independently and the session is idle-reaped
 * like any other. Concurrency is bounded by the bridge's own `maxSessions`
 * admission, and by the per-head dedupe ledger upstream of this call.
 */
export async function spawnReviewVerifySession(
  bridge: ReviewVerifyBridge,
  info: {
    prompt: string;
    /** Built by `reviewVerifyDecision` from a PR number, so inert by
     *  construction — no model or platform text reaches the session title. */
    name: string;
    workspaceCwd: string;
  },
  onDispatchError?: (error: unknown) => void,
): Promise<{ sessionId: string }> {
  const session = await bridge.spawnOrAttach({
    workspaceCwd: info.workspaceCwd,
    sessionScope: 'thread', // a fresh top-level session, never attach
  });
  const sessionId = session.sessionId;
  try {
    bridge.updateSessionMetadata(sessionId, {
      displayName: info.name,
      titleSource: 'auto',
    });
  } catch (error) {
    // Presentation only: a failed rename must not lose the round.
    log.debug('review-verify: session rename failed', sessionId, error);
  }
  const turn = bridge.sendPrompt(
    sessionId,
    {
      sessionId,
      prompt: [{ type: 'text', text: info.prompt }],
    } as Parameters<AcpSessionBridge['sendPrompt']>[1],
    undefined,
    { promptId: randomUUID() },
  );
  // The session exists either way; a dispatch rejection (admission, auth, API)
  // is reported rather than left as an unhandled rejection or a silent loss.
  void turn.catch((error: unknown) => {
    log.debug('review-verify: sendPrompt rejected', sessionId, String(error));
    onDispatchError?.(error);
  });
  return { sessionId };
}

/** Backstop interval. The watch delivers a new event within its debounce; this
 *  only covers a missed watch event (a platform that drops them, a directory
 *  recreated under us). */
const DEFAULT_INTERVAL_MS = 60_000;

/** Same debounce the scheduled-task keepalive uses on its tasks file. */
const WATCH_DEBOUNCE_MS = 500;

/** The project skill the spawned prompt invokes. A workspace without it would
 *  spawn a session that can only report the command is unknown. */
const VERIFY_SKILL_RELATIVE_PATH = path.join(
  '.qwen',
  'skills',
  'verify-pr',
  'SKILL.md',
);

export type ReviewVerifyDecision =
  | {
      action: 'spawn';
      prompt: string;
      /** Absent when the review happened outside qwen-code: the pass then
       *  spawns a top-level automation session instead of a sub-session. */
      callerSessionId?: string;
      name: string;
      key: string;
    }
  | { action: 'decline'; reason: string; key: string };

/**
 * The whole policy, as a pure function over one event and the pass's facts.
 *
 * `github.com` only: `/verify-pr` resolves its coordinates with `gh` and has no
 * `--host` flag, so a GitHub Enterprise or Aone target cannot be expressed in
 * the prompt. The event still carries the platform and host — lifting this gate
 * is a change here, not a schema change.
 *
 * The producer is irrelevant to every gate below: an event written by another
 * agent through `review verify-event` is judged exactly like one written by
 * qwen-code's own pipeline.
 */
export function reviewVerifyDecision(
  event: ReviewCleanEventV1,
  facts: {
    enabled: boolean;
    skillAvailable: boolean;
    spawnedKeys: ReadonlySet<string>;
    /** Whether a parentless spawn path exists (a bridge is wired). Without one
     *  an event that names no session cannot be acted on at all. */
    canSpawnTopLevel: boolean;
  },
): ReviewVerifyDecision {
  const key = reviewEventDedupeKey(event.target);
  if (!facts.enabled) return { action: 'decline', reason: 'disabled', key };
  if (
    event.target.platform !== 'github' ||
    event.target.host !== 'github.com'
  ) {
    return { action: 'decline', reason: 'unsupported-platform', key };
  }
  if (!facts.skillAvailable) {
    return { action: 'decline', reason: 'skill-unavailable', key };
  }
  if (!event.sessionId && !facts.canSpawnTopLevel) {
    return { action: 'decline', reason: 'no-session', key };
  }
  if (facts.spawnedKeys.has(key)) {
    return { action: 'decline', reason: 'already-verified', key };
  }
  return {
    action: 'spawn',
    prompt: `/verify-pr ${event.target.number} --publish --repo ${event.target.ownerRepo}`,
    ...(event.sessionId ? { callerSessionId: event.sessionId } : {}),
    name: `verify PR #${event.target.number}`,
    key,
  };
}

export interface ReviewVerifyAutomationOptions {
  boundWorkspace: string;
  /** The workspace's own sub-session launcher (`SubSessionLauncher.launch`). */
  launch: (info: CreateSubSessionInfo) => Promise<CreateSubSessionResult>;
  /** This runtime's bridge, for events with no originating session. Optional:
   *  without it such an event is declined with `no-session` rather than
   *  silently dropped. */
  getBridge?: () => ReviewVerifyBridge | undefined;
  intervalMs?: number;
  /** Re-read each pass that has work, so flipping the setting needs no
   *  restart. Defaults to the operator-scoped `review.autoVerify`. */
  isEnabled?: () => boolean;
  /** Operator-visible line for a spawn, a decline or a failure. Defaults to
   *  the SAFE stderr writer: a background automation's diagnostics must not
   *  end the daemon when the reader goes away (EPIPE). */
  onNotice?: (message: string) => void;
}

export interface ReviewVerifyAutomation {
  /** True while a pass is running; the workspace lifecycle waits on it. */
  readonly activeWork: boolean;
  stop(): void;
  tick(): Promise<void>;
}

export function startReviewVerifyAutomation(
  opts: ReviewVerifyAutomationOptions,
): ReviewVerifyAutomation {
  const { boundWorkspace } = opts;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const isEnabled =
    opts.isEnabled ?? (() => operatorReviewSettings().autoVerify);
  const notice = opts.onNotice ?? writeStderrLineSafe;
  const skillPath = path.join(boundWorkspace, VERIFY_SKILL_RELATIVE_PATH);
  // An unreadable pending file is reported once, not every pass: it is inert
  // and this module does not delete a file it cannot parse.
  const reportedUnreadable = new Set<string>();

  const pass = async (): Promise<void> => {
    const { events, unreadable } = readPendingReviewEvents(boundWorkspace);
    for (const item of unreadable) {
      if (reportedUnreadable.has(item.path)) continue;
      reportedUnreadable.add(item.path);
      notice(
        `review-verify: ignoring unreadable event ${item.path} (${item.reason})`,
      );
    }
    // Nothing pending: do not read settings, do not touch the ledger. A steady
    // workspace costs one directory read per tick.
    if (events.length === 0) return;

    let spawnedKeys: Set<string>;
    try {
      spawnedKeys = readSpawnedKeys(boundWorkspace);
    } catch (error) {
      // Fail closed: a ledger we cannot read cannot prove a head was not
      // already verified, and a duplicate verification publishes a duplicate
      // public comment. Leave the events pending and say so.
      notice(
        `review-verify: cannot read the spawned ledger; leaving ${events.length} event(s) pending (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return;
    }

    const enabled = isEnabled();
    const skillAvailable = fsSync.existsSync(skillPath);
    const bridge = opts.getBridge?.();

    for (const { event, path: eventPath } of events) {
      const decision = reviewVerifyDecision(event, {
        enabled,
        skillAvailable,
        spawnedKeys,
        canSpawnTopLevel: bridge !== undefined,
      });
      if (decision.action === 'decline') {
        removePendingEvent(eventPath);
        notice(
          `review-verify: not spawning for ${event.target.ownerRepo}#${event.target.number} (${decision.reason})`,
        );
        continue;
      }
      try {
        recordSpawnedKey(
          boundWorkspace,
          decision.key,
          decision.callerSessionId,
        );
      } catch (error) {
        // No spawn happened, so the event stays pending and the next pass
        // retries it — the write-ahead record is what must not be skipped.
        notice(
          `review-verify: cannot record ${decision.key}; leaving the event pending (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        continue;
      }
      spawnedKeys.add(decision.key);
      const label = `${event.target.ownerRepo}#${event.target.number}`;
      const attribution = event.reviewedBy
        ? ` (reviewed by ${event.reviewedBy})`
        : '';
      try {
        let result: { sessionId: string };
        if (decision.callerSessionId) {
          result = await opts.launch({
            prompt: decision.prompt,
            completion: 'sent',
            callerSessionId: decision.callerSessionId,
            name: decision.name,
          });
        } else {
          // The decision only reaches here without a caller when a bridge was
          // wired; assert it rather than cast, so a future gate change surfaces
          // as a logged failure instead of a crash on undefined.
          if (!bridge) {
            throw new Error('no bridge available for a parentless event');
          }
          result = await spawnReviewVerifySession(
            bridge,
            {
              prompt: decision.prompt,
              name: decision.name,
              workspaceCwd: boundWorkspace,
            },
            (error) =>
              notice(
                `review-verify: prompt dispatch failed for ${label} (${
                  error instanceof Error ? error.message : String(error)
                })`,
              ),
          );
        }
        notice(
          `review-verify: spawned ${result.sessionId} for ${label} at ${event.target.headSha}${attribution}`,
        );
        log.debug('spawned verification session', result.sessionId);
      } catch (error) {
        // The key is already recorded: this head is not retried. A missing
        // round is recoverable by hand; a duplicate published report is not.
        notice(
          `review-verify: spawn failed for ${label} (${
            error instanceof Error ? error.message : String(error)
          }); not retried — run /verify-pr ${event.target.number} --publish manually`,
        );
      }
      removePendingEvent(eventPath);
    }
  };

  let activeTicks = 0;
  const tick = async (): Promise<void> => {
    activeTicks++;
    try {
      // No runtime-base-dir context here, unlike the scheduled-task keepalive:
      // the event directory hangs off `Storage.getGlobalQwenDir()`, which reads
      // QWEN_HOME (or the home directory) and never the runtime base. A
      // workspace `.env` cannot redirect QWEN_HOME, so the reviewing session's
      // CLI subprocess and this daemon resolve the same directory by
      // construction — wrapping the pass would imply a dependency that does
      // not exist.
      await pass();
    } catch (error) {
      notice(
        `review-verify: pass failed (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    } finally {
      activeTicks--;
    }
  };

  // In-flight guard: a pass awaits a spawn, so it can outlast the interval.
  let running = false;
  const runPass = (): void => {
    if (running) return;
    running = true;
    void tick().finally(() => {
      running = false;
    });
  };
  const timer: ReturnType<typeof setInterval> = setInterval(
    runPass,
    intervalMs,
  );
  timer.unref?.();

  let debounce: ReturnType<typeof setTimeout> | undefined;
  let watcher: ReturnType<typeof fsSync.watch> | undefined;
  const dir = pendingEventsDir(boundWorkspace);
  try {
    fsSync.mkdirSync(dir, { recursive: true });
    watcher = fsSync.watch(dir, { persistent: false }, (_event, filename) => {
      // Linux fs.watch can deliver null; treat it as a possible match.
      if (filename !== null && !filename.endsWith('.json')) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(runPass, WATCH_DEBOUNCE_MS);
      debounce.unref?.();
    });
    watcher.on('error', () => {
      // Non-fatal: the interval still ticks.
    });
  } catch {
    // Directory unavailable — the interval still ticks.
  }

  let stopped = false;
  return {
    get activeWork() {
      return activeTicks > 0;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      watcher?.close();
    },
    tick,
  };
}
