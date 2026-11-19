/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
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
 * Durable per-PR episode-watermark cap. The watermark outlives prune/rebind
 * (the admission ledger is permanent), so it is bounded separately from the
 * prunable baselines; overflow evicts the oldest watermark.
 */
export const MANAGED_GITHUB_PR_WATCH_EPISODE_LIMIT = 1024;

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
  /**
   * Rotation offset into the stably-ordered binding list: each tick observes a
   * capped window starting here and advances, so every binding is observed
   * across successive ticks instead of only the first cap (the daemon's
   * sweepStart). Absent means start at the head of the list.
   */
  sweepStart?: number;
  /**
   * Durable per-PR occurrence watermark keyed like `prs`, carried across
   * prune/rebind: the admission ledger is permanent and keyed without a
   * binding discriminant, so a rebind must resume the episode counter rather
   * than restart it and re-derive an already-admitted input id.
   */
  episodes?: Record<string, number>;
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
        Object.values(state.watch.prs).every(validPrWatchEntry) &&
        (state.watch.sweepStart === undefined ||
          (Number.isSafeInteger(state.watch.sweepStart) &&
            state.watch.sweepStart >= 0)) &&
        (state.watch.episodes === undefined ||
          (!!state.watch.episodes &&
            typeof state.watch.episodes === 'object' &&
            !Array.isArray(state.watch.episodes) &&
            Object.keys(state.watch.episodes).length <=
              MANAGED_GITHUB_PR_WATCH_EPISODE_LIMIT &&
            Object.values(state.watch.episodes).every(
              (episode) => Number.isSafeInteger(episode) && episode >= 1,
            )))))
  );
}

export class ManagedGithubStateStore {
  readonly directory: string;
  readonly file: string;

  constructor(name: string, cwd: string, baseUrl: string, identityKey = '') {
    // The lock directory is keyed by the configured entry (channel name +
    // endpoint baseUrl) per workspace — NOT by destination — so two instances
    // of the same name + endpoint contend for one connection lock even when
    // they target different control-plane destinations; a per-destination lock
    // would let both run concurrently and duplicate inbound processing. The
    // ledger FILE beneath that directory is keyed by the full registration
    // identity (control plane + tenant + channel + actor + workspace +
    // cwd-relative), so a pending comment staged under one registration is
    // never loaded or replayed under another. Credentials never define
    // identity. The lock does not cross-lock the Legacy GitHub channel, so the
    // operator must run exactly one consumer per bot identity.
    const entryKey = createHash('sha256')
      .update(`${name}\u0000${baseUrl}`)
      .digest('hex')
      .slice(0, 16);
    this.directory = join(
      getGlobalQwenDir(),
      'channels',
      getWorkspaceScopeDirName(cwd),
      `github-${entryKey}`,
    );
    const ledgerKey = createHash('sha256')
      .update(identityKey)
      .digest('hex')
      .slice(0, 16);
    this.file = join(this.directory, `managed-state-${ledgerKey}.json`);
  }

