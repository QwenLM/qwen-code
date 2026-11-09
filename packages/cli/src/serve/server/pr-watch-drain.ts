/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_BOUND_ROLE_GUIDANCE,
  resolveBoundActionTemplate,
  renderBoundActionTemplate,
  buildBoundEventPrompt,
  type BoundActionValues,
} from '@qwen-code/channel-base';
import type { SessionPrBindingSummary } from '../routes/session-pr-bindings.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import type { PathMutexRegistry } from '../fs/path-mutex-registry.js';
import { prWatchIdentityFromUrl } from './pr-watch-observation.js';
import { DaemonDrainingError } from './session-archive.js';
import {
  claimPrWatchOwnershipSync,
  deletePrWatchStateSync,
  parsePrWatchState,
  PR_WATCH_DELIVERED_CAP,
  prWatchFilePath,
  readPrWatchStateSync,
  releaseOwnedPrWatchSync,
  writePrWatchStateSync,
  type PrWatchIdentity,
  type PrWatchPendingEntry,
  type PrWatchRoleGroup,
  type PrWatchState,
} from './pr-watch-store.js';

/** Pending entries older than this are dropped with a log line (master §5). */
export const PR_WATCH_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The deletion horizon matches the pending age limit (master §2). */
export const PR_WATCH_UNBOUND_AGE_MS = PR_WATCH_PENDING_AGE_MS;
/** Retained rows kept across partial scans, oldest dropped first (master §4). */
export const PR_WATCH_MAX_PARTIAL_RETAINED = 1024;
/** Dormant restores started without waiting, at most this many at once. */
export const PR_WATCH_MAX_CONCURRENT_RESTORES = 4;
/** A Gone recipient is excluded for this long before it rejoins (master §4). */
export const PR_WATCH_GONE_REJOIN_MS = 60 * 60 * 1000;

const ROLE_GROUPS: readonly PrWatchRoleGroup[] = [
  'review',
  'verify',
  'fix',
  'untyped',
];

export type PrWatchWakeOutcome =
  | { kind: 'restored'; release: () => Promise<void> }
  | { kind: 'gone' }
  | { kind: 'unavailable' };

export interface PrWatchRecipient {
  sessionId: string;
  workspaceCwd: string;
  role?: 'review' | 'verify' | 'fix';
  url: string;
}

