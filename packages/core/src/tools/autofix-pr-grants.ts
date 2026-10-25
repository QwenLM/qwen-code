/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What `autofix_pr` keeps per session, in memory only: the watches whose
 * `prepare` this session ran through the tool, the worktrees whose fix
 * agents `unattended` lets run their commands without asking, the tasks the
 * session's `schedule` printed, and the fix agents it runs in the
 * background. A file would sit in reach of the code those agents run, and
 * the state file does: none of this is read back from it. All of it ends
 * with the session — `/clear`, `/resume` and `/new` drop it
 * (`Config.startNewSession`) — and with the process.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  futimesSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

/** A watch as the `prepare` this session ran reported it. */
export interface ConfirmedWatch {
  pr: number;
  /** `<owner>/<repo>`, as `prepare` was given it. */
  repo: string;
  /** The host `prepare` resolved, or null when it did not say. */
  host: string | null;
  /** The session's directory it was prepared from: one clone's watch. */
  targetDir: string;
  /** When `prepare` made the watch: a later one of the PR is another. */
  preparedAt: string | null;
  /** The worktree's canonical path. */
  worktree: string;
  /** What GitHub said when `prepare` asked, just now. */
  authorCanPush: boolean;
}

export interface UnattendedFixGrant {
  pr: number;
  /** The worktree's canonical path. */
  worktree: string;
  /** Whether the watch still allows it; asked at every launch. */
  check: (signal: AbortSignal) => Promise<boolean>;
  /** Opens a background fix's attempt (`fix-start`), printing the watch's
   * task; throws with the helper's refusal. */
  open: (attempt: string, signal: AbortSignal) => Promise<{ task: string }>;
  /** Ends an attempt no round will claim (`fix-end`), whatever it answers. */
  close: (attempt: string) => Promise<void>;
}

/** A watch's task, as this session's own `schedule` printed it. */
export interface WatchTask {
  task: string;
  reply: boolean;
  instructions: string;
}

const confirmed = new Map<string, Map<number, ConfirmedWatch>>();
const grants = new Map<string, Map<string, UnattendedFixGrant>>();
const tasks = new Map<string, Map<number, WatchTask>>();

/** A worktree as grants are keyed: its real path, in the file system's case. */
export function canonicalWorktreePath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export function recordConfirmedWatch(
  sessionId: string,
  watch: ConfirmedWatch,
): void {
  let bySession = confirmed.get(sessionId);
  if (!bySession) {
    bySession = new Map();
    confirmed.set(sessionId, bySession);
  }
  bySession.set(watch.pr, watch);
}

export function confirmedWatch(
  sessionId: string,
  pr: number,
): ConfirmedWatch | undefined {
  return confirmed.get(sessionId)?.get(pr);
}

/** Forgets the PR's confirmed watch and ends its grant. */
export function forgetConfirmedWatch(sessionId: string, pr: number): void {
  const bySession = confirmed.get(sessionId);
  bySession?.delete(pr);
  if (bySession?.size === 0) confirmed.delete(sessionId);
  const byTask = tasks.get(sessionId);
  byTask?.delete(pr);
  if (byTask?.size === 0) tasks.delete(sessionId);
  revokeUnattendedFixes(sessionId, pr);
}

export function recordWatchTask(
  sessionId: string,
  pr: number,
  task: WatchTask,
): void {
  let bySession = tasks.get(sessionId);
  if (!bySession) {
    bySession = new Map();
    tasks.set(sessionId, bySession);
  }
  bySession.set(pr, task);
}

export function watchTask(
  sessionId: string,
  pr: number,
): WatchTask | undefined {
  return tasks.get(sessionId)?.get(pr);
}

export function grantUnattendedFixes(
  sessionId: string,
  grant: UnattendedFixGrant,
): void {
  let bySession = grants.get(sessionId);
  if (!bySession) {
    bySession = new Map();
    grants.set(sessionId, bySession);
  }
  // One grant per PR: a recreated worktree replaces the old one.
  for (const [worktree, existing] of bySession) {
    if (existing.pr === grant.pr) bySession.delete(worktree);
  }
  bySession.set(grant.worktree, grant);
}

