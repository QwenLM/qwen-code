/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonAutofixPrWatch,
  DaemonAutofixPrWatchList,
} from '../daemon/workspace/types';

/** What the prompt of a watch's scheduled task names (`qwen autofix-pr
 * schedule` writes `Run /autofix-pr tick <owner>/<repo>#<n> [--task <id>]…`). */
export interface AutofixPrTick {
  /** `<owner>/<repo>`. */
  repo: string;
  pr: number;
  task?: string;
}

const TICK_RE =
  /^Run \/autofix-pr tick ([\w.-]+\/[\w.-]+)#([1-9]\d{0,9})(?: --task ([0-9a-f]{12}))?(?=\s|$)/;

export function parseAutofixPrTick(prompt: string): AutofixPrTick | null {
  const match = TICK_RE.exec(prompt);
  if (!match) return null;
  const pr = Number(match[2]);
  if (!Number.isSafeInteger(pr)) return null;
  return {
    repo: match[1]!,
    pr,
    ...(match[3] ? { task: match[3] } : {}),
  };
}

/**
 * The watch a scheduled task drives, among the watches of its workspace's
 * clone. `stale` as the task's gate judges it: the watch ended, records no
 * task where the task has an id, or records another task — one a later
 * `schedule` replaced. Such a task stops at its next fire.
 */
export function watchOfTask(
  prompt: string,
  watches: readonly DaemonAutofixPrWatch[] | undefined,
): { watch: DaemonAutofixPrWatch; stale: boolean } | null {
  const tick = parseAutofixPrTick(prompt);
  if (!tick || !watches) return null;
  const watch = watches.find(
    (candidate) =>
      candidate.pr === tick.pr &&
      candidate.repo.toLowerCase() === tick.repo.toLowerCase(),
  );
  if (!watch) return null;
  const recorded = watch.watch?.task;
  return {
    watch,
    stale:
      watch.ended !== null ||
      (tick.task !== undefined && watch.watch === null) ||
      // A task with no id predates task ids: once one is recorded, it is
      // not the one recorded either.
      (recorded !== undefined && recorded !== tick.task),
  };
}

/** Where a watch is, the first that holds in this order. */
export type AutofixPrWatchPhase =
  /** The gate saw the PR merged or closed: only a cleanup is left. */
  | 'merged'
  | 'closed'
  /** A `cleanup` that kept the worktree ended it. */
  | 'ended'
  /** No task drives it: a `--once` check's state, or a watch whose
   * scheduling did not finish. */
  | 'unscheduled'
  /** A fix agent works in the background, or its round has yet to claim it. */
  | 'fixing'
  /** A background fix its session left behind: the next round redoes it. */
  | 'abandonedFix'
  /** Its gate checked the PR within two intervals. */
  | 'watching'
  /** No check that recent: its session is gone or not running its task. */
  | 'idle';

export function watchPhase(watch: DaemonAutofixPrWatch): AutofixPrWatchPhase {
  if (watch.stopped) return watch.stopped;
  if (watch.ended) return 'ended';
  if (!watch.watch) return 'unscheduled';
  if (watch.fix?.fresh) return 'fixing';
  if (watch.fix) return 'abandonedFix';
  return watch.checkedRecently ? 'watching' : 'idle';
}

/** What stops a watch in the session that owns it, as a user types it. */
export function stopCommand(watch: Pick<DaemonAutofixPrWatch, 'pr'>): string {
  return `/autofix-pr stop ${watch.pr}`;
}

/** What resumes an existing watch in the current session, as a user types it. */
export function resumeCommand(watch: Pick<DaemonAutofixPrWatch, 'pr'>): string {
  return `/autofix-pr resume ${watch.pr}`;
}

/** Allowed `--every` intervals accepted by `qwen autofix-pr schedule` (minutes). */
export const AUTOFIX_PR_WATCH_INTERVALS = [1, 2, 5, 10, 15, 30, 60] as const;

export const DEFAULT_AUTOFIX_PR_WATCH_EVERY = 2;