export interface PrWatchDrainDeps {
  watchDir: string;
  locks: PathMutexRegistry;
  scanBindings: (
    runtime: WorkspaceRuntime,
  ) => Promise<{ bindings: SessionPrBindingSummary[]; partial: boolean }>;
  resolveRuntime: (workspaceCwd: string) => WorkspaceRuntime | undefined;
  isSessionLive: (runtime: WorkspaceRuntime, sessionId: string) => boolean;
  wakeSession: (
    sessionId: string,
    workspaceCwd: string,
  ) => Promise<PrWatchWakeOutcome>;
  admitPrompt: (
    runtime: WorkspaceRuntime,
    sessionId: string,
    promptText: string,
    idempotencyKey: string,
  ) => Promise<{ deduplicated: boolean }>;
  readPushedHeads: (
    recipient: PrWatchRecipient,
  ) => Promise<ReadonlySet<string> | undefined>;
  actions?: ReadonlyMap<string, string>;
  wakeDormant?: boolean;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * The in-flight mark. `admitted` distinguishes a restore/admission still
 * running (false) from an admission whose recording write failed (true): a
 * later drain retries only the write for an admitted mark, never re-resolving
 * or re-admitting the key (master §5).
 */
export interface PrWatchInFlightMark {
  sessionId: string;
  admitted: boolean;
  group: PrWatchRoleGroup | null;
}

export interface PrWatchDrainState {
  retained: Map<string, SessionPrBindingSummary>;
  inFlight: Map<string, PrWatchInFlightMark>;
  restoring: Set<string>;
  /** Recipients with a permanent Gone outcome, sessionId -> excluded-at ms. */
  gone: Map<string, number>;
  /**
   * Resolves once no tick and no restore is in flight, so a shutting-down
   * owner can release its record without a successor overlapping it. An
   * admitted mark left by a failed recording write is NOT in-flight work — it
   * is a retry the next owner performs — so it never holds this open.
   * Unbounded on purpose: the caller bounds it, since only the caller knows
   * its shutdown deadline.
   */
  idle: () => Promise<void>;
}

interface PrWatchDrainLiveness {
  activeTicks: number;
  waiters: Set<() => void>;
}

/** Kept out of the public state so only this module can settle it. */
const drainLiveness = new WeakMap<PrWatchDrainState, PrWatchDrainLiveness>();

function livenessOf(state: PrWatchDrainState): PrWatchDrainLiveness {
  let liveness = drainLiveness.get(state);
  if (!liveness) {
    liveness = { activeTicks: 0, waiters: new Set() };
    drainLiveness.set(state, liveness);
  }
  return liveness;
}

function settleIfIdle(state: PrWatchDrainState): void {
  const liveness = drainLiveness.get(state);
  if (!liveness || liveness.activeTicks > 0 || state.restoring.size > 0) return;
  for (const resolve of liveness.waiters) resolve();
  liveness.waiters.clear();
}

export function createPrWatchDrainState(): PrWatchDrainState {
  const state: PrWatchDrainState = {
    retained: new Map(),
    inFlight: new Map(),
    restoring: new Set(),
    gone: new Map(),
    idle: () =>
      new Promise<void>((resolve) => {
        const liveness = livenessOf(state);
        if (liveness.activeTicks === 0 && state.restoring.size === 0) {
          resolve();
          return;
        }
        liveness.waiters.add(resolve);
      }),
  };
  livenessOf(state);
  return state;
}

export interface PrWatchDrainResult {
  claimed: boolean;
  delivered: number;
  dropped: number;
  deleted: number;
}

/**
 * Default bound on the shutdown wait. This is the only thing keeping `close()`
 * finite: `closeOnce` gives app drains no deadline of their own, and its
 * `DEFAULT_CLOSE_TIMEOUT_MS` bounds the listener close, which runs concurrently
 * with the drains. Kept equal to that 5s so shutdown stays ~5s rather than
 * becoming additive — raising it silently lengthens every daemon shutdown.
 */
export const PR_WATCH_SHUTDOWN_WAIT_MS = 5_000;

export interface PrWatchShutdownOptions {
  state: PrWatchDrainState;
  watchDir: string;
  /** Stops the refresh timer so no new tick can start. */
  stopTimer: () => void;
  /**
   * Settles the refresh tick that holds the owner record. The observation
   * claims it for the whole tick but is not drain work, so `state.idle()`
   * cannot see it — releasing without this would let a successor claim and
   * deliver while this daemon is still viewing.
   */
  waitForTick?: () => Promise<void>;
  timeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * Stop the watch, let in-flight work settle, then release the owner record —
 * in that order, so a successor never overlaps this daemon's observation,
 * restores and admissions (master §2).
 *
 * On timeout the record is deliberately KEPT. Releasing it while a restore is
 * still admitting would let a successor claim and deliver the same transition
 * twice; leaving it is safe because the claim sweeps a record whose process is
 * provably gone, so the successor takes over once this process exits.
 */
export async function stopPrWatch(
  options: PrWatchShutdownOptions,
): Promise<void> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? PR_WATCH_SHUTDOWN_WAIT_MS;
  options.stopTimer();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  // Sequential, not parallel: a tick that is still observing has not entered a
  // drain tick yet, so sampling drain-idle alongside it resolves immediately —
  // and that tick then dispatches a restore which outlives it. Drain-idle has
  // to be sampled after the tick ends. Both arms share one timeout budget.
  const settled = (async () => {
    await options.waitForTick?.();
    await options.state.idle();
  })();
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (timedOut) {
    log(
      `PR watch: shutdown wait exceeded ${timeoutMs}ms with work still in flight; keeping the owner record for the successor to sweep`,
    );
    return;
  }
  if (releaseOwnedPrWatchSync(options.watchDir)) {
    log('PR watch: released the owner record on shutdown');
  }
}

function roleGroupOf(role: PrWatchRecipient['role']): PrWatchRoleGroup {
  return role ?? 'untyped';
}

function groupKey(key: string, group: PrWatchRoleGroup | null): string {
  return group === null ? key : `${key}:${group}`;
}

function sameWatchIdentity(a: PrWatchIdentity, b: PrWatchIdentity): boolean {
  return a.host === b.host && a.repo === b.repo && a.number === b.number;
}

/**
 * Merge the aggregated scan rows with the retained rows. On a partial scan,
 * sessions the scan does not list keep their last row (bounded, oldest
 * dropped first); on a complete scan a retained row the scan omits is dropped.
 * Channel-owned rows are kept: the observation watches their PRs too, so
 * dropping them here would make a complete scan delete a file the observation
 * keeps rewriting. They are excluded from recipients, not from coverage.
 */
export function mergeBindingRows(
  scanned: readonly SessionPrBindingSummary[],
  partial: boolean,
  state: PrWatchDrainState,
  log: (message: string) => void,
): Map<string, SessionPrBindingSummary> {
  const rows = new Map<string, SessionPrBindingSummary>();
  for (const summary of scanned) {
    rows.set(summary.sessionId, summary);
  }
  if (partial) {
    for (const [sessionId, summary] of state.retained) {
      if (!rows.has(sessionId)) rows.set(sessionId, summary);
    }
    if (rows.size > PR_WATCH_MAX_PARTIAL_RETAINED) {
      const ordered = [...rows.values()].sort(
        (a, b) => recencyOf(b) - recencyOf(a),
      );
      rows.clear();
      for (const summary of ordered.slice(0, PR_WATCH_MAX_PARTIAL_RETAINED)) {
        rows.set(summary.sessionId, summary);
      }
      log(
        `PR watch drain: partial-scan retention exceeded ${PR_WATCH_MAX_PARTIAL_RETAINED}; dropped the oldest rows`,
      );
    }
  }
  state.retained = new Map(rows);
  return rows;
}

function recencyOf(summary: SessionPrBindingSummary): number {
  const parsed = summary.updatedAt ? Date.parse(summary.updatedAt) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

interface Binder {
  summary: SessionPrBindingSummary;
  url: string;
  role?: 'review' | 'verify' | 'fix';
}

function bindersOf(
  rows: ReadonlyMap<string, SessionPrBindingSummary>,
  identity: PrWatchIdentity,
): Binder[] {
  const binders: Binder[] = [];
  for (const summary of rows.values()) {
    for (const entry of summary.prs) {
      const entryIdentity = prWatchIdentityFromUrl(entry.url);
      if (!entryIdentity || !sameWatchIdentity(entryIdentity, identity)) {
        continue;
      }
      binders.push({
        summary,
        url: entry.url,
        ...(entry.role !== undefined ? { role: entry.role } : {}),
      });
    }
  }
  binders.sort((a, b) => recencyOf(b.summary) - recencyOf(a.summary));
  return binders;
}

function toRecipient(binder: Binder): PrWatchRecipient {
  return {
    sessionId: binder.summary.sessionId,
    workspaceCwd: binder.summary.workspaceCwd,
    ...(binder.role !== undefined ? { role: binder.role } : {}),
    url: binder.url,
  };
}

/**
 * Resolve the recipients of one PR for one transition type: every candidate
 * of each matched role group in recency order (one group without actions), so
 * the drain can re-resolve past an excluded leader. Channel-owned sessions are
 * never recipients. `matchedGroups` lists the groups whose template chain
 * resolves, so the drain knows when every group has been served.
 */
export function resolvePrRecipients(
  rows: ReadonlyMap<string, SessionPrBindingSummary>,
  identity: PrWatchIdentity,
  actions: ReadonlyMap<string, string> | undefined,
  eventType: string,
): { recipients: PrWatchRecipient[]; matchedGroups: PrWatchRoleGroup[] } {
  const binders = bindersOf(rows, identity).filter(
    (b) => b.summary.sourceType !== 'channel',
  );
  // Candidates are returned in recency order so the drain can re-resolve to
  // the next binder when the leader is excluded (self-push or Gone); the
  // single winner is the first eligible candidate it delivers to.
  if (actions === undefined) {
    return { recipients: binders.map(toRecipient), matchedGroups: [] };
  }
  const matchedGroups = ROLE_GROUPS.filter(
    (group) =>
      resolveBoundActionTemplate(
        actions,
        group === 'untyped' ? undefined : group,
        eventType,
      ) !== undefined,
  );
  const recipients = binders
    .filter((b) => matchedGroups.includes(roleGroupOf(b.role)))
    .map(toRecipient);
  return { recipients, matchedGroups };
}

/**
 * The owner/repo as the winner's bound URL spells it. The watch identity is
 * lowercased for matching and file naming, so it must not drive display
 * (master §4: `%repo%` keeps the binding URL's case).
 */
function displayRepo(bindingUrl: string, identity: PrWatchIdentity): string {
  try {
    const segments = new URL(bindingUrl).pathname.split('/').filter(Boolean);
    if (segments.length >= 2) return `${segments[0]}/${segments[1]}`;
  } catch {
    // An unparsable binding URL falls back to the watch identity below.
  }
  return identity.repo;
}

function displayUrl(
  bindingUrl: string,
  identity: PrWatchIdentity,
  repo: string,
): string {
  try {
    const parsed = new URL(bindingUrl);
    const host = parsed.hostname.replace(/^www\./, '');
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${host}${port}/${repo}/pull/${identity.number}`;
  } catch {
    return `https://github.com/${repo}/pull/${identity.number}`;
  }
}

export function buildDrainPrompt(
  state: PrWatchState,
  entry: PrWatchPendingEntry,
  recipient: PrWatchRecipient,
  actions: ReadonlyMap<string, string> | undefined,
): string {
  const identity = state.pr;
  const repo = displayRepo(recipient.url, identity);
  const url = displayUrl(recipient.url, identity, repo);
  const values: BoundActionValues = {
    repo,
    pr: `${identity.number}`,
    url,
    title: state.title ?? '',
    event: entry.type,
    sender: 'GitHub',
    role: recipient.role ?? '',
  };
  const template =
    actions !== undefined
      ? resolveBoundActionTemplate(actions, recipient.role, entry.type)
      : undefined;
  const dataLines = [
    `Repo: ${repo}`,
    `PR: #${identity.number}`,
    ...(state.title ? [`Title: ${state.title}`] : []),
    `URL: ${url}`,
    `Event: ${entry.type}`,
    `Summary: ${entry.summary}`,
  ];
  return buildBoundEventPrompt({
    platform: 'GitHub',
    provenance: 'Detected by the daemon PR-state watch.',
    ...(template !== undefined
      ? {
          instruction: {
            source: 'sessionPrWatch.actions',
            text: renderBoundActionTemplate(template, values),
          },
        }
      : {}),
    dataLines,
    // Inert once an operator instruction resolved; without actions it keeps a
    // reviewer from being told to "handle the event with your normal workflow"
    // and pushing to the PR branch (master §4).
    ...(recipient.role !== undefined
      ? {
          role: recipient.role,
          roleGuidance: DEFAULT_BOUND_ROLE_GUIDANCE[recipient.role],
        }
      : {}),
    body: entry.summary,
  });
}

interface WatchedFile {
  identity: PrWatchIdentity;
}

/** Enumerate watch files, recovering each identity from its validated content. */
function listWatchedFiles(
  watchDir: string,
  log: (message: string) => void,
): WatchedFile[] {
  let names: string[];
  try {
    names = readdirSync(watchDir);
  } catch {
    return [];
  }
  const out: WatchedFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const filePath = path.join(watchDir, name);
    try {
      const stats = lstatSync(filePath);
      if (!stats.isFile()) {
        log(`PR watch drain: ${filePath} is not a regular file; skipping`);
        continue;
      }
      const parsed = parsePrWatchState(
        JSON.parse(readFileSync(filePath, 'utf-8')),
      );
      if (!parsed) {
        log(`PR watch drain: invalid watch file ${filePath}; skipping`);
        continue;
      }
      out.push({ identity: parsed.pr });
    } catch (error) {
      log(
        `PR watch drain: read error for ${filePath}; skipping this tick: ${String(error)}`,
      );
    }
  }
  return out;
}

/**
 * One delivery drain tick. `coveragePartial` carries the caller's knowledge
 * that the workspace list itself is incomplete: the registry's `listAll()`
 * omits every non-active entry, so a draining or transitioning workspace's
 * bindings are unknown, not absent. Without it a complete-looking scan would
 * delete the watch file of a PR whose only binder lives there.
 */
export async function runPrWatchDrainTick(
  workspaces: readonly WorkspaceRuntime[],
  deps: PrWatchDrainDeps,
  state: PrWatchDrainState,
  coveragePartial = false,
): Promise<PrWatchDrainResult> {
  const liveness = livenessOf(state);
  liveness.activeTicks += 1;
  try {
    return await drainTick(workspaces, deps, state, coveragePartial);
  } finally {
    liveness.activeTicks -= 1;
    settleIfIdle(state);
  }
}

async function drainTick(
  workspaces: readonly WorkspaceRuntime[],
  deps: PrWatchDrainDeps,
  state: PrWatchDrainState,
  coveragePartial: boolean,
): Promise<PrWatchDrainResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const claim = claimPrWatchOwnershipSync(deps.watchDir, log);
  if (claim.kind === 'blocked') {
    return { claimed: false, delivered: 0, dropped: 0, deleted: 0 };
  }

