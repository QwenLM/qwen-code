/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  getGlobalQwenDir,
  getWorkspaceScopeDirName,
  MANAGED_OUTBOUND_LIMIT,
  validManagedReceipt,
} from '@qwen-code/channel-base';
import type {
  ManagedReceipt,
  ManagedInboundEvent,
} from '@qwen-code/channel-base';

export type { ManagedReceipt };

// H5f of #12827: the managed GitHub adapter's own locked state. The cursor
// (notification watermark plus the dispatched-comment ring) is the platform
// consumption commitment; pending holds the full inbound events because a
// marked-read notification cannot be re-listed; outbound is the sent-but-
// unreceipted segment ledger. Every claim persists before its side effect,
// so a restart replays the same event or reports the same segment unknown,
// never a second input and never a second send. See
// docs/design/2026-11-16-managed-channel-github-adapter.md.

export const MANAGED_GITHUB_PENDING_LIMIT = 32;
export const DISPATCHED_COMMENTS_LIMIT = 500;

/**
 * The PR-watch transition vocabulary of the first slice (state_change is
 * deferred). Mirrors the daemon's event set, minus state_change.
 */
export type ManagedGithubPrTransition =
  | 'ci_failure'
  | 'merge_conflict'
  | 'head_change';

export const MANAGED_GITHUB_PR_TRANSITIONS: readonly ManagedGithubPrTransition[] =
  ['ci_failure', 'merge_conflict', 'head_change'];

/** The CI rollup vocabulary, one definition with the daemon's aggregateChecks. */
export type ManagedGithubCiAggregate =
  | 'passing'
  | 'failing'
  | 'pending'
  | 'none';

/**
 * Per-PR pending cap, the daemon's bound: overflow drops the oldest with a
 * log line instead of growing the state file without limit.
 */
export const MANAGED_GITHUB_PR_WATCH_PENDING_LIMIT = 16;
/** Fired-ring cap, the retired channel watch's bound (MAX_FIRED_KEYS). */
export const MANAGED_GITHUB_PR_WATCH_FIRED_LIMIT = 64;

/**
 * One detected transition durably queued for injection. The full inject
 * identity rides the entry because a restart re-drives it without re-listing
 * bindings, and the control plane forces the target Session from its own
 * binding — the adapter never chooses one.
 */
export interface ManagedGithubPrWatchPending {
  /** Local dedupe key; ci_failure keys match by PR+SHA prefix. */
  key: string;
  /**
   * Durable per-PR occurrence number fed to the control plane's input-id
   * derivation: a legitimate recurrence is a new episode (new input id), a
   * redelivery of this same pending entry reuses it (same input id).
   */
  episode: number;
  owner: string;
  repo: string;
  prNumber: number;
  transition: ManagedGithubPrTransition;
  headSha: string;
  /** Sanitized transition summary for the injected prompt's evidence. */
  evidence: string;
  detectedAt: string;
}

/**
 * Persisted per-PR observation backing edge-triggered watch events, the
 * retired channel watch's PrWatchEntry shape: the baseline advances with
 * each observation, ciFiredSha pins ci_failure once-per-head across fired-ring
 * eviction, and seq numbers non-ci episodes so a legitimate recurrence
 * (dirty → clean → dirty, a SHA revisit) fires again.
 */
export interface ManagedGithubPrWatchEntry {
  headSha?: string;
  mergeableState?: string;
  ci?: ManagedGithubCiAggregate;
  ciFiredSha?: string;
  seq?: number;
  /** Monotonic per-PR occurrence counter; the last assigned pending episode. */
  episode?: number;
  /** Dedupe keys already injected, oldest first (capped ring). */
  fired?: string[];
  /** Detected but not yet injected transitions, oldest first (capped). */
  pending?: ManagedGithubPrWatchPending[];
}

export interface ManagedGithubWatchState {
  /** Keyed by lowercased `owner/repo#prNumber`. */
  prs: Record<string, ManagedGithubPrWatchEntry>;
}

export interface ManagedGithubPendingEvent {
  eventId: string;
  /**
   * The full admission, persisted because marking a notification thread read
   * removes it from the unread list: after a restart the claim re-drives this
   * exact event, never a comment re-fetched from the API (which may have been
   * edited or deleted since admission).
   */
  event: ManagedInboundEvent;
  /** The notification thread to mark read once this event is submitted. */
  notificationThreadId: string;
  held?: boolean;
}

export interface ManagedGithubOutboundSegment {
  deliveryId: string;
  ordinal: number;
  receipt?: ManagedReceipt;
}

export interface ManagedGithubCursor {
  /** The notification window watermark; null before the first poll. */
  lastProcessedAt: string | null;
  /** Comment keys already submitted; a work-saving filter over idempotency. */
  dispatchedComments: string[];
}

export interface ManagedGithubState {
  version: 1;
  generation: number;
  instanceRefusals?: number;
  cursor: ManagedGithubCursor;
  pending: ManagedGithubPendingEvent[];
  outbound: ManagedGithubOutboundSegment[];
  /** PR-watch baselines, fired-ring and pending; absent means no watch yet. */
  watch?: ManagedGithubWatchState;
}