export function isValidAutofixPrWatchInterval(minutes: number): boolean {
  return (
    Number.isInteger(minutes) &&
    (AUTOFIX_PR_WATCH_INTERVALS as readonly number[]).includes(minutes)
  );
}

export type AutofixPrStartMode = 'watch' | 'once';

export interface AutofixPrStartOptions {
  pr: string | number;
  mode?: AutofixPrStartMode;
  /** Restart an existing in-place watch as a scheduled watch (`--in-place --watch`). */
  inPlaceWatch?: boolean;
  /** Polling interval in minutes (watch mode only; must be in `AUTOFIX_PR_WATCH_INTERVALS`). */
  every?: number;
  /** Suppress public PR comments (`--no-reply`). */
  noReply?: boolean;
  /** Optional guidance appended to the command. */
  instructions?: string;
}

/** Build the `/autofix-pr …` slash command for starting or re-starting a PR fix. */
export function buildAutofixPrStartCommand(
  options: AutofixPrStartOptions,
): string {
  const target = String(options.pr).trim();
  const parts = ['/autofix-pr', target];
  if (options.inPlaceWatch) {
    parts.push('--in-place', '--watch');
  } else {
    const mode = options.mode ?? 'watch';
    if (mode === 'once') {
      parts.push('--once');
    } else if (
      options.every !== undefined &&
      isValidAutofixPrWatchInterval(options.every)
    ) {
      parts.push('--every', String(options.every));
    }
  }
  if (options.noReply) {
    parts.push('--no-reply');
  }
  const instructions = options.instructions?.replace(/\s+/g, ' ').trim();
  if (instructions) {
    parts.push(instructions);
  }
  return parts.join(' ');
}

/**
 * Build the restart command for an existing `ended` or `unscheduled` watch,
 * preserving `--in-place --watch` for in-place watches so `prepare` does not
 * reject with an in-place mismatch.
 */
export function buildAutofixPrRestartCommand(
  watch: Pick<DaemonAutofixPrWatch, 'url' | 'pr' | 'inPlace'>,
): string {
  return buildAutofixPrStartCommand({
    pr: watch.url || watch.pr,
    ...(watch.inPlace ? { inPlaceWatch: true } : {}),
  });
}

/** Normalize an optional workspace cwd, treating empty/whitespace strings as absent. */
export function nonEmptyCwd(cwd?: string): string | undefined {
  const trimmed = cwd?.trim();
  return trimmed ? trimmed : undefined;
}

const PR_URL_PATH_RE = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?=[/.]|$)/i;
const BARE_PR_NUMBER_RE = /^#?([1-9]\d*)$/;

/**
 * Canonical `host/owner/repo#number` key for a GitHub-style pull request URL.
 * Returns null for non-http(s) URLs or paths that do not name a PR.
 */
export function normalizePrUrlKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const match = PR_URL_PATH_RE.exec(parsed.pathname);
  if (!match) return null;
  const pr = Number(match[3]);
  if (!Number.isSafeInteger(pr)) return null;
  return `${parsed.host.toLowerCase()}/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}#${pr}`;
}

export type ParsedAutofixPrInput =
  | { kind: 'url'; url: string; number: number }
  | { kind: 'number'; number: number };

/** Parse a user-typed PR URL or bare `#N` / `N` PR reference. */
export function parseAutofixPrInput(raw: string): ParsedAutofixPrInput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const bare = BARE_PR_NUMBER_RE.exec(trimmed);
  if (bare) {
    const number = Number(bare[1]);
    return Number.isSafeInteger(number) ? { kind: 'number', number } : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const match = PR_URL_PATH_RE.exec(parsed.pathname);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return null;
  return {
    kind: 'url',
    url: `${parsed.origin}/${match[1]}/${match[2]}/pull/${number}`,
    number,
  };
}