  // Drop Gone exclusions past the rejoin horizon so the map stays bounded and
  // a recipient that comes back is eligible again (master §4).
  for (const [sessionId, at] of state.gone) {
    if (now() - at >= PR_WATCH_GONE_REJOIN_MS) state.gone.delete(sessionId);
  }

  // Aggregate every covered workspace's scan, then merge retention once. An
  // empty list is a degenerate coverage signal (a primary replacement leaves
  // it momentarily empty), never evidence that every PR is unbound.
  const scanned: SessionPrBindingSummary[] = [];
  let partial = coveragePartial || workspaces.length === 0;
  for (const runtime of workspaces) {
    try {
      const result = await deps.scanBindings(runtime);
      scanned.push(...result.bindings);
      partial = partial || result.partial;
    } catch (error) {
      partial = true;
      log(
        `PR watch drain: bindings scan failed for ${runtime.workspaceCwd}: ${String(error)}`,
      );
    }
  }
  const rows = mergeBindingRows(scanned, partial, state, log);

  let delivered = 0;
  let dropped = 0;
  let deleted = 0;
  for (const file of listWatchedFiles(deps.watchDir, log)) {
    try {
      const outcome = await drainOnePr(
        file.identity,
        rows,
        partial,
        deps,
        state,
        now,
        log,
      );
      delivered += outcome.delivered;
      dropped += outcome.dropped;
      if (outcome.deleted) deleted += 1;
    } catch (error) {
      // A draining daemon aborts the whole tick; any other failure (an
      // EACCES delete, a dependency throw) is contained per PR so one bad
      // file cannot starve every PR after it in readdir order.
      if (error instanceof DaemonDrainingError) throw error;
      log(
        `PR watch drain: ${file.identity.repo}#${file.identity.number} failed; continuing with the next PR: ${String(error)}`,
      );
    }
  }
  return { claimed: true, delivered, dropped, deleted };
}