/**
 * Ends the PR's grant. A fix agent it runs in the background is stopped —
 * its YOLO mode was fixed when it launched — and its attempt dropped: its
 * marker goes stale, and the next round redoes the fix in the foreground,
 * as the user now has it.
 */
export function revokeUnattendedFixes(sessionId: string, pr: number): void {
  backgroundFixOf(sessionId, pr)?.drop();
  const bySession = grants.get(sessionId);
  if (!bySession) return;
  for (const [worktree, grant] of bySession) {
    if (grant.pr === pr) bySession.delete(worktree);
  }
  if (bySession.size === 0) grants.delete(sessionId);
}

/**
 * Whether an agent this session launches in `workingDir` runs its commands
 * without asking: a grant for that worktree whose watch, checked now, still
 * allows it. A failed check ends the grant.
 */
export async function hasUnattendedFixGrant(
  sessionId: string,
  workingDir: string,
  signal: AbortSignal,
): Promise<boolean> {
  const grant = grants.get(sessionId)?.get(canonicalWorktreePath(workingDir));
  if (!grant) return false;
  let allowed = false;
  try {
    allowed = await grant.check(signal);
  } catch {
    allowed = false;
  }
  if (!allowed && !signal.aborted) revokeUnattendedFixes(sessionId, grant.pr);
  return allowed;
}

/** Whether the session granted the worktree's fixes, unchecked. */
export function unattendedFixGranted(
  sessionId: string,
  worktree: string,
): boolean {
  return grants.get(sessionId)?.has(canonicalWorktreePath(worktree)) === true;
}

// The Configs of agents a grant runs in YOLO mode: an agent one of them
// starts takes the session's own mode, not theirs.
const grantedConfigs = new WeakSet<object>();

export function markUnattendedFixConfig(config: object): void {
  grantedConfigs.add(config);
}

/** Also a Config derived from one of them, as a rebuilt registry binds to. */
export function isUnattendedFixConfig(config: object): boolean {
  for (let c: object | null = config; c; c = Object.getPrototypeOf(c)) {
    if (grantedConfigs.has(c)) return true;
  }
  return false;
}

/** Drops everything a session confirmed and granted, and its fixes. */
export function forgetAutofixPrSession(sessionId: string): void {
  for (const fix of [...fixes.values()]) {
    if (fix.sessionId === sessionId) fix.drop();
  }
  confirmed.delete(sessionId);
  grants.delete(sessionId);
  tasks.delete(sessionId);
}

/** Test-only: forgets every session. */
export function resetUnattendedFixGrantsForTests(): void {
  for (const fix of [...fixes.values()]) fix.drop();
  confirmed.clear();
  grants.clear();
  tasks.clear();
}

// ── Background fixes (Section 6.14 of the design) ─────────────────────

/** How often the session refreshes an attempt's marker. */
export const FIX_HEARTBEAT_MS = 30_000;
/** A refresh later than this past its time: the process was suspended. */
const FIX_HEARTBEAT_LATE_MS = 60_000;
/** The attempt time limit: the agent is stopped then. */
export const FIX_TIME_LIMIT_MS = 30 * 60_000;
/** How long an attempt waits for its round's claim, from when it opened:
 * a notification waits for the session to be idle. */
export const FIX_CLAIM_DEADLINE_MS = 40 * 60_000;
/** The largest marker the session reads: `fix-start` writes a few lines. */
const FIX_MARKER_MAX_BYTES = 4096;

/** How the agent of a background fix ended, as its registry entry says. */
export interface BackgroundFixEnd {
  status: string;
  /** Its final report, or the error it ended with. */
  report: string;
}

