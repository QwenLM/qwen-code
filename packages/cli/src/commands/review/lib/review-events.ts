/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The durable handoff from a clean review round to a deep-verification round.
//
// A review that ended clean writes one event here; the daemon's built-in
// consumer (serve/review-verify-automation.ts) reads it and spawns a sub-session
// running `/verify-pr <n> --publish`. The record is platform-neutral on purpose:
// the review pipeline already serves GitHub and Aone behind one provider
// registry, and the consumer — not the schema — decides which platforms it can
// verify today.
//
// Deliberately light on imports (node builtins, core's atomic writer and
// Storage, and the review path helpers): the daemon imports this module, and
// pulling the compose/platform chain into every serve process to read a JSON
// file would be the barrel-import cost the CLI's import rule exists to avoid.
// The producer resolves the verdict facts and passes them in.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import { reviewTrustStateDir } from './paths.js';

export const REVIEW_EVENT_SCHEMA_VERSION = 1;

/** How many dedupe keys `spawned.json` remembers. Far above any plausible
 *  clean-head rate for one workspace; eviction is FIFO and only ever discards
 *  the oldest verified heads. */
export const SPAWNED_KEY_CAP = 200;

export interface ReviewEventTarget {
  /**
   * The provider kind that produced this event (`github`, `aone`, …). A plain
   * string, not today's union: the reader must still recognise an event from a
   * provider added later, and the consumer — not the schema — decides which
   * platforms it can verify.
   */
  platform: string;
  /** The host the target lives on; `github.com` for default GitHub. */
  host: string;
  ownerRepo: string;
  number: number;
  /** The head the round reviewed and certified — the ledger anchor. */
  headSha: string;
}

export interface ReviewCleanEventV1 {
  schemaVersion: typeof REVIEW_EVENT_SCHEMA_VERSION;
  /** Digest of the dedupe key; also the pending file's stem. */
  eventId: string;
  createdAt: string;
  /** The session that ran the review, when the CLI exported one. The consumer
   *  needs it as the sub-session's caller: the launcher's concurrency bucket
   *  and depth-1 gate are keyed on it. */
  sessionId?: string;
  target: ReviewEventTarget;
  round: number;
  verdict: {
    event: string;
    critical: number;
    suggestion: number;
  };
  /** Workspace-relative path of the saved review artifact. */
  artifactPath: string;
}

/**
 * Host-trusted, outside every repository workspace — the same reason the rest
 * of `review-state` lives there. A pending event makes the daemon spawn a
 * session that executes PR code and publishes a comment, so a repository that
 * could write one could choose the prompt.
 */
export function reviewEventsDir(repositoryRoot: string): string {
  return join(reviewTrustStateDir(repositoryRoot), 'verify-events');
}

export function pendingEventsDir(repositoryRoot: string): string {
  return join(reviewEventsDir(repositoryRoot), 'pending');
}

/**
 * One verification per reviewed head, not per round: two clean rounds at the
 * same sha are the same evidence request. Round is deliberately absent.
 */
export function reviewEventDedupeKey(target: ReviewEventTarget): string {
  return [
    target.platform,
    target.host,
    target.ownerRepo,
    String(target.number),
    target.headSha,
  ].join(':');
}

export function reviewEventId(dedupeKey: string): string {
  return createHash('sha256').update(dedupeKey).digest('hex').slice(0, 16);
}

/**
 * The clean-round predicate, over facts the producer already holds.
 *
 * `anchorSha` is the `sha` of the composed body's `qwen-review-ledger` marker —
 * compose-review's own "this round certified its scope" decision, withheld on
 * every fail-closed cap (undecided blockers, unproven coverage, context
 * unavailable, …) except depth-only `unreviewed-dimension`. Re-deriving that
 * from `cappedBy` here would be a second, weaker predicate: two of its inputs
 * are not persisted at all.
 *
 * Returns the head to verify, or null when this round does not qualify.
 */
export function cleanRoundHeadSha(input: {
  event: string;
  critical: number;
  anchorSha: string | undefined;
}): string | null {
  if (input.event !== 'APPROVE' && input.event !== 'COMMENT') return null;
  if (input.critical !== 0) return null;
  const sha = input.anchorSha?.trim();
  return sha ? sha : null;
}

export interface EmitReviewCleanEventInput {
  /** The main project directory the artifact was saved against. */
  workspaceRoot: string;
  target: ReviewEventTarget;
  round: number;
  verdict: ReviewCleanEventV1['verdict'];
  artifactPath: string;
  sessionId?: string;
  /** Injectable for tests. */
  now?: () => Date;
}

export interface EmittedReviewCleanEvent {
  path: string;
  eventId: string;
}

/**
 * Write one pending event, atomically. The file name is the dedupe key's
 * digest, so re-emitting for the same head overwrites the same file rather than
 * queueing a second verification. Throws when the event cannot be written; the
 * producer treats that as best-effort and keeps its saved review.
 */
