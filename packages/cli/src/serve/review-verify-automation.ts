/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Consumes the clean-review handoff ON BEHALF OF A SESSION, and spawns that
 * session's sub-session for the deep-verification round.
 *
 * A review round that ended clean writes one durable event
 * (commands/review/lib/review-events.ts) naming the session it belongs to:
 * qwen-code's own review names the reviewing session, an external producer
 * names the session it was invoked from, and an observed approval names the
 * session that owns the watch. This module reads those events and asks the
 * workspace's sub-session launcher to run `/verify-pr <n> --publish` as a CHILD
 * of that session, so the round is linked to the work that asked for it and
 * inherits the launcher's concurrency caps and depth-1 gate. There is no
 * parentless path: an event that names no session cannot become anyone's
 * sub-session, and is dropped with a reason.
 *
 * Ownership is per session, and so is lifetime. A session's watches and pending
 * events are pruned when that session is deleted, and nothing is spawned for a
 * session that no longer exists. The loop below is the daemon's scheduling slot
 * — one set of timers per workspace — while every decision, every spawn and
 * every cleanup is scoped to one owning session.
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
  type PendingReviewEvent,
  type ReviewCleanEventV1,
} from '../commands/review/lib/review-events.js';
import { operatorReviewSettings } from '../commands/review/lib/review-settings.js';
import {
  observeWatches,
  readWatches,
  removeWatch,
  sessionLivenessFor,
  watchKey,
  type ObservationOutcome,
  type SessionLiveness,
} from '../commands/review/lib/review-verify-observe.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';

const log = createDebugLogger('REVIEW_VERIFY');

/** Backstop interval. The watch delivers a new event within its debounce; this
 *  only covers a missed watch event (a platform that drops them, a directory
 *  recreated under us). */
const DEFAULT_INTERVAL_MS = 60_000;

/** Same debounce the scheduled-task keepalive uses on its tasks file. */
const WATCH_DEBOUNCE_MS = 500;

/** How often the daemon re-reads watched PRs. This one spends a network call
 *  per watch, unlike the file pass, so it is minutes rather than seconds; a
 *  review approval is not a latency-sensitive event. */
const DEFAULT_OBSERVE_INTERVAL_MS = 300_000;

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
 * The whole per-event policy, as a pure function. The owner is resolved by the
 * caller — the session this event belongs to — and is always present here: an
 * event with no owner never reaches this function.
 *
 * `github.com` only: `/verify-pr` resolves its coordinates with `gh` and has no
 * `--host` flag, so a GitHub Enterprise or Aone target cannot be expressed in
 * the prompt. The event still carries the platform and host — lifting this gate
 * is a change here, not a schema change.
 *
 * The producer is irrelevant to every gate below: an event written by another
 * agent through `review verify-event` is judged exactly like one written by
 * qwen-code's own pipeline. Who reviewed is attribution (`reviewedBy`); who
 * owns the round is the parent.
 */