/**
 * A fix agent this session runs in the background, and its attempt. The
 * launch opens it; the round that goes on from the agent's completion
 * notification claims it; nothing else ends it but the session, which drops
 * it when no claim comes, when the marker is no longer the attempt's, and
 * when the session ends.
 */
export class BackgroundFix {
  readonly attempt = randomBytes(6).toString('hex');
  agentId: string | null = null;
  ended: BackgroundFixEnd | null = null;
  /** Claimed by its round, or dropped: nothing more happens to it. */
  done = false;
  /** Settles once the agent's body did, its tools with it — later than
   * `ended` when a stopped agent's grace ran out first. */
  readonly settled: Promise<void>;
  private settle!: () => void;
  private cancelAgent: (() => void) | null = null;
  /** A stop asked for before the agent launched: done as it launches. */
  private stopRequested = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private lastBeat = Date.now();

  constructor(
    readonly sessionId: string,
    readonly pr: number,
    /** `<owner>/<repo>`, as `prepare` was given it. */
    readonly repo: string,
    readonly worktree: string,
    readonly task: WatchTask,
    private readonly grant: UnattendedFixGrant,
  ) {
    this.settled = new Promise((resolve) => (this.settle = resolve));
  }

  /** The marker `fix-start` writes beside the state file. */
  get marker(): string {
    return path.join(
      path.dirname(this.worktree),
      `autofix-pr-${this.pr}-fix.json`,
    );
  }