async function drainOnePr(
  identity: PrWatchIdentity,
  rows: ReadonlyMap<string, SessionPrBindingSummary>,
  partial: boolean,
  deps: PrWatchDrainDeps,
  state: PrWatchDrainState,
  now: () => number,
  log: (message: string) => void,
): Promise<{ delivered: number; dropped: number; deleted: boolean }> {
  const filePath = prWatchFilePath(deps.watchDir, identity);
  let delivered = 0;
  let dropped = 0;
  let deleted = false;
  await deps.locks.runExclusive(filePath, async () => {
    const read = readPrWatchStateSync(deps.watchDir, identity);
    if (read.kind === 'error') {
      log(`PR watch drain: read error for ${filePath}; skipping this tick`);
      return;
    }
    if (read.kind !== 'state') return;
    let current = read.state;

    const hasBinder = bindersOf(rows, identity).length > 0;
    if (hasBinder) {
      current = { ...current, lastBoundAt: new Date(now()).toISOString() };
    } else if (!partial) {
      deletePrWatchStateSync(deps.watchDir, identity);
      log(
        `PR watch drain: deleted unbound watch file for ${identity.repo}#${identity.number}`,
      );
      deleted = true;
      return;
    } else if (
      current.lastBoundAt !== undefined &&
      now() - Date.parse(current.lastBoundAt) > PR_WATCH_UNBOUND_AGE_MS
    ) {
      deletePrWatchStateSync(deps.watchDir, identity);
      log(
        `PR watch drain: deleted stale watch file for ${identity.repo}#${identity.number}`,
      );
      deleted = true;
      return;
    }

    const pending = current.pending ?? [];
    const remaining: PrWatchPendingEntry[] = [];
    for (const entry of pending) {
      if (now() - Date.parse(entry.detectedAt) > PR_WATCH_PENDING_AGE_MS) {
        log(`PR watch drain: dropping aged pending ${entry.key}`);
        dropped += 1;
        continue;
      }
      const outcome = await drainEntry(
        current,
        entry,
        rows,
        partial,
        deps,
        state,
        now,
        log,
      );
      delivered += outcome.delivered;
      if (!outcome.done) remaining.push(outcome.entry);
    }
    current = { ...current };
    if (remaining.length > 0) current.pending = remaining;
    else delete current.pending;
    try {
      writePrWatchStateSync(deps.watchDir, identity, current);
      // The write landed: every key now in `delivered` is persisted, so its
      // in-flight mark is no longer needed (master §5 clears the mark after
      // the recording write). A failed write below keeps the marks instead.
      for (const key of current.delivered ?? []) state.inFlight.delete(key);
    } catch (error) {
      // Keep the admitted marks; a later drain retries only the write.
      log(
        `PR watch drain: recording write failed for ${identity.repo}#${identity.number}: ${String(error)}`,
      );
    }
  });
  return { delivered, dropped, deleted };
}