export function emitReviewCleanEvent(
  input: EmitReviewCleanEventInput,
): EmittedReviewCleanEvent {
  const key = reviewEventDedupeKey(input.target);
  const eventId = reviewEventId(key);
  const event: ReviewCleanEventV1 = {
    schemaVersion: REVIEW_EVENT_SCHEMA_VERSION,
    eventId,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    target: input.target,
    round: input.round,
    verdict: input.verdict,
    artifactPath: input.artifactPath,
  };
  const dir = pendingEventsDir(input.workspaceRoot);
  const path = join(dir, `${eventId}.json`);
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(event, null, 2)}\n`, {
    encoding: 'utf8',
    noFollow: true,
  });
  return { path, eventId };
}

export interface PendingReviewEvent {
  event: ReviewCleanEventV1;
  path: string;
}

/**
 * Every readable pending event, oldest first. A file that does not parse or
 * does not carry this schema is reported, not thrown and not deleted: the
 * consumer surfaces it the way the scheduled-task keepalive surfaces an
 * unreadable state file, and an unknown file in a host-trusted directory is
 * not this module's to remove.
 */
export function readPendingReviewEvents(repositoryRoot: string): {
  events: PendingReviewEvent[];
  unreadable: Array<{ path: string; reason: string }>;
} {
  const dir = pendingEventsDir(repositoryRoot);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return { events: [], unreadable: [] };
  }
  const events: PendingReviewEvent[] = [];
  const unreadable: Array<{ path: string; reason: string }> = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      const event = validateEvent(parsed);
      if (event) events.push({ event, path });
      else unreadable.push({ path, reason: 'not a v1 review clean event' });
    } catch (error) {
      unreadable.push({
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  events.sort((a, b) => a.event.createdAt.localeCompare(b.event.createdAt));
  return { events, unreadable };
}

/**
 * `ownerRepo` and `host` are interpolated into the prompt the daemon executes,
 * so the reader holds them to a charset that cannot carry a second flag or a
 * shell metacharacter. The producer already validated them against the
 * platform's own grammar (`isOwnerRepo`, `HOSTNAME_RE`); this is the same line
 * on the side that actually spawns, because a durable file can outlive the
 * version that wrote it and this directory is only as trustworthy as the
 * account that owns it.
 */
const EVENT_OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EVENT_HOST_RE = /^[A-Za-z0-9.-]+(?::\d+)?$/;

function validateEvent(value: unknown): ReviewCleanEventV1 | null {
  if (typeof value !== 'object' || value === null) return null;
  const e = value as Partial<ReviewCleanEventV1>;
  if (e.schemaVersion !== REVIEW_EVENT_SCHEMA_VERSION) return null;
  if (typeof e.eventId !== 'string' || e.eventId === '') return null;
  if (typeof e.createdAt !== 'string' || e.createdAt === '') return null;
  if (typeof e.artifactPath !== 'string') return null;
  if (e.sessionId !== undefined && typeof e.sessionId !== 'string') return null;
  if (!Number.isInteger(e.round) || (e.round as number) < 1) return null;
  const t = e.target;
  if (
    typeof t !== 'object' ||
    t === null ||
    typeof t.platform !== 'string' ||
    t.platform === '' ||
    typeof t.host !== 'string' ||
    !EVENT_HOST_RE.test(t.host) ||
    typeof t.ownerRepo !== 'string' ||
    !EVENT_OWNER_REPO_RE.test(t.ownerRepo) ||
    !Number.isInteger(t.number) ||
    (t.number as number) < 1 ||
    typeof t.headSha !== 'string' ||
    t.headSha === ''
  ) {
    return null;
  }
  const v = e.verdict;
  if (
    typeof v !== 'object' ||
    v === null ||
    typeof v.event !== 'string' ||
    !Number.isInteger(v.critical) ||
    !Number.isInteger(v.suggestion)
  ) {
    return null;
  }
  return e as ReviewCleanEventV1;
}

interface SpawnedLedger {
  v: 1;
  entries: Array<{ key: string; at: string; sessionId?: string }>;
}

function spawnedLedgerPath(repositoryRoot: string): string {
  return join(reviewEventsDir(repositoryRoot), 'spawned.json');
}

/** The heads this workspace already verified. Unreadable reads as empty only
 *  for the absent-file case: a corrupt ledger must not silently re-verify
 *  every head, so a parse failure throws and the consumer declines the pass. */
export function readSpawnedKeys(repositoryRoot: string): Set<string> {
  let raw: string;
  try {
    raw = readFileSync(spawnedLedgerPath(repositoryRoot), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
  const ledger = JSON.parse(raw) as SpawnedLedger;
  if (ledger?.v !== 1 || !Array.isArray(ledger.entries)) {
    throw new Error('spawned.json is not a v1 ledger');
  }
  return new Set(
    ledger.entries
      .filter((entry) => typeof entry?.key === 'string')
      .map((entry) => entry.key),
  );
}

/**
 * Record a head BEFORE spawning its verification (write-ahead). A daemon that
 * dies between the record and the spawn must not replay a round that may
 * already have published a comment; the cost is that a failed spawn is not
 * retried, which the consumer logs.
 */
export function recordSpawnedKey(
  repositoryRoot: string,
  key: string,
  sessionId?: string,
  now: () => Date = () => new Date(),
): void {
  const path = spawnedLedgerPath(repositoryRoot);
  let entries: SpawnedLedger['entries'] = [];
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as SpawnedLedger;
    if (ledger?.v === 1 && Array.isArray(ledger.entries)) {
      entries = ledger.entries.filter(
        (entry) => typeof entry?.key === 'string' && entry.key !== key,
      );
    }
  } catch {
    // Absent or corrupt: start a fresh ledger. The write-ahead guarantee is
    // about the spawn that follows THIS record, and a corrupt ledger already
    // stopped the pass that would have read it.
  }
  entries.push({
    key,
    at: now().toISOString(),
    ...(sessionId ? { sessionId } : {}),
  });
  while (entries.length > SPAWNED_KEY_CAP) entries.shift();
  mkdirSync(reviewEventsDir(repositoryRoot), { recursive: true });
  atomicWriteFileSync(
    path,
    `${JSON.stringify({ v: 1, entries } satisfies SpawnedLedger, null, 2)}\n`,
    { encoding: 'utf8', noFollow: true },
  );
}

/** Drop a pending event the consumer has finished with (spawned or declined). */
export function removePendingEvent(path: string): void {
  rmSync(path, { force: true });
}
