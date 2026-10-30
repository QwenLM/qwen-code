/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// E2: observe the reviews a PR accumulated, whoever wrote them.
//
// E1 (`review verify-event`) needs the reviewer to hand off explicitly. This
// module needs nothing from them: a review posted on the platform by another
// agent, the CI bot, or a person is visible here, and a clean one produces the
// same durable event the rest of the chain already consumes.
//
// Deliberately NOT an extension of the `autofix-pr snapshot --gate` probe.
// That probe keeps ONE cursor per PR and its gate wrapper refuses coexistence,
// because a second consumer eats the transitions the first one needs. A daemon
// poller sharing it would starve the autofix and /verify-pr --watch sessions
// that own it. This observer therefore keeps its own state, in the same
// host-trusted directory as the events, and asks for the three facts it needs
// instead of the probe's thirty.
//
// The judgement reads the CURRENT approval state, never a review body: a new
// head dismisses an earlier approval while that review's body still says
// "Approving", so `reviewDecision` — which GitHub recomputes — is the authority.

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import {
  emitReviewCleanEvent,
  readSpawnedKeys,
  reviewEventDedupeKey,
  reviewEventsDir,
  type ReviewEventTarget,
} from './review-events.js';

export interface ReviewVerifyWatch {
  platform: string;
  host: string;
  ownerRepo: string;
  number: number;
  /** The session that owns this watch. The automation runs on its behalf and
   *  every verification it starts is that session's sub-session; when the
   *  session is deleted the watch is pruned and the automation stops. */
  sessionId: string;
  addedAt: string;
}

/** A watch spans heads; the head belongs to the observation, not the watch.
 *  The owner is part of the identity: two sessions watching one PR are two
 *  watches, each dying with its own session, not a transfer of ownership. */
export function watchKey(watch: {
  platform: string;
  host: string;
  ownerRepo: string;
  number: number;
  sessionId: string;
}): string {
  return `${watch.platform}:${watch.host}:${watch.ownerRepo}:${watch.number}:${watch.sessionId}`;
}

function watchesPath(root: string): string {
  return join(reviewEventsDir(root), 'watches.json');
}

function observedPath(root: string): string {
  return join(reviewEventsDir(root), 'observed.json');
}

function writeState(root: string, name: string, value: unknown): void {
  const dir = reviewEventsDir(root);
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    noFollow: true,
  });
}

