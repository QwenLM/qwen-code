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
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
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
    // No notification: it would reach the session's next conversation.
    if (fix.sessionId === sessionId) fix.drop({ notify: false });
  }
  confirmed.delete(sessionId);
  grants.delete(sessionId);
  tasks.delete(sessionId);
}

/** Test-only: forgets every session. */
export function resetUnattendedFixGrantsForTests(): void {
  for (const fix of [...fixes.values()]) fix.drop();
  settling.clear();
  confirmed.clear();
  grants.clear();
  tasks.clear();
}

// ── Background fixes (Section 6.14 of the design) ─────────────────────

/** How often the session refreshes an attempt's marker. */
export const FIX_HEARTBEAT_MS = 30_000;
/** A refresh later than this past its time: the process was suspended. */
export const FIX_HEARTBEAT_LATE_MS = 60_000;
/** The attempt time limit: the agent is stopped then. */
export const FIX_TIME_LIMIT_MS = 30 * 60_000;
/** How long an attempt waits for its round's claim, from when it opened:
 * a notification waits for the session to be idle. */
export const FIX_CLAIM_DEADLINE_MS = 40 * 60_000;
/** How long, after an attempt ended, whoever acts on its worktree next
 * waits for its stopped agent to settle. */
export const FIX_SETTLE_WAIT_MS = 15_000;
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
  private cancelAgent: ((notify: boolean) => void) | null = null;
  private descends: ((callerAgentId: string) => boolean) | null = null;
  /** A stop asked for before the agent launched: done as it launches. */
  private stopRequested = false;
  /** Whether its stop tells the model: once any stop said not to (a reset,
   * a stop the user asked for), none does. */
  private stopNotifies = true;
  private isSettled = false;
  /** Until when an ended attempt's agent is waited for. */
  settleBy = 0;
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

  /**
   * Whether the last refresh is too long ago: the process was suspended (a
   * laptop asleep stops the timer, not the clock), and the marker may have
   * gone stale meanwhile, the worktree another session's.
   */
  isLate(now = Date.now()): boolean {
    // Not before it refreshes at all: the helper opening it may wait its turn.
    if (!this.heartbeat) return false;
    return now - this.lastBeat > FIX_HEARTBEAT_MS + FIX_HEARTBEAT_LATE_MS;
  }

  /** Refreshes the marker while it names this attempt; stops otherwise. */
  beat(now = Date.now()): void {
    if (this.done) return;
    const late = this.isLate(now);
    this.lastBeat = now;
    // Its agent must not go on in a worktree that may be another's.
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
        startedAt?: unknown;
      } | null;
      if (marker?.attempt !== this.attempt) return this.drop();
      // A clock set back past it: the helpers would take the marker as no
      // attempt's while the agent still works.
      if (
        typeof marker.startedAt !== 'string' ||
        !(Date.parse(marker.startedAt) <= now + FIX_HEARTBEAT_LATE_MS)
      ) {
        return this.drop();
      }
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
  attach(
    agentId: string,
    cancel: (notify: boolean) => void,
    descends?: (callerAgentId: string) => boolean,
  ): void {
    this.agentId = agentId;
    this.cancelAgent = cancel;
    this.descends = descends ?? null;
    if (this.done || this.stopRequested) cancel(this.stopNotifies);
  }

  /**
   * Whether a call is this fix's own: its agent's, or an agent's that one
   * started, at any depth, by the registry's parent links (a subagent
   * starts agents through the `agent` tool only: workflows and teammates
   * are the top-level session's). Never the session's, nor an agent the
   * session started.
   */
  ownsCaller(callerAgentId: string | null): boolean {
    if (callerAgentId === null || this.agentId === null) return false;
    return (
      callerAgentId === this.agentId || this.descends?.(callerAgentId) === true
    );
  }

  /** Stops the agent; its attempt stays the round's to claim. Its
   * notification is left out when the session's conversation is reset. */
  stop({ notify = true }: { notify?: boolean } = {}): void {
    if (this.ended) return;
    this.stopNotifies &&= notify;
    if (this.cancelAgent) this.cancelAgent(this.stopNotifies);
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
    this.isSettled = true;
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

  /** The round claims the attempt: nothing refreshes or drops it now. The
   * claim waited for the agent to settle already. */
  claim(): void {
    this.finish(false);
  }

  /**
   * Nothing more happens to the attempt: the agent is stopped, and its
   * marker, no longer refreshed, is left to the gate and the next round.
   */
  drop(options: { notify?: boolean } = {}): void {
    if (this.done) {
      // Dropped already, its agent yet to launch: a reset since still
      // keeps the stop it gets as it launches quiet.
      if (options.notify === false) this.stopNotifies = false;
      return;
    }
    this.stop(options);
    this.finish();
    // Stale as soon as its agent has stopped, not 90 seconds later: the
    // helpers then let the next round in, which the gate wakes for it.
    const expire = () => this.expireMarker();
    if (this.agentId === null || this.isSettled) expire();
    else void this.waitSettled(FIX_SETTLE_WAIT_MS).then(expire);
  }

  /** Sets the marker's time far back while it still names this attempt. */
  private expireMarker(): void {
    let fd: number | undefined;
    try {
      fd = openSync(
        this.marker,
        constants.O_RDWR |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > FIX_MARKER_MAX_BYTES) return;
      const marker = JSON.parse(readFileSync(fd, 'utf8')) as {
        attempt?: unknown;
      } | null;
      if (marker?.attempt === this.attempt) futimesSync(fd, 0, 0);
    } catch {
      // Gone, or not this attempt's: nothing to expire.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** A launch that failed after the attempt opened, or while it opened:
   * no round claims it, and its marker goes now. */
  async abandon(options: { notify?: boolean } = {}): Promise<void> {
    this.stop(options);
    this.finish();
    await this.grant.close(this.attempt).catch(() => {});
  }

  private finish(settles = true): void {
    // Its agent stopped, maybe not settled: whoever acts on the worktree
    // next waits for it a while (`settleBackgroundFix`).
    if (settles && !this.done && this.agentId !== null && !this.isSettled) {
      this.settleBy = Date.now() + FIX_SETTLE_WAIT_MS;
      settling.set(this.worktree, this);
      const forget = () => {
        if (settling.get(this.worktree) === this)
          settling.delete(this.worktree);
      };
      void this.settled.then(forget);
      setTimeout(forget, FIX_SETTLE_WAIT_MS).unref?.();
    }
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
// Attempts that ended, whose stopped agents have not settled yet.
const settling = new Map<string, BackgroundFix>();

/** A live attempt, or none: one whose refresh is late is dropped first —
 * after a sleep, the gate may find its marker stale before its timer runs. */
function live(fix: BackgroundFix | undefined): BackgroundFix | undefined {
  if (fix?.isLate()) fix.drop();
  return fix?.done ? undefined : fix;
}

/**
 * Before a caller acts on a worktree, or on the session's PR: drops an
 * attempt there whose refresh is late, and waits (at most
 * `FIX_SETTLE_WAIT_MS` from when it ended) for the stopped agent of any
 * attempt there that ended — dropped by its heartbeat, its deadline or a
 * revoked grant — to settle: what the caller does next acts on the worktree
 * that agent was writing in.
 */
export async function settleBackgroundFix(
  where: { worktree: string } | { pr: number } | { within: string },
): Promise<void> {
  // By the PR alone: another session of this process acting on it waits
  // too, and a PR of that number in another clone costs a wait at most.
  const at = (map: Map<string, BackgroundFix>) =>
    'worktree' in where
      ? map.get(canonicalWorktreePath(where.worktree))
      : 'within' in where
        ? containing(map, where.within)
        : [...map.values()].find((f) => f.pr === where.pr);
  const fix = at(fixes);
  if (fix?.isLate()) fix.drop();
  const ended = at(settling);
  if (!ended) return;
  await ended.waitSettled(Math.max(0, ended.settleBy - Date.now()));
  // Waited for: what the caller does next is no longer held up by it.
  if (settling.get(ended.worktree) === ended) settling.delete(ended.worktree);
}

/** The attempt whose agent works, or whose round has yet to claim it, at a
 * worktree — of any session of this process. */
export function backgroundFixAt(worktree: string): BackgroundFix | undefined {
  return live(fixes.get(canonicalWorktreePath(worktree)));
}

/**
 * A path as the kernel resolves it: segment by segment, each link followed
 * (a dangling one too) before a `..` after it applies, the missing tail
 * kept as written.
 */
function canonicalPathOf(file: string): string {
  // Not `path.resolve`: it drops `link/..` as text, where the kernel goes
  // through the link first.
  const absolute = path.isAbsolute(file)
    ? file
    : `${process.cwd()}${path.sep}${file}`;
  const { root } = path.parse(absolute);
  const pending = segmentsOf(absolute.slice(root.length));
  let current = root;
  for (let hops = 0; pending.length > 0; ) {
    const segment = pending.shift()!;
    if (segment === '.') continue;
    if (segment === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, segment);
    let target: string | null = null;
    try {
      if (lstatSync(next).isSymbolicLink() && hops++ < 40) {
        target = readlinkSync(next);
      }
    } catch {
      // Missing: kept as written.
    }
    if (target === null) {
      current = next;
      continue;
    }
    // The link's target as written, then what came after it: from its own
    // root when absolute, else from the directory holding the link.
    if (path.isAbsolute(target)) {
      const { root: linkRoot } = path.parse(target);
      current = linkRoot;
      pending.unshift(...segmentsOf(target.slice(linkRoot.length)));
    } else {
      pending.unshift(...segmentsOf(target));
    }
  }
  // In the file system's own case, through the deepest part that exists.
  const rest: string[] = [];
  for (let dir = current; ; dir = path.dirname(dir)) {
    try {
      return path.join(realpathSync.native(dir), ...rest.reverse());
    } catch {
      if (path.dirname(dir) === dir) return current;
      rest.push(path.basename(dir));
    }
  }
}

/** A path's names, split where this platform separates them: a backslash
 * is a character of a name outside Windows. */
function segmentsOf(p: string): string[] {
  return p
    .split(process.platform === 'win32' ? /[\\/]+/ : /\/+/)
    .filter(Boolean);
}

/**
 * The attempt whose worktree holds `file` (the worktree itself, or a path
 * in it), for a caller other than its own agent: what such a caller writes
 * there, the YOLO agent goes on building and running without asking.
 */
export function backgroundFixHolding(
  file: string,
  callerAgentId: string | null,
): BackgroundFix | undefined {
  if (fixes.size === 0 && settling.size === 0) return undefined;
  // Before the agent attaches, it has no id: no caller is it.
  const notItsAgent = (fix: BackgroundFix) => !fix.ownsCaller(callerAgentId);
  const running = containing(fixes, file, notItsAgent);
  // One found late is dropped here, into `settling`: looked up there next.
  const held = running ? live(running) : undefined;
  if (held) return held;
  // One whose stopped agent may still be writing there.
  return containing(settling, file, notItsAgent);
}

/** The fix of `map` whose worktree holds `file` (and that `accept` takes). */
function containing(
  map: Map<string, BackgroundFix>,
  file: string,
  accept: (fix: BackgroundFix) => boolean = () => true,
): BackgroundFix | undefined {
  if (map.size === 0) return undefined;
  // As the kernel resolves it, and as Windows does, which drops `x\\..` as
  // text before it opens the file: inside either way is inside.
  const targets = [canonicalPathOf(file), canonicalPathOf(path.resolve(file))];
  for (const fix of map.values()) {
    const inside = targets.some((target) => {
      const rel = path.relative(fix.worktree, target);
      // `..foo` is a name inside it, not its parent.
      return (
        rel === '' ||
        (rel !== '..' &&
          !rel.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(rel))
      );
    });
    if (inside && accept(fix)) return fix;
  }
  return undefined;
}

export function backgroundFixOf(
  sessionId: string,
  pr: number,
): BackgroundFix | undefined {
  for (const fix of fixes.values()) {
    if (fix.sessionId === sessionId && fix.pr === pr) return live(fix);
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
  // Ended while the helper ran: the grant went (the fix asks again), or
  // the session.
  if (fix.done) {
    await fix.abandon();
    throw new Error(`no fix of ${worktree} runs without asking`);
  }
  // The task the state file names is the one this session scheduled, or
  // the watch is no longer the one its rounds run.
  if (opened.task !== task.task) {
    await fix.abandon();
    throw new Error(
      `PR #${grant.pr}'s watch is no longer driven by the task this session scheduled`,
    );
  }
  fix.startHeartbeat();
  return fix;
}