function validPrWatchEntry(value: unknown): value is ManagedGithubPrWatchEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as ManagedGithubPrWatchEntry;
  const nonEmptyStringOrUndefined = (v: unknown): boolean =>
    v === undefined || (typeof v === 'string' && v.length > 0);
  return (
    nonEmptyStringOrUndefined(entry.headSha) &&
    nonEmptyStringOrUndefined(entry.mergeableState) &&
    nonEmptyStringOrUndefined(entry.ciFiredSha) &&
    (entry.ci === undefined ||
      entry.ci === 'passing' ||
      entry.ci === 'failing' ||
      entry.ci === 'pending' ||
      entry.ci === 'none') &&
    (entry.seq === undefined ||
      (Number.isSafeInteger(entry.seq) && entry.seq >= 0)) &&
    (entry.episode === undefined ||
      (Number.isSafeInteger(entry.episode) && entry.episode >= 0)) &&
    (entry.fired === undefined ||
      (Array.isArray(entry.fired) &&
        entry.fired.length <= MANAGED_GITHUB_PR_WATCH_FIRED_LIMIT &&
        entry.fired.every(
          (key) => typeof key === 'string' && key.length > 0,
        ))) &&
    (entry.pending === undefined ||
      (Array.isArray(entry.pending) &&
        entry.pending.length <= MANAGED_GITHUB_PR_WATCH_PENDING_LIMIT &&
        entry.pending.every(
          (p) =>
            !!p &&
            typeof p === 'object' &&
            typeof p.key === 'string' &&
            p.key.length > 0 &&
            Number.isSafeInteger(p.episode) &&
            p.episode >= 1 &&
            typeof p.owner === 'string' &&
            p.owner.length > 0 &&
            typeof p.repo === 'string' &&
            p.repo.length > 0 &&
            Number.isSafeInteger(p.prNumber) &&
            p.prNumber >= 1 &&
            MANAGED_GITHUB_PR_TRANSITIONS.includes(p.transition) &&
            typeof p.headSha === 'string' &&
            p.headSha.length > 0 &&
            typeof p.evidence === 'string' &&
            typeof p.detectedAt === 'string' &&
            !Number.isNaN(Date.parse(p.detectedAt)),
        )))
  );
}

export function validManagedGithubState(
  value: unknown,
): value is ManagedGithubState {
  if (!value || typeof value !== 'object') return false;
  const state = value as ManagedGithubState;
  return (
    state.version === 1 &&
    Number.isSafeInteger(state.generation) &&
    state.generation >= 1 &&
    (state.instanceRefusals === undefined ||
      (Number.isSafeInteger(state.instanceRefusals) &&
        state.instanceRefusals >= 0)) &&
    !!state.cursor &&
    typeof state.cursor === 'object' &&
    (state.cursor.lastProcessedAt === null ||
      (typeof state.cursor.lastProcessedAt === 'string' &&
        state.cursor.lastProcessedAt.length > 0 &&
        !Number.isNaN(Date.parse(state.cursor.lastProcessedAt)))) &&
    Array.isArray(state.cursor.dispatchedComments) &&
    state.cursor.dispatchedComments.length <= DISPATCHED_COMMENTS_LIMIT &&
    state.cursor.dispatchedComments.every(
      (entry) => typeof entry === 'string' && entry.length > 0,
    ) &&
    Array.isArray(state.pending) &&
    state.pending.length <= MANAGED_GITHUB_PENDING_LIMIT &&
    state.pending.every(
      (entry) =>
        entry &&
        typeof entry.eventId === 'string' &&
        entry.eventId.length > 0 &&
        !!entry.event &&
        typeof entry.event === 'object' &&
        entry.event.platformEventId === entry.eventId &&
        typeof entry.event.text === 'string' &&
        typeof entry.notificationThreadId === 'string' &&
        entry.notificationThreadId.length > 0,
    ) &&
    Array.isArray(state.outbound) &&
    state.outbound.length <= MANAGED_OUTBOUND_LIMIT &&
    state.outbound.every(
      (entry) =>
        entry &&
        typeof entry.deliveryId === 'string' &&
        entry.deliveryId.length > 0 &&
        Number.isSafeInteger(entry.ordinal) &&
        entry.ordinal >= 0 &&
        validManagedReceipt(entry.receipt),
    ) &&
    (state.watch === undefined ||
      (!!state.watch &&
        typeof state.watch === 'object' &&
        !Array.isArray(state.watch) &&
        !!state.watch.prs &&
        typeof state.watch.prs === 'object' &&
        !Array.isArray(state.watch.prs) &&
        Object.values(state.watch.prs).every(validPrWatchEntry)))
  );
}

export class ManagedGithubStateStore {
  readonly directory: string;
  readonly file: string;

  constructor(name: string, cwd: string, baseUrl: string) {
    // One directory per channel name per endpoint per workspace, beside the
    // other channel state. Credentials never define identity. The lock
    // serializes concurrent managed instances of this name + endpoint; it
    // does not cross-lock the Legacy GitHub channel, so the operator must run
    // exactly one consumer per bot identity.
    const key = createHash('sha256')
      .update(`${name}\u0000${baseUrl}`)
      .digest('hex')
      .slice(0, 16);
    this.directory = join(
      getGlobalQwenDir(),
      'channels',
      getWorkspaceScopeDirName(cwd),
      `github-${key}`,
    );
    this.file = join(this.directory, 'managed-state.json');
  }

  load(): ManagedGithubState | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!validManagedGithubState(value)) throw new Error('invalid state');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(
        'Managed GitHub state is unreadable or invalid; restore it before restarting.',
      );
    }
  }

  save(state: ManagedGithubState): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(state));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.file);
    } catch (error) {
      // The fixed sentence keeps platform data out of the message, but the fs
      // error rides on `cause` so the adapter's logs can name ENOSPC/EACCES.
      throw new Error(
        'Managed GitHub state could not be saved; admission stopped.',
        { cause: error },
      );
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