export function readWatches(root: string): ReviewVerifyWatch[] {
  let raw: string;
  try {
    raw = readFileSync(watchesPath(root), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as { v?: unknown; watches?: unknown };
  if (parsed?.v !== 1 || !Array.isArray(parsed.watches)) {
    throw new Error('watches.json is not a v1 watch list');
  }
  return parsed.watches.filter(
    (w): w is ReviewVerifyWatch =>
      typeof w?.platform === 'string' &&
      typeof w?.host === 'string' &&
      typeof w?.ownerRepo === 'string' &&
      Number.isInteger(w?.number) &&
      typeof w?.sessionId === 'string' &&
      w.sessionId !== '' &&
      typeof w?.addedAt === 'string',
  );
}

export function addWatch(root: string, watch: ReviewVerifyWatch): void {
  const key = watchKey(watch);
  const watches = readWatches(root).filter((w) => watchKey(w) !== key);
  watches.push(watch);
  writeState(root, 'watches.json', { v: 1, watches });
}

export function removeWatch(root: string, key: string): boolean {
  const watches = readWatches(root);
  const kept = watches.filter((w) => watchKey(w) !== key);
  if (kept.length === watches.length) return false;
  writeState(root, 'watches.json', { v: 1, watches: kept });
  return true;
}

/** The head this observer last emitted for each watch, so one clean head is
 *  handed off once even though the poll re-reads it every interval. */
export function readObserved(root: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(observedPath(root), 'utf8')) as {
      v?: unknown;
      heads?: unknown;
    };
    if (
      parsed?.v !== 1 ||
      typeof parsed.heads !== 'object' ||
      parsed.heads === null
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.heads as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    // Absent or corrupt: re-observe. The event dedupe ledger downstream is the
    // authority on what was already verified, so a lost cursor costs a repeat
    // read, never a repeat spawn.
    return {};
  }
}

function recordObserved(root: string, key: string, head: string): void {
  const heads = { ...readObserved(root), [key]: head };
  writeState(root, 'observed.json', { v: 1, heads });
}

/** Only the facts the judgement needs. `reviewThreads` carries the resolution
 *  and outdated flags; `reviews` is read for attribution only. */
export const APPROVAL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      isDraft
      headRefOid
      reviewDecision
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes { isResolved isOutdated }
      }
      reviews(last: 20) {
        nodes { state author { login } commit { oid } }
      }
    }
  }
}`;

export interface ApprovalFacts {
  state?: unknown;
  isDraft?: unknown;
  headRefOid?: unknown;
  reviewDecision?: unknown;
  reviewThreads?: {
    pageInfo?: { hasNextPage?: unknown };
    nodes?: Array<{ isResolved?: unknown; isOutdated?: unknown }>;
  };
  reviews?: {
    nodes?: Array<{
      state?: unknown;
      author?: { login?: unknown } | null;
      commit?: { oid?: unknown } | null;
    }>;
  };
}

export type ApprovalJudgement =
  | { clean: true; headSha: string; approvers: string[] }
  | { clean: false; reason: string };

/**
 * The decided criterion: `reviewDecision === 'APPROVED'` and no unresolved,
 * non-outdated thread.
 *
 * Every unresolved non-outdated thread counts as a blocker. Classifying which
 * of them are "only questions" would mean judging severity from prose — a
 * second, weaker judgement than the one the review pipeline already makes, and
 * the wrong direction to fail in for an action that publishes a comment.
 *
 * Fail closed on a cut thread connection: a page we could not read may hold the
 * blocker, so "no blockers seen" is not "no blockers".
 */
export function judgeCleanApproval(
  pr: ApprovalFacts | null,
): ApprovalJudgement {
  if (!pr || typeof pr !== 'object')
    return { clean: false, reason: 'unreadable' };
  if (pr.state !== 'OPEN') return { clean: false, reason: 'not-open' };
  if (pr.isDraft === true) return { clean: false, reason: 'draft' };
  const headSha = typeof pr.headRefOid === 'string' ? pr.headRefOid : '';
  if (!/^[0-9a-f]{7,64}$/.test(headSha)) {
    return { clean: false, reason: 'no-head' };
  }
  if (pr.reviewDecision !== 'APPROVED') {
    return { clean: false, reason: 'not-approved' };
  }
  const threads = pr.reviewThreads;
  if (threads?.pageInfo?.hasNextPage === true) {
    return { clean: false, reason: 'threads-truncated' };
  }
  const nodes = threads?.nodes;
  if (!Array.isArray(nodes))
    return { clean: false, reason: 'threads-unreadable' };
  const open = nodes.some(
    (t) => t?.isResolved === false && t?.isOutdated === false,
  );
  if (open) return { clean: false, reason: 'open-blocker' };
  // Attribution: the approvals that still stand at THIS head. An approval of an
  // earlier commit is not one of them, which is the same trap reviewDecision
  // exists to avoid.
  const approvers = [
    ...new Set(
      (pr.reviews?.nodes ?? [])
        .filter(
          (r) =>
            r?.state === 'APPROVED' &&
            typeof r.commit?.oid === 'string' &&
            r.commit.oid === headSha &&
            typeof r.author?.login === 'string',
        )
        .map((r) => r.author?.login as string),
    ),
  ];
  return { clean: true, headSha, approvers };
}

export type FetchApproval = (
  watch: ReviewVerifyWatch,
) => Promise<ApprovalFacts | null>;

/** One call's ceiling. A hung read must not hold the observation guard past
 *  the next interval; a timeout is just a failure this pass reports and the
 *  next pass retries. */
const FETCH_TIMEOUT_MS = 30_000;

const execFileAsync = promisify(execFile);

/**
 * The real reader: one GraphQL call per watch.
 *
 * Async on purpose. The review subcommands' shared `gh()` helper is
 * `execFileSync` with a synchronous retry loop — correct for a batch CLI, but
 * this runs inside the daemon, where blocking the event loop would stall every
 * session it serves. So this calls `gh` through `execFile` and lets the poll
 * interval be the retry.
 *
 * The host rides in the child's env rather than through `setGhHost`, which
 * mutates module-global state the daemon shares.
 */
export const fetchApprovalViaGh: FetchApproval = async (watch) => {
  const [owner, name] = watch.ownerRepo.split('/');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GH_HOST: watch.host,
    CLICOLOR_FORCE: '0',
  };
  delete env['GH_FORCE_TTY'];
  const { stdout } = await execFileAsync(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      `query=${APPROVAL_QUERY}`,
      // -f, not -F: -F would turn an owner or repository named `true` or `123`
      // into a boolean or a number.
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${watch.number}`,
    ],
    {
      env,
      timeout: FETCH_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const parsed = JSON.parse(stdout) as {
    data?: { repository?: { pullRequest?: ApprovalFacts | null } | null };
  };
  return parsed.data?.repository?.pullRequest ?? null;
};

export interface ObservationOutcome {
  key: string;
  action: 'emitted' | 'skipped' | 'declined' | 'failed' | 'pruned';
  reason: string;
  headSha?: string;
}

/** Three states, never two: a watch whose owner cannot be read is neither
 *  observed nor pruned. Collapsing "unknown" into "gone" would delete live
 *  state on a transient read error; collapsing it into "alive" would keep
 *  observing for a session that no longer exists. */