async function drainEntry(
  current: PrWatchState,
  entry: PrWatchPendingEntry,
  rows: ReadonlyMap<string, SessionPrBindingSummary>,
  partial: boolean,
  deps: PrWatchDrainDeps,
  state: PrWatchDrainState,
  now: () => number,
  log: (message: string) => void,
): Promise<{ delivered: number; done: boolean; entry: PrWatchPendingEntry }> {
  const identity = current.pr;
  // An empty map is not a subscription: treat it as no actions so a
  // momentarily empty configuration cannot strand live transitions.
  const actions = deps.actions?.size ? deps.actions : undefined;
  const roleAware = actions !== undefined;
  const deliveredKeys = new Set(current.delivered ?? []);
  const isGone = (sessionId: string): boolean => {
    const at = state.gone.get(sessionId);
    return at !== undefined && now() - at < PR_WATCH_GONE_REJOIN_MS;
  };
  const { recipients, matchedGroups } = resolvePrRecipients(
    rows,
    identity,
    actions,
    entry.type,
  );
  if (roleAware && matchedGroups.length === 0) {
    // No template resolves for this event type, so no group can ever be
    // served. The template map is config, not scan coverage, so this drop
    // does not wait for a complete scan; without it the entry would be
    // rewritten every tick until it ages out, with no log line.
    log(`PR watch drain: no template for ${entry.key}; dropping`);
    return { delivered: 0, done: true, entry };
  }
  const served = new Set<PrWatchRoleGroup>(entry.served ?? []);
  let delivered = 0;
  let pendingInFlight = false;

  const groups: Array<PrWatchRoleGroup | null> = roleAware
    ? matchedGroups
    : [null];
  for (const group of groups) {
    if (group !== null && served.has(group)) continue;
    const key = groupKey(entry.key, group);
    if (deliveredKeys.has(key)) {
      if (group !== null) served.add(group);
      continue;
    }
    const mark = state.inFlight.get(key);
    if (mark) {
      if (mark.admitted) {
        // Admission landed but the recording write failed: record it now and
        // keep the mark — the caller clears it only after the write lands, so
        // a repeated write failure still retries the write, never re-admits.
        recordKey(current, key);
        if (group !== null) served.add(group);
      } else {
        pendingInFlight = true;
      }
      continue;
    }

    const candidates = (
      group === null
        ? recipients
        : recipients.filter((r) => roleGroupOf(r.role) === group)
    ).filter((r) => !isGone(r.sessionId));
    let handled = false;
    // Candidates left after the self-push exclusion (Gone is already filtered
    // out of `candidates`). Self-push is permanent for this head, so an entry
    // whose only binder pushed it reaches the no-candidate drop instead of
    // being rewritten every tick for the whole age horizon. An unregistered or
    // retired workspace is transient by contrast: it stays a candidate and the
    // entry waits, so a transition is not lost while the workspace comes back.
    let eligible = candidates.length;
    for (const recipient of candidates) {
      if (entry.type === 'head_change') {
        // Judge against the head this entry was detected for: a later
        // observation may have moved the file's head on, and that newer head
        // says nothing about who pushed this one.
        const head = entry.headSha ?? current.headSha;
        if (head) {
          const ledger = await deps.readPushedHeads(recipient);
          if (ledger?.has(head)) {
            log(
              `PR watch drain: self-pushed head suppressed for ${recipient.sessionId}`,
            );
            eligible -= 1;
            continue;
          }
        }
      }
      const runtime = deps.resolveRuntime(recipient.workspaceCwd);
      if (!runtime) {
        log(
          `PR watch drain: workspace not registered for ${recipient.sessionId}`,
        );
        continue;
      }
      try {
        runtime.generationGuard?.assertOpen();
      } catch {
        log(`PR watch drain: generation retired for ${recipient.sessionId}`);
        continue;
      }
      if (!deps.isSessionLive(runtime, recipient.sessionId)) {
        // A dormant leader waits for its own restore (or its next live turn
        // with wakeDormant off). Falling through to a lower-priority binder
        // would consume the transition the leader is owed.
        if (deps.wakeDormant === false) {
          pendingInFlight = true;
          break;
        }
        if (state.restoring.has(recipient.sessionId)) {
          pendingInFlight = true;
          break;
        }
        if (state.restoring.size >= PR_WATCH_MAX_CONCURRENT_RESTORES) {
          pendingInFlight = true;
          break;
        }
        state.restoring.add(recipient.sessionId);
        state.inFlight.set(key, {
          sessionId: recipient.sessionId,
          admitted: false,
          group,
        });
        pendingInFlight = true;
        handled = true;
        void restoreAndAdmit(
          deps,
          state,
          identity,
          entry,
          key,
          group,
          recipient,
          log,
        ).finally(() => {
          state.restoring.delete(recipient.sessionId);
          settleIfIdle(state);
        });
        break;
      }
      const promptText = buildDrainPrompt(current, entry, recipient, actions);
      state.inFlight.set(key, {
        sessionId: recipient.sessionId,
        admitted: false,
        group,
      });
      try {
        await deps.admitPrompt(runtime, recipient.sessionId, promptText, key);
      } catch (error) {
        state.inFlight.delete(key);
        log(
          `PR watch drain: admission failed for ${recipient.sessionId}: ${String(error)}`,
        );
        handled = true;
        break;
      }
      // Admitted: mark admitted, then record. The caller's write persists it;
      // if that write fails the mark stays admitted for a write-only retry.
      state.inFlight.set(key, {
        sessionId: recipient.sessionId,
        admitted: true,
        group,
      });
      recordKey(current, key);
      if (group !== null) served.add(group);
      delivered += 1;
      handled = true;
      break;
    }
    if (!handled && !pendingInFlight && !partial && eligible === 0) {
      if (group !== null) {
        // Matched group with no eligible binder on a complete scan: skip it.
        served.add(group);
      } else {
        // No candidate at all on a complete scan: drop the transition.
        log(
          `PR watch drain: no candidate for ${entry.key}; dropping on complete scan`,
        );
        return { delivered, done: true, entry };
      }
    }
  }

  const servedAll = roleAware
    ? matchedGroups.length > 0 && matchedGroups.every((g) => served.has(g))
    : deliveredKeys.has(entry.key) ||
      (current.delivered ?? []).includes(entry.key);
  const done = servedAll && !pendingInFlight;
  const updatedEntry: PrWatchPendingEntry = {
    ...entry,
    ...(served.size > 0 ? { served: [...served] } : {}),
  };
  return { delivered, done, entry: updatedEntry };
}