/** Canonical key of a daemon watch entry. */
export function watchPrUrlKey(
  watch: Pick<DaemonAutofixPrWatch, 'url' | 'host' | 'repo' | 'pr'>,
): string | null {
  const fromUrl = watch.url ? normalizePrUrlKey(watch.url) : null;
  if (fromUrl) return fromUrl;
  if (!watch.host || !watch.repo || !Number.isSafeInteger(watch.pr)) {
    return null;
  }
  return `${watch.host.toLowerCase()}/${watch.repo.toLowerCase()}#${watch.pr}`;
}

/** Whether a watch is currently actively running/scheduled. */
export function isWatchActivePhase(phase: AutofixPrWatchPhase): boolean {
  return phase === 'watching' || phase === 'fixing' || phase === 'abandonedFix';
}

/** Whether a PR state allows launching or resuming `/autofix-pr`. */
export function isPrOpenForAutofix(state?: string): boolean {
  return state !== 'merged' && state !== 'closed';
}

export interface IndexedAutofixPrWatch {
  watch: DaemonAutofixPrWatch;
  phase: AutofixPrWatchPhase;
  workspaceKey: string;
  workspaceCwd?: string;
  /** Pending `needsHuman` items summed across distinct clones watching this PR. */
  needsHumanCount: number;
  /** Distinct clones currently in an active phase for this PR. */
  activeCloneCount: number;
}

const PHASE_PRIORITY: Record<AutofixPrWatchPhase, number> = {
  fixing: 7,
  watching: 6,
  abandonedFix: 5,
  idle: 4,
  unscheduled: 3,
  ended: 2,
  merged: 1,
  closed: 0,
};

function watchPendingNeedsHumanCount(watch: DaemonAutofixPrWatch): number {
  return watch.ended === null && watch.stopped === null
    ? watch.needsHuman.length
    : 0;
}

/**
 * Index all watches across operable workspaces by canonical PR URL key so
 * every PR surface can look up live watch state in O(1). Linked checkouts
 * sharing the same clone `root` are deduplicated, while independent clones of
 * the same repository retain the higher-priority phase winner and accumulate
 * `needsHumanCount` and `activeCloneCount` across distinct clones.
 */
export function indexAutofixPrWatches(
  lists: ReadonlyMap<string, DaemonAutofixPrWatchList>,
  workspaceCwdByKey?: ReadonlyMap<string, string>,
): ReadonlyMap<string, IndexedAutofixPrWatch> {
  const index = new Map<string, IndexedAutofixPrWatch>();
  const seenClones = new Set<string>();
  for (const [workspaceKey, list] of lists.entries()) {
    const workspaceCwd = nonEmptyCwd(workspaceCwdByKey?.get(workspaceKey));
    const cloneRoot = list.root ?? workspaceKey;
    for (const watch of list.watches) {
      const key = watchPrUrlKey(watch);
      if (!key) continue;
      const cloneIdentity = `${cloneRoot}\n${key}`;
      const isNewClone = !seenClones.has(cloneIdentity);
      seenClones.add(cloneIdentity);
      const phase = watchPhase(watch);
      const cloneNeedsHuman = isNewClone
        ? watchPendingNeedsHumanCount(watch)
        : 0;
      const cloneActive = isNewClone && isWatchActivePhase(phase) ? 1 : 0;
      const existing = index.get(key);
      if (!existing) {
        index.set(key, {
          watch,
          phase,
          workspaceKey,
          ...(workspaceCwd ? { workspaceCwd } : {}),
          needsHumanCount: cloneNeedsHuman,
          activeCloneCount: cloneActive,
        });
      } else {
        const totalNeedsHuman = existing.needsHumanCount + cloneNeedsHuman;
        const totalActiveClones = existing.activeCloneCount + cloneActive;
        if (PHASE_PRIORITY[phase] > PHASE_PRIORITY[existing.phase]) {
          index.set(key, {
            watch,
            phase,
            workspaceKey,
            ...(workspaceCwd ? { workspaceCwd } : {}),
            needsHumanCount: totalNeedsHuman,
            activeCloneCount: totalActiveClones,
          });
        } else {
          index.set(key, {
            ...existing,
            needsHumanCount: totalNeedsHuman,
            activeCloneCount: totalActiveClones,
          });
        }
      }
    }
  }
  return index;
}

