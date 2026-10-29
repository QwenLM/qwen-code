/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Consumes the clean-review handoff and spawns the deep-verification round.
 *
 * A review round that ended clean writes one durable event
 * (commands/review/lib/review-events.ts). This automation reads it and asks the
 * workspace's own sub-session launcher to run `/verify-pr <n> --publish` in a
 * fresh session, so the maintainer does not have to notice the verdict and
 * start the evidence round by hand.
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
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type {
  CreateSubSessionInfo,
  CreateSubSessionResult,
} from '@qwen-code/acp-bridge/bridgeOptions';
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
      callerSessionId: string;
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
 */
export function reviewVerifyDecision(
  event: ReviewCleanEventV1,
  facts: {
    enabled: boolean;
    skillAvailable: boolean;
    spawnedKeys: ReadonlySet<string>;
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
  if (!event.sessionId) {
    return { action: 'decline', reason: 'no-session', key };
  }
  if (facts.spawnedKeys.has(key)) {
    return { action: 'decline', reason: 'already-verified', key };
  }
  return {
    action: 'spawn',
    prompt: `/verify-pr ${event.target.number} --publish --repo ${event.target.ownerRepo}`,
    callerSessionId: event.sessionId,
    name: `verify PR #${event.target.number}`,
    key,
  };
}

export interface ReviewVerifyAutomationOptions {
  boundWorkspace: string;
  /** The workspace's own sub-session launcher (`SubSessionLauncher.launch`). */
  launch: (info: CreateSubSessionInfo) => Promise<CreateSubSessionResult>;
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

    for (const { event, path: eventPath } of events) {
      const decision = reviewVerifyDecision(event, {
        enabled,
        skillAvailable,
        spawnedKeys,
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
      try {
        const result = await opts.launch({
          prompt: decision.prompt,
          completion: 'sent',
          callerSessionId: decision.callerSessionId,
          name: decision.name,
        });
        notice(
          `review-verify: spawned ${result.sessionId} for ${event.target.ownerRepo}#${event.target.number} at ${event.target.headSha}`,
        );
        log.debug('spawned verification sub-session', result.sessionId);
      } catch (error) {
        // The key is already recorded: this head is not retried. A missing
        // round is recoverable by hand; a duplicate published report is not.
        notice(
          `review-verify: spawn failed for ${event.target.ownerRepo}#${event.target.number} (${
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