  /** Refreshes the marker while it names this attempt; stops otherwise. */
  beat(now = Date.now()): void {
    if (this.done) return;
    const late = now - this.lastBeat > FIX_HEARTBEAT_MS + FIX_HEARTBEAT_LATE_MS;
    this.lastBeat = now;
    // Suspended past the marker's freshness, the worktree may be another
    // session's now: its agent must not go on in it.
    if (late) return this.drop();
    let fd: number | undefined;
    try {
      // Never through a link, and never blocking on what is no file: the
      // agent can put anything at this path, and the session's own thread
      // reads it.
      // Read and write: Windows sets a file's times only through a handle
      // opened for writing.
      fd = openSync(
        this.marker,
        constants.O_RDWR |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > FIX_MARKER_MAX_BYTES) {
        return this.drop();
      }
      const marker = JSON.parse(readFileSync(fd, 'utf8')) as {
        attempt?: unknown;
      } | null;
      if (marker?.attempt !== this.attempt) return this.drop();
      futimesSync(fd, now / 1000, now / 1000);
    } catch {
      this.drop();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** The attempt opened: its marker is refreshed, and the attempt time
   * limit runs, from now. */
  startHeartbeat(): void {
    // From now: the helper that opened the attempt may have waited its turn.
    this.lastBeat = Date.now();
    this.restartTimer(FIX_TIME_LIMIT_MS, () => this.stop());
    this.deadline = setTimeout(() => this.drop(), FIX_CLAIM_DEADLINE_MS);
    this.deadline.unref?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.beat(), FIX_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /** The agent launched. A stop or a drop asked for while it launched
   * stops it now. */
  attach(agentId: string, cancel: () => void): void {
    this.agentId = agentId;
    this.cancelAgent = cancel;
    if (this.done || this.stopRequested) cancel();
  }

  /** Stops the agent; its attempt stays the round's to claim. */
  stop(): void {
    if (this.ended) return;
    if (this.cancelAgent) this.cancelAgent();
    else this.stopRequested = true;
  }

  /** The agent ended: its round goes on, until the claim deadline. Once. */
  end(end: BackgroundFixEnd): void {
    if (this.ended) return;
    this.ended = end;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The agent's body settled. */
  bodySettled(): void {
    this.settle();
  }

  /** Waits, at most `ms`, for the agent's body to settle. */
  async waitSettled(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * What the agent's completion notification tells the model, while the
   * round can still claim the attempt: go on with it, through the skill.
   */
  followUp(): string | undefined {
    if (this.done) return undefined;
    const { task, reply, instructions } = this.task;
    const args =
      `after-fix ${this.repo}#${this.pr} --task ${task} --attempt ${this.attempt}` +
      (reply ? '' : ' --no-reply') +
      (instructions ? ` -- ${instructions}` : '');
    // The arguments last, on a line of their own: the instructions are the
    // user's, as the scheduled task's prompt carries them.
    return (
      `Written by Qwen Code, not by the agent: this agent was the background ` +
      `fix of /autofix-pr for ${this.repo}#${this.pr}. Go on with its round ` +
      `now: invoke the autofix-pr skill with these arguments:\n${args}`
    );
  }

  /** The round claims the attempt: nothing refreshes or drops it now. */
  claim(): void {
    this.finish();
  }

  /**
   * Nothing more happens to the attempt: the agent is stopped, and its
   * marker, no longer refreshed, is left to the gate and the next round.
   */
  drop(): void {
    if (this.done) return;
    this.stop();
    this.finish();
  }

  /** A launch that failed after the attempt opened, or while it opened:
   * no round claims it, and its marker goes now. */
  async abandon(): Promise<void> {
    this.stop();
    this.finish();
    await this.grant.close(this.attempt).catch(() => {});
  }

  private finish(): void {
    this.done = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.timer) clearTimeout(this.timer);
    if (this.deadline) clearTimeout(this.deadline);
    this.heartbeat = this.timer = this.deadline = null;
    if (fixes.get(this.worktree) === this) fixes.delete(this.worktree);
  }

  private restartTimer(ms: number, run: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(run, ms);
    this.timer.unref?.();
  }
}

// One per worktree, whichever session: a worktree has one attempt at a time.
const fixes = new Map<string, BackgroundFix>();

/** The attempt whose agent works, or whose round has yet to claim it, at a
 * worktree — of any session of this process. */
export function backgroundFixAt(worktree: string): BackgroundFix | undefined {
  return fixes.get(canonicalWorktreePath(worktree));
}

export function backgroundFixOf(
  sessionId: string,
  pr: number,
): BackgroundFix | undefined {
  for (const fix of fixes.values()) {
    if (fix.sessionId === sessionId && fix.pr === pr) return fix;
  }
  return undefined;
}

/**
 * Opens the attempt of a fix agent the session is about to launch in the
 * background at `workingDir`, which holds a grant checked just now. Throws
 * with the reason when it cannot: another attempt there, a watch whose task
 * this session did not schedule, or the helper's refusal.
 */
export async function openBackgroundFix(
  sessionId: string,
  workingDir: string,
  signal: AbortSignal,
): Promise<BackgroundFix> {
  const worktree = canonicalWorktreePath(workingDir);
  const grant = grants.get(sessionId)?.get(worktree);
  const watch = grant ? confirmedWatch(sessionId, grant.pr) : undefined;
  if (!grant || !watch) {
    throw new Error(`no fix of ${worktree} runs without asking`);
  }
  if (fixes.has(worktree)) {
    throw new Error(`a background fix agent is already working in ${worktree}`);
  }
  const task = watchTask(sessionId, grant.pr);
  if (!task) {
    throw new Error(
      `PR #${grant.pr}'s watch has no task this session scheduled`,
    );
  }
  const fix = new BackgroundFix(
    sessionId,
    grant.pr,
    watch.repo,
    worktree,
    task,
    grant,
  );
  // Held from now: a second launch while the helper runs is refused.
  fixes.set(worktree, fix);
  let opened: { task: string };
  try {
    opened = await grant.open(fix.attempt, signal);
  } catch (err) {
    // The helper may have written the marker before it failed.
    await fix.abandon();
    throw err;
  }
  // The task the state file names is the one this session scheduled, or
  // the watch is no longer the one its rounds run.
  if (opened.task !== task.task || fix.done) {
    await fix.abandon();
    throw new Error(
      `PR #${grant.pr}'s watch is no longer driven by the task this session scheduled`,
    );
  }
  fix.startHeartbeat();
  return fix;
}