export function findWatchForPr(
  index: ReadonlyMap<string, IndexedAutofixPrWatch>,
  prUrl: string,
): IndexedAutofixPrWatch | undefined {
  const key = normalizePrUrlKey(prUrl);
  return key ? index.get(key) : undefined;
}

export type AutofixPrActiveStatus =
  | 'needsHuman'
  | 'fixing'
  | 'retrying'
  | 'watching';

export interface AutofixPrActiveStatusInfo {
  status: AutofixPrActiveStatus;
  needsHumanCount: number;
}

const ACTIVE_STATUS_PRIORITY: Record<AutofixPrActiveStatus, number> = {
  needsHuman: 4,
  fixing: 3,
  retrying: 2,
  watching: 1,
};

/**
 * Highest-signal status badge for a watch that is either waiting for human
 * input (while not ended/stopped) or actively running.
 */
export function getWatchActiveStatus(
  watch: DaemonAutofixPrWatch,
  phase: AutofixPrWatchPhase = watchPhase(watch),
  needsHumanCountOverride?: number,
): AutofixPrActiveStatusInfo | null {
  const pendingNeedsHuman =
    needsHumanCountOverride ?? watchPendingNeedsHumanCount(watch);
  if (pendingNeedsHuman > 0) {
    return { status: 'needsHuman', needsHumanCount: pendingNeedsHuman };
  }
  if (phase === 'fixing') return { status: 'fixing', needsHumanCount: 0 };
  if (phase === 'abandonedFix') {
    return { status: 'retrying', needsHumanCount: 0 };
  }
  if (phase === 'watching') return { status: 'watching', needsHumanCount: 0 };
  return null;
}

/**
 * Aggregate the highest-priority watch indicator across a session's open PRs.
 */
export function summarizeSessionPrWatchStatus(
  index: ReadonlyMap<string, IndexedAutofixPrWatch>,
  prs: ReadonlyArray<{ url: string; state?: string }>,
): AutofixPrActiveStatusInfo | null {
  let best: AutofixPrActiveStatusInfo | null = null;
  let totalNeedsHuman = 0;
  const seenPrKeys = new Set<string>();
  for (const pr of prs) {
    if (!isPrOpenForAutofix(pr.state)) continue;
    const prKey = normalizePrUrlKey(pr.url);
    if (!prKey || seenPrKeys.has(prKey)) continue;
    seenPrKeys.add(prKey);
    const entry = index.get(prKey);
    if (!entry) continue;
    const info = getWatchActiveStatus(
      entry.watch,
      entry.phase,
      entry.needsHumanCount,
    );
    if (!info) continue;
    if (info.status === 'needsHuman') {
      totalNeedsHuman += info.needsHumanCount;
    }
    if (
      !best ||
      ACTIVE_STATUS_PRIORITY[info.status] > ACTIVE_STATUS_PRIORITY[best.status]
    ) {
      best = info;
    }
  }
  if (best?.status === 'needsHuman') {
    return { status: 'needsHuman', needsHumanCount: totalNeedsHuman };
  }
  return best;
}

export interface AutofixPrWatchesSummary {
  /** Distinct clone watches in an active phase (`watching`, `fixing`, or `abandonedFix`). */
  activeCount: number;
  /** Total pending `needsHuman` items across non-ended, non-stopped watches. */
  needsHumanCount: number;
}

/** Aggregate active watch and `needsHuman` counts for sidebar navigation badges. */
export function summarizeAutofixPrWatches(
  index: ReadonlyMap<string, IndexedAutofixPrWatch>,
): AutofixPrWatchesSummary {
  let activeCount = 0;
  let needsHumanCount = 0;
  for (const entry of index.values()) {
    activeCount += entry.activeCloneCount;
    needsHumanCount += entry.needsHumanCount;
  }
  return { activeCount, needsHumanCount };
}