export function reviewVerifyDecision(
  event: ReviewCleanEventV1,
  facts: {
    enabled: boolean;
    skillAvailable: boolean;
    spawnedKeys: ReadonlySet<string>;
    ownerSessionId: string;
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
  if (facts.spawnedKeys.has(key)) {
    return { action: 'decline', reason: 'already-verified', key };
  }
  return {
    action: 'spawn',
    prompt: `/verify-pr ${event.target.number} --publish --repo ${event.target.ownerRepo}`,
    callerSessionId: facts.ownerSessionId,
    name: `verify PR #${event.target.number}`,
    key,
  };
}

export interface ReviewVerifyAutomationOptions {
  boundWorkspace: string;
  /** The workspace's own sub-session launcher (`SubSessionLauncher.launch`).
   *  Every spawn goes through it, with the owning session as the caller. */
  launch: (info: CreateSubSessionInfo) => Promise<CreateSubSessionResult>;
  intervalMs?: number;
  /** How often to re-read the watched PRs' approval state. Defaults to five
   *  minutes; each pass spends one GraphQL call per watch. */
  observeIntervalMs?: number;
  /** The observation pass, injectable for tests. Defaults to the real reader,
   *  scoped to one owning session. */
  observe?: (
    root: string,
    opts: { sessionId: string },
  ) => Promise<ObservationOutcome[]>;
  /** Session existence probe, injectable for tests. Three states — alive,
   *  gone, unknown — and an unknown owner is neither served nor cleaned up. */
  sessionExists?: SessionLiveness;
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
  const observeIntervalMs =
    opts.observeIntervalMs ?? DEFAULT_OBSERVE_INTERVAL_MS;
  const isEnabled =
    opts.isEnabled ?? (() => operatorReviewSettings().autoVerify);
  const notice = opts.onNotice ?? writeStderrLineSafe;
  const observe = opts.observe ?? observeWatches;
  const liveness = opts.sessionExists ?? sessionLivenessFor(boundWorkspace);
  const skillPath = path.join(boundWorkspace, VERIFY_SKILL_RELATIVE_PATH);
  // An unreadable pending file is reported once, not every pass: it is inert
  // and this module does not delete a file it cannot parse.
  const reportedUnreadable = new Set<string>();
  // A watch that cannot be read (no gh auth, a deleted PR) fails every interval;
  // report each distinct failure once rather than filling the log.
  const reportedObserveFailures = new Set<string>();

  /** Consume one owner's pending events, spawning that owner's sub-sessions. */
  const consumeFor = async (
    owner: string,
    events: PendingReviewEvent[],
    spawnedKeys: Set<string>,
    enabled: boolean,
    skillAvailable: boolean,
  ): Promise<void> => {
    for (const { event, path: eventPath } of events) {
      if (event.sessionId !== owner) continue;
      const decision = reviewVerifyDecision(event, {
        enabled,
        skillAvailable,
        spawnedKeys,
        ownerSessionId: owner,
      });
      const label = `${event.target.ownerRepo}#${event.target.number}`;
      if (decision.action === 'decline') {
        removePendingEvent(eventPath);
        notice(`review-verify: not spawning for ${label} (${decision.reason})`);
        continue;
      }
      try {
        recordSpawnedKey(boundWorkspace, decision.key, owner);
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
      const attribution = event.reviewedBy
        ? ` (reviewed by ${event.reviewedBy})`
        : '';
      try {
        const result = await opts.launch({
          prompt: decision.prompt,
          completion: 'sent',
          callerSessionId: owner,
          name: decision.name,
        });
        notice(
          `review-verify: spawned ${result.sessionId} under ${owner} for ${label} at ${event.target.headSha}${attribution}`,
        );
        log.debug('spawned verification sub-session', result.sessionId);
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

  /** Drop one deleted owner's watches and pending events. */
  const pruneOwner = (owner: string, events: PendingReviewEvent[]): void => {
    for (const watch of readWatches(boundWorkspace)) {
      if (watch.sessionId === owner) {
        removeWatch(boundWorkspace, watchKey(watch));
        notice(`review-verify: pruned watch ${watchKey(watch)} (session-gone)`);
      }
    }
    for (const { event, path: eventPath } of events) {
      if (event.sessionId !== owner) continue;
      removePendingEvent(eventPath);
      notice(
        `review-verify: dropped event for ${event.target.ownerRepo}#${event.target.number} (session-gone)`,
      );
    }
  };

  const pass = async (): Promise<void> => {
    const { events, unreadable } = readPendingReviewEvents(boundWorkspace);
    for (const item of unreadable) {
      if (reportedUnreadable.has(item.path)) continue;
      reportedUnreadable.add(item.path);
      notice(
        `review-verify: ignoring unreadable event ${item.path} (${item.reason})`,
      );
    }

    const owners = new Set<string>();
    for (const { event, path: eventPath } of events) {
      if (event.sessionId) {
        owners.add(event.sessionId);
        continue;
      }
      // No owner: it cannot become anyone's sub-session. Drop it with a reason
      // rather than leave it pending forever.
      removePendingEvent(eventPath);
      notice(
        `review-verify: not spawning for ${event.target.ownerRepo}#${event.target.number} (no-owner)`,
      );
    }
    const watches = readWatches(boundWorkspace);
    for (const watch of watches) owners.add(watch.sessionId);
    // Nothing owned: do not read settings, do not touch the ledger. A steady
    // workspace costs one directory read and one watch-list read per tick.
    if (owners.size === 0) return;

    let spawnedKeys: Set<string>;
    try {
      spawnedKeys = readSpawnedKeys(boundWorkspace);
    } catch (error) {
      // Fail closed: a ledger we cannot read cannot prove a head was not
      // already verified, and a duplicate verification publishes a duplicate
      // public comment. Leave the events pending and say so.
      notice(
        `review-verify: cannot read the spawned ledger; leaving events pending (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return;
    }

    const enabled = isEnabled();
    const skillAvailable = fsSync.existsSync(skillPath);

    for (const owner of owners) {
      const alive = await liveness(owner);
      if (alive === null) {
        // Unknown is neither alive nor gone: do not serve it, do not clean it.
        log.debug('review-verify: owner liveness unknown', owner);
        continue;
      }
      if (alive === false) {
        pruneOwner(owner, events);
        continue;
      }
      await consumeFor(owner, events, spawnedKeys, enabled, skillAvailable);
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

  // Observation: re-read each live owner's watched PRs and hand off any head
  // that came back clean. Separate timer and guard from the file pass: this one
  // spends network calls and must not delay consuming an event already on disk.
  let observing = false;
  const reportOutcomes = (outcomes: ObservationOutcome[]): number => {
    let emitted = 0;
    for (const outcome of outcomes) {
      if (outcome.action === 'emitted') {
        emitted++;
        notice(
          `review-verify: observed a clean approval for ${outcome.key} at ${outcome.headSha}`,
        );
      } else if (outcome.action === 'pruned') {
        notice(`review-verify: pruned watch ${outcome.key} (session-gone)`);
      } else if (outcome.action === 'failed') {
        const dedupe = `${outcome.key}:${outcome.reason}`;
        if (!reportedObserveFailures.has(dedupe)) {
          reportedObserveFailures.add(dedupe);
          notice(
            `review-verify: observation failed for ${outcome.key} (${outcome.reason})`,
          );
        }
      } else {
        log.debug(
          'review-verify observation',
          outcome.key,
          outcome.action,
          outcome.reason,
        );
      }
    }
    return emitted;
  };
  const observeTick = async (): Promise<void> => {
    if (stopped || observing) return;
    observing = true;
    try {
      if (!isEnabled()) return;
      const owners = new Set(
        readWatches(boundWorkspace).map((watch) => watch.sessionId),
      );
      let emitted = 0;
      for (const owner of owners) {
        const alive = await liveness(owner);
        // Only a live owner is read. A deleted owner's watches and events are
        // pruned by the file pass, and an unknown one is left entirely alone —
        // neither is a reason to spend a platform call.
        if (alive !== true) continue;
        emitted += reportOutcomes(
          await observe(boundWorkspace, { sessionId: owner }),
        );
      }
      // Consume what this pass just wrote without waiting for the watch or the
      // next file interval.
      if (emitted > 0) runPass();
    } catch (error) {
      notice(
        `review-verify: observation pass failed (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    } finally {
      observing = false;
    }
  };
  const observeTimer: ReturnType<typeof setInterval> = setInterval(() => {
    void observeTick();
  }, observeIntervalMs);
  observeTimer.unref?.();

  return {
    get activeWork() {
      return activeTicks > 0 || observing;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearInterval(observeTimer);
      if (debounce) clearTimeout(debounce);
      watcher?.close();
    },
    tick,
  };
}