function recordKey(current: PrWatchState, key: string): void {
  current.delivered = [...(current.delivered ?? []), key].slice(
    -PR_WATCH_DELIVERED_CAP,
  );
}

async function restoreAndAdmit(
  deps: PrWatchDrainDeps,
  state: PrWatchDrainState,
  identity: PrWatchIdentity,
  entry: PrWatchPendingEntry,
  key: string,
  group: PrWatchRoleGroup | null,
  recipient: PrWatchRecipient,
  log: (message: string) => void,
): Promise<void> {
  try {
    const outcome = await deps.wakeSession(
      recipient.sessionId,
      recipient.workspaceCwd,
    );
    if (outcome.kind !== 'restored') {
      state.inFlight.delete(key);
      if (outcome.kind === 'gone') {
        // Exclude the Gone recipient so the next drain re-resolves to the next
        // binder instead of restoring it again; it rejoins after the horizon.
        state.gone.set(recipient.sessionId, (deps.now ?? Date.now)());
        log(
          `PR watch drain: recipient gone ${recipient.sessionId}; will re-resolve`,
        );
      }
      return;
    }
    try {
      const runtime = deps.resolveRuntime(recipient.workspaceCwd);
      if (!runtime) {
        state.inFlight.delete(key);
        return;
      }
      const filePath = prWatchFilePath(deps.watchDir, identity);
      await deps.locks.runExclusive(filePath, async () => {
        const read = readPrWatchStateSync(deps.watchDir, identity);
        if (read.kind !== 'state') {
          state.inFlight.delete(key);
          return;
        }
        const current = read.state;
        if ((current.delivered ?? []).includes(key)) {
          state.inFlight.delete(key);
          return;
        }
        // A later tick may have served a sibling group and written its marks
        // after this restore was dispatched. Merge from the entry on disk, not
        // from the dispatch-time snapshot, or those marks are lost; an entry
        // that completed meanwhile must not be resurrected either.
        const liveEntry = (current.pending ?? []).find(
          (p) => p.key === entry.key,
        );
        const actions = deps.actions?.size ? deps.actions : undefined;
        const promptText = buildDrainPrompt(
          current,
          liveEntry ?? entry,
          recipient,
          actions,
        );
        try {
          await deps.admitPrompt(runtime, recipient.sessionId, promptText, key);
        } catch (error) {
          state.inFlight.delete(key);
          log(
            `PR watch drain: restored admission failed for ${recipient.sessionId}: ${String(error)}`,
          );
          return;
        }
        state.inFlight.set(key, {
          sessionId: recipient.sessionId,
          admitted: true,
          group,
        });
        recordKey(current, groupKey(entry.key, group));
        const served = new Set<PrWatchRoleGroup>(liveEntry?.served ?? []);
        if (group !== null) served.add(group);
        const { matchedGroups } = resolvePrRecipients(
          state.retained,
          identity,
          actions,
          entry.type,
        );
        const servedAll =
          liveEntry === undefined ||
          (actions === undefined
            ? true
            : matchedGroups.every((g) => served.has(g)));
        const others = (current.pending ?? []).filter(
          (p) => p.key !== entry.key,
        );
        const next: PrWatchState = { ...current };
        if (servedAll) {
          if (others.length > 0) next.pending = others;
          else delete next.pending;
        } else {
          next.pending = [
            ...others,
            {
              ...(liveEntry ?? entry),
              ...(served.size > 0 ? { served: [...served] } : {}),
            },
          ];
        }
        try {
          writePrWatchStateSync(deps.watchDir, identity, next);
          state.inFlight.delete(key);
        } catch (error) {
          log(
            `PR watch drain: restored recording write failed for ${identity.repo}#${identity.number}: ${String(error)}`,
          );
        }
      });
    } finally {
      await outcome.release();
    }
  } catch (error) {
    state.inFlight.delete(key);
    log(
      `PR watch drain: restore failed for ${recipient.sessionId}: ${String(error)}`,
    );
  }
}