  load(): ManagedGithubState | undefined {
    // Name the file and keep the cause, and keep an I/O failure distinguishable
    // from a corrupt state: the directory now holds a ledger per registration,
    // so the operator must know WHICH file is unreadable (e.g. EISDIR) versus
    // merely invalid, while a sibling registration's healthy ledger sits beside
    // it. Mirrors the WeCom / DingTalk stores this change parallels.
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(
        `Managed GitHub state at ${this.file} could not be read; restore it before restarting.`,
        { cause: error },
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Managed GitHub state at ${this.file} is not valid JSON; restore it before restarting.`,
        { cause: error },
      );
    }
    if (!validManagedGithubState(value)) {
      throw new Error(
        `Managed GitHub state at ${this.file} is invalid; restore it before restarting.`,
      );
    }
    return value;
  }

  /**
   * The pre-registration-identity ledger this entry used before the upgrade.
   * A sibling `managed-state.json` is stranded by the upgrade: its staged-but-
   * unadmitted claims were never seen by the control plane (only `submitInbound`
   * makes a claim visible), and the fresh ledger's null cursor starts the poll
   * window at connect time, so the old notification is not re-listed. Report
   * the path and its pending / outbound counts so the drop is explicit, never
   * silent. Detection is NOT gated on the identity-keyed ledger being absent: a
   * rollback to the pre-upgrade build can stage fresh claims into
   * `managed-state.json` after a keyed ledger already exists, and those must
   * still be reported. The caller archives the file once the start succeeds
   * (`archiveStrandedLegacy`). The legacy ledger is NOT adopted — adopting it
   * would replay one registration's pending into another, the cross-ownership
   * hazard the identity keying prevents.
   *
   * `readable` distinguishes a legacy whose contents could not be read or
   * parsed (counts unknown, reported as 0 but flagged) from one that parsed to
   * an empty ledger: an unreadable legacy certainly strands whatever it held,
   * so the caller must not render it as a quiescent "nothing was lost".
   */
  strandedLegacyLedger():
    | {
        path: string;
        pending: number;
        outbound: number;
        watchPending: number;
        watchPendingKeys: string[];
        readable: boolean;
        watermark: string | null;
      }
    | undefined {
    const legacyPath = join(this.directory, 'managed-state.json');
    if (!existsSync(legacyPath)) return undefined;
    let pending = 0;
    let outbound = 0;
    let watchPending = 0;
    const watchPendingKeys: string[] = [];
    let readable = true;
    let watermark: string | null = null;
    try {
      const value = JSON.parse(readFileSync(legacyPath, 'utf8')) as {
        pending?: unknown[];
        outbound?: unknown[];
        cursor?: { lastProcessedAt?: unknown };
        watch?: { prs?: unknown };
      } | null;
      // A parseable non-ledger (`{}`, `[]`, `null`, or an object without the
      // ledger's pending/outbound arrays) is not a quiescent empty ledger: it
      // is an unrecognized file whose claims are unknown. Flag it unreadable so
      // the notice reports a possible loss, never a loss-free "0 pending / 0
      // outbound" all-clear (deferred item 7).
      const isLedgerShape =
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Array.isArray(value.pending) &&
        Array.isArray(value.outbound);
      if (!isLedgerShape) readable = false;
      const pendingList = value?.pending;
      const outboundList = value?.outbound;
      pending = Array.isArray(pendingList) ? pendingList.length : 0;
      // Only un-receipted segments are an unknown-status loss: a segment that
      // already carries a persisted receipt has a known delivery outcome, so it
      // must not inflate the "un-receipted outbound ... status is unknown"
      // clause (deferred item 9).
      outbound = Array.isArray(outboundList)
        ? outboundList.filter(
            (segment) =>
              !(
                segment &&
                typeof segment === 'object' &&
                (segment as { receipt?: unknown }).receipt
              ),
          ).length
        : 0;
      // The legacy notification watermark: the fresh ledger's null cursor
      // restarts the poll window at connect time, so unread notifications
      // updated after this watermark while the bot was down are never listed.
      // Surfacing it lets the notice name that skipped window even when the
      // legacy staged no pending/outbound (R1-4).
      const lastProcessedAt = value?.cursor?.lastProcessedAt;
      watermark = typeof lastProcessedAt === 'string' ? lastProcessedAt : null;
      // The legacy watch.prs queue holds detected-but-undelivered transitions
      // (R3-1). The fresh ledger re-baselines watch.prs empty and does NOT
      // adopt them — injecting one registration's detected events under
      // another is the cross-ownership replay the keying prevents — so they
      // are stranded work. Count the PR entries whose queue is non-empty so
      // the notice names that loss instead of a quiescent "0 pending", and
      // collect their keys so the caller can tell whether the loaded ledger
      // holds a baseline to re-detect them against (R5). The durable episode
      // counters are carried separately, entry-scoped, by entryWatchEpisodes().
      const rawPrs = value?.watch?.prs;
      if (!!rawPrs && typeof rawPrs === 'object' && !Array.isArray(rawPrs)) {
        for (const [key, entry] of Object.entries(rawPrs)) {
          const queue = (entry as { pending?: unknown } | null)?.pending;
          if (Array.isArray(queue) && queue.length > 0) {
            watchPending += 1;
            watchPendingKeys.push(key);
          }
        }
      }
    } catch {
      // A corrupt or unreadable legacy still strands; flag it so the caller
      // reports unknown counts and a possible loss, never a silent "empty".
      readable = false;
    }
    return {
      path: legacyPath,
      pending,
      outbound,
      watchPending,
      watchPendingKeys,
      readable,
      watermark,
    };
  }

  /**
   * The entry-scoped durable PR-watch episode counters, merged across every
   * ledger this entry directory holds: the live legacy, each registration's
   * identity-keyed ledger, and the `.stranded-*` archives (R3-1). The
   * admission ledger is permanent and keyed without a registration
   * discriminant, so the counters must outlive the legacy archive:
   * registration A adopts them and archives the legacy, then registration B
   * must still resume them rather than restart at 0 and re-derive an
   * already-admitted input id (a silently deduped recurrence). Reading the
   * archives — not just the live legacy — is what makes the carry survive the
   * first start's rename. `Math.max` per key only errs toward a new id (the
   * input id already binds tenant/channel), and the result is sanitized to the
   * validator's bound (safe integers >= 1, capped at
   * MANAGED_GITHUB_PR_WATCH_EPISODE_LIMIT) so the merged state passes the next
   * load(). Best-effort: an unreadable or corrupt sibling is skipped, never a
   * startup failure, but its name is returned in `skipped` so the caller can
   * log that a counter source was unreadable rather than dropping it silently
   * (deferred item 8). `episodes` is undefined when no ledger carries counters.
   */
  entryWatchEpisodes(): {
    episodes: Record<string, number> | undefined;
    skipped: string[];
  } {
    const skipped: string[] = [];
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      return { episodes: undefined, skipped };
    }
    const merged: Record<string, number> = {};
    for (const name of names) {
      // The legacy ledger, the identity-keyed ledgers, and the legacy archives
      // — never an in-flight <uuid>.tmp or the lock metadata.
      if (!/^managed-state(-[0-9a-f]{16})?\.json(\.stranded-.+)?$/.test(name)) {
        continue;
      }
      const filePath = join(this.directory, name);
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch {
        skipped.push(filePath);
        continue;
      }
      const raw = (value as { watch?: { episodes?: unknown } } | null)?.watch
        ?.episodes;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      for (const [key, entry] of Object.entries(raw)) {
        if (Number.isSafeInteger(entry) && (entry as number) >= 1) {
          merged[key] = Math.max(merged[key] ?? 0, entry as number);
        }
      }
    }
    const keys = Object.keys(merged);
    if (keys.length === 0) return { episodes: undefined, skipped };
    // Re-cap to the validator's bound by evicting the OLDEST keys — the head of
    // insertion order — keeping the tail, the same direction as the live
    // watermark eviction (observePr deletes episodes[keys[i]] for i < len-cap).
    // Keeping the head instead would drop the most recently merged counters
    // first, so a counter only a late-walked legacy/archive holds would be the
    // one lost at the bound — the silent dedupe this carry exists to prevent.
    // At the bound something must be dropped; this is a bounded, RECOVERABLE
    // tradeoff (deferred item 10): an evicted counter still lives in its source
    // file (keyed ledger or archive) and is re-merged on the next start, and
    // observePr seeds a recurrence from the prs entry's own episode when the
    // watermark is absent, so a surviving baseline still resumes the counter.
    // Any loss is bounded to the cap-overflow edge, not a silent restart at 0.
    const capped: Record<string, number> = {};
    for (const key of keys.slice(
      Math.max(0, keys.length - MANAGED_GITHUB_PR_WATCH_EPISODE_LIMIT),
    )) {
      capped[key] = merged[key]!;
    }
    return { episodes: capped, skipped };
  }

  /**
   * Archive a reported legacy ledger so it is not re-announced on every later
   * start (and a second registration of the entry is not told the first
   * registration's claims were its own). Renaming — not deleting — keeps the
   * stranded claims inspectable, and a rollback that stages a fresh
   * `managed-state.json` is detected again on the next upgrade. This never
   * adopts the claims into the keyed ledger. Returns the archived path, or
   * undefined when there is nothing to archive or the rename fails (the file
   * then stays and is reported again next start — degraded, never a startup
   * failure).
   */
  archiveStrandedLegacy(): string | undefined {
    const legacyPath = join(this.directory, 'managed-state.json');
    if (!existsSync(legacyPath)) return undefined;
    const archived = `${legacyPath}.stranded-${randomUUID()}`;
    try {
      renameSync(legacyPath, archived);
      return archived;
    } catch {
      return undefined;
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