export type SessionLiveness = (sessionId: string) => Promise<boolean | null>;

/** The default probe: the session's transcript location, which is decided by
 *  file PRESENCE (an empty or damaged transcript still occupies its state) and
 *  throws on a real read error — so the three states stay distinct.
 *
 *  Existence, not residency: an idle-reaped session still owns its watches, and
 *  only deleting the session ends them. `readCreationMetadata` is deliberately
 *  NOT used here — it coalesces a missing session to `{}`, which cannot tell
 *  "gone" from "exists" and would prune live watches. */
export function sessionLivenessFor(root: string): SessionLiveness {
  const sessions = new SessionService(root);
  return async (sessionId) => {
    try {
      const location =
        await sessions.getSessionTranscriptLocationForLifecycle(sessionId);
      return location !== undefined;
    } catch {
      return null;
    }
  };
}

/**
 * One observation pass. Emits the same clean-review event the other producers
 * write, so every downstream gate and the per-head dedupe apply unchanged.
 *
 * `sessionId` scopes the pass to one owner's watches — the daemon runs one
 * automation per owning session, so each pass must not act on another
 * session's watches. Omitted (the CLI's `--once`), every watch is considered.
 *
 * A watch is skipped when its head was already handed off (this observer's
 * cursor) or already verified (the consumer's ledger) — the second check is what
 * keeps a head verified through E1 from being re-emitted here every interval.
 * A watch whose owning session was deleted is pruned: the automation and its
 * watches live and die with that session.
 */
export async function observeWatches(
  root: string,
  opts: {
    fetch?: FetchApproval;
    now?: () => Date;
    sessionId?: string;
    sessionExists?: SessionLiveness;
  } = {},
): Promise<ObservationOutcome[]> {
  const fetchPr = opts.fetch ?? fetchApprovalViaGh;
  const liveness = opts.sessionExists ?? sessionLivenessFor(root);
  const all = readWatches(root);
  const watches = opts.sessionId
    ? all.filter((w) => w.sessionId === opts.sessionId)
    : all;
  if (watches.length === 0) return [];
  const observed = readObserved(root);
  let spawned: Set<string>;
  try {
    spawned = readSpawnedKeys(root);
  } catch {
    // The ledger is unreadable: emitting is still safe (the consumer fails
    // closed on the same ledger), but say so rather than pretend we checked.
    spawned = new Set();
  }
  const outcomes: ObservationOutcome[] = [];
  for (const watch of watches) {
    const key = watchKey(watch);
    const alive = await liveness(watch.sessionId);
    if (alive === false) {
      removeWatch(root, key);
      outcomes.push({ key, action: 'pruned', reason: 'session-gone' });
      continue;
    }
    if (alive === null) {
      outcomes.push({ key, action: 'skipped', reason: 'session-unknown' });
      continue;
    }
    if (watch.platform !== 'github') {
      outcomes.push({
        key,
        action: 'declined',
        reason: 'unsupported-platform',
      });
      continue;
    }
    let facts: ApprovalFacts | null;
    try {
      facts = await fetchPr(watch);
    } catch (error) {
      outcomes.push({
        key,
        action: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const judgement = judgeCleanApproval(facts);
    if (!judgement.clean) {
      outcomes.push({ key, action: 'skipped', reason: judgement.reason });
      continue;
    }
    const target: ReviewEventTarget = {
      platform: watch.platform,
      host: watch.host,
      ownerRepo: watch.ownerRepo,
      number: watch.number,
      headSha: judgement.headSha,
    };
    if (observed[key] === judgement.headSha) {
      outcomes.push({
        key,
        action: 'skipped',
        reason: 'already-handed-off',
        headSha: judgement.headSha,
      });
      continue;
    }
    if (spawned.has(reviewEventDedupeKey(target))) {
      // Verified through another producer; adopt the head so the poll stops
      // re-reading it as a candidate.
      recordObserved(root, key, judgement.headSha);
      outcomes.push({
        key,
        action: 'skipped',
        reason: 'already-verified',
        headSha: judgement.headSha,
      });
      continue;
    }
    try {
      emitReviewCleanEvent({
        workspaceRoot: root,
        target,
        round: 1,
        verdict: { event: 'APPROVE', critical: 0, suggestion: 0 },
        // The watch's owner, not the approver: the verification round becomes
        // that session's sub-session. Who approved is attribution below.
        sessionId: watch.sessionId,
        reviewedBy: judgement.approvers.length
          ? `github:${judgement.approvers.join(',')}`
          : 'github:reviewDecision',
        now: opts.now,
      });
      recordObserved(root, key, judgement.headSha);
      outcomes.push({
        key,
        action: 'emitted',
        reason: 'approved',
        headSha: judgement.headSha,
      });
    } catch (error) {
      outcomes.push({
        key,
        action: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}
