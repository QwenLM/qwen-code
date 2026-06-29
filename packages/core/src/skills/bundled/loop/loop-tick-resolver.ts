/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { tildeifyPath } from '../../../utils/paths.js';
import {
  LOOP_TASK_FILE_MAX_BYTES,
  readLoopTaskFile,
  type LoopTaskFileSource,
} from './loop-task-file.js';

/**
 * Fire-time resolver for `.qwen/loop.md`-driven loops.
 *
 * A `/loop` whose scheduled prompt is one of these sentinels re-reads loop.md
 * on every fire and gets either the FULL task block (first delivery, or whenever
 * the file changed) or a one-line SHORT reminder (unchanged) — so the task list
 * is paid for once into the cached message-prefix and later ticks stay cheap.
 *
 * Divergence from the upstream design this mirrors: the `lastContent` cache is
 * held per Session instance (not a module singleton) so it scopes to one
 * conversation and resets cleanly with that conversation's context (compaction).
 * Change-detection is full content equality, not mtime/hash, so edit and
 * delete→recreate both re-expand for free.
 */

export const LOOP_SENTINEL_CRON = '<<loop.md>>';
export const LOOP_SENTINEL_DYNAMIC = '<<loop.md-dynamic>>';

export type LoopMode = 'cron' | 'dynamic';

export interface LoopTickResolverDeps {
  /** Pass `config.getWorkingDir()` — loop.md is resolved against the cwd. */
  projectRoot: string;
  /** Home-candidate confinement root: `$QWEN_HOME` when set, else `$HOME`. */
  homeDir: string;
  /**
   * QWEN_HOME-aware global dir holding the home `loop.md` (`Storage.getGlobalQwenDir()`).
   * Omitted → defaults to `<homeDir>/.qwen` inside readLoopTaskFile.
   */
  homeQwenDir?: string;
  /**
   * Pass `() => config.isTrustedFolder()`. Re-evaluated on every `resolve()`,
   * never captured once: `isTrustedFolder()` is not process-stable in IDE
   * sessions (a workspace-trust update can flip it), and a trusted→untrusted
   * flip must immediately stop reading the repo-controlled project
   * `.qwen/loop.md` (the user-owned `~/.qwen/loop.md` still is read).
   */
  allowProjectFile: () => boolean;
}

export interface LoopTickResult {
  /** Text to deliver to the model in place of the sentinel prompt. */
  modelText: string;
  /** True when the full task block was delivered (vs a short reminder). */
  full: boolean;
  /** Non-absolute label for the matched candidate (e.g. "project loop.md"),
   * when present — safe for logs/UI that must not leak the absolute path, and
   * doubles as the "a loop.md was found" flag for callers. */
  sourceLabel?: string;
  /** True ONLY for buildTransientErrorTick: a loop.md exists but could not be
   * read THIS tick (a transient EACCES/EIO or editor/AV lock), as distinct from
   * the genuinely-absent no-op (where this stays false). Lets the caller's echo
   * say "temporarily unavailable" instead of "not present". Carries no errno or
   * path — those stay in the modelText note and LOCAL debug logs only. */
  transientError?: boolean;
  /** True when this tick is an autonomous-mode tick (a `<<autonomous-loop*>>`
   * fire, or a loop.md sentinel whose file is gone and has converged on the
   * autonomous preamble). Lets the caller's echo label it distinctly. */
  autonomous?: boolean;
}

const TRUNCATION_WARNING = `> WARNING: loop.md was truncated to ${LOOP_TASK_FILE_MAX_BYTES} bytes. Keep the task list concise.`;

const INTRO =
  'The user configured a loop-tasks file. Work through the tasks defined below; these are the instructions for this tick and every subsequent tick (the reminder on later fires refers back to this message).';

// Mode-specific pacing guidance. Appended to BOTH the full block and the short
// reminder — the no-op/re-arm instruction applies on every tick.
const PACING_SUFFIX: Record<LoopMode, string> = {
  cron: 'The recurring cron fires the next tick automatically — do not call LoopWakeup from this tick.',
  dynamic: `You scheduled this tick via LoopWakeup (not a recurring cron). To keep the loop alive, call LoopWakeup again at the end of this turn with prompt set to the literal sentinel \`${LOOP_SENTINEL_DYNAMIC}\` — otherwise the loop ends after this tick.`,
};

// Preamble for the UNCHANGED-tick reminder, which points back to the full block
// delivered on an earlier fire. NOT used on the first/changed full delivery,
// where the block is present in THIS message — there is no "earlier" to refer
// back to, so claiming the contents were established earlier would contradict
// the INTRO that sits right above them.
const SHORT_REMINDER_PREAMBLE =
  'Work the tasks from the loop.md contents established earlier in this conversation. If you cannot find them, treat this as a no-op tick.';

/**
 * The single H1 for every tick variant (full block, short reminder, absent), so
 * they share one heading style and the dynamic-pacing suffix lives in one place.
 * `sourceLabel` (set only on a full-block delivery) is a relative label like
 * "project loop.md", never the absolute path — so the resolved file location
 * isn't leaked to the model/API provider.
 */
function tickHeading(
  mode: LoopMode,
  opts: { sourceLabel?: string; absent?: boolean; unavailable?: boolean } = {},
): string {
  // `unavailable` (transient read failure) is distinct from `absent`: the file
  // exists but couldn't be read THIS tick, so the heading must not claim it's gone.
  const subject = opts.unavailable
    ? 'loop.md unavailable'
    : opts.absent
      ? 'loop.md absent'
      : opts.sourceLabel
        ? `loop.md tasks from ${opts.sourceLabel}`
        : 'loop.md tasks';
  const base = `# /loop tick — ${subject}`;
  return mode === 'dynamic' ? `${base} (dynamic pacing)` : base;
}

/** Model-safe relative label per source — exhaustive, so a new loop.md
 * candidate added to readLoopTaskFile won't compile until it gets a label
 * (rather than silently mislabelling it). */
const SOURCE_LABELS: Record<LoopTaskFileSource, string> = {
  project: 'project loop.md',
  home: 'home loop.md',
};

// Per-mode tail for a TRANSIENT-failure no-op tick (buildTransientErrorTick):
// "treat this as a no-op" + the mode's re-arm. A genuinely-absent loop.md does
// NOT use this — it converges on absentAutonomousTickText (run the autonomous
// check, not a no-op).
const ABSENT_TAIL: Record<LoopMode, string> = {
  cron: 'Treat this as a no-op tick; the recurring cron fires the next tick automatically.',
  dynamic: `Treat this as a no-op tick. To pick it up if it is recreated, call LoopWakeup again with prompt set to the literal sentinel \`${LOOP_SENTINEL_DYNAMIC}\` — otherwise the loop ends after this tick.`,
};

/** Detect whether a scheduled prompt is a loop.md sentinel, and which mode. */
export function detectLoopSentinel(prompt: string): LoopMode | null {
  const trimmed = prompt.trim();
  if (trimmed === LOOP_SENTINEL_DYNAMIC) {
    return 'dynamic';
  }
  if (trimmed === LOOP_SENTINEL_CRON) {
    return 'cron';
  }
  return null;
}

// Autonomous-mode sentinels — the twins of the loop.md sentinels. A bare `/loop`
// arms one of these instead of a prompt; at fire time they expand to the
// autonomous preamble rather than file content.
export const AUTONOMOUS_SENTINEL_CRON = '<<autonomous-loop>>';
export const AUTONOMOUS_SENTINEL_DYNAMIC = '<<autonomous-loop-dynamic>>';

// Stored in #lastContent once the autonomous preamble has been delivered, so a
// later autonomous (or absent-loop.md) fire sends only the short tick. Real
// loop.md content effectively never equals this dunder marker, so a recreated
// loop.md re-delivers its full block; the sole adversarial collision — a file
// whose entire content IS this string — merely fails safe (it suppresses a
// preamble, never injects one).
const AUTONOMOUS_PREAMBLE_MARKER = '__autonomous_preamble__';

/** Detect whether a scheduled prompt is an autonomous-loop sentinel, and which
 * pacing mode. Parallel to detectLoopSentinel. */
export function detectAutonomousSentinel(prompt: string): LoopMode | null {
  const trimmed = prompt.trim();
  if (trimmed === AUTONOMOUS_SENTINEL_DYNAMIC) {
    return 'dynamic';
  }
  if (trimmed === AUTONOMOUS_SENTINEL_CRON) {
    return 'cron';
  }
  return null;
}

// Shared self-paced re-arm instruction; the loop.md and autonomous dynamic ticks
// differ only in the sentinel the model re-arms with, so build both from one
// template to keep them in lockstep.
const keepAliveRearm = (
  sentinel: string,
  reason = 'To keep the loop alive',
): string =>
  `You scheduled this tick via LoopWakeup (not a recurring cron). ${reason}, call LoopWakeup again at the end of this turn with prompt set to the literal sentinel \`${sentinel}\` — otherwise the loop ends after this tick.`;

// Re-arm guidance for a pure autonomous tick (cron reuses the loop.md pacing;
// dynamic re-arms with the autonomous sentinel).
const AUTONOMOUS_REARM: Record<LoopMode, string> = {
  cron: PACING_SUFFIX.cron,
  dynamic: keepAliveRearm(AUTONOMOUS_SENTINEL_DYNAMIC),
};

// Re-arm guidance for an absent-loop.md tick that has converged on autonomous
// mode: re-arm the LOOP.MD sentinel (not the autonomous one) so a recreated file
// is picked up on the next fire.
const ABSENT_AUTONOMOUS_REARM: Record<LoopMode, string> = {
  cron: PACING_SUFFIX.cron,
  dynamic: keepAliveRearm(
    LOOP_SENTINEL_DYNAMIC,
    'To pick up loop.md if it is recreated',
  ),
};

/** The short tick text for a pure autonomous fire (no loop.md). The full
 * preamble is prepended only on the first delivery (see #autonomousTick). */
function autonomousTickText(mode: LoopMode): string {
  const heading = `# Autonomous loop tick${mode === 'dynamic' ? ' (dynamic pacing)' : ''}`;
  return `${heading}\nRun the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick. ${AUTONOMOUS_REARM[mode]}`;
}

/** The tick text for an absent loop.md that converges on autonomous mode — like
 * a pure autonomous tick but headed "loop.md absent" and re-arming the loop.md
 * sentinel so a recreated file is picked up. It says "run the autonomous check",
 * NOT an unconditional no-op: the no-op wording would contradict the preamble
 * prepended on the first fire (and the dedup tick that follows it). */
function absentAutonomousTickText(mode: LoopMode, locations: string): string {
  return `${tickHeading(mode, { absent: true })}\nloop.md is not currently present at ${locations}. Run the autonomous check using the loop instructions established earlier in this conversation. ${ABSENT_AUTONOMOUS_REARM[mode]}`;
}

// The autonomous-loop preamble (the upstream default "steward / stop-when-quiet"
// variant, ported verbatim; pacing/re-arm lives in the per-mode tick text, not
// here). Delivered once on the first autonomous fire, then deduped.
const AUTONOMOUS_PREAMBLE = `# Autonomous loop check
You're being invoked on a timer while the user is away or occupied. The point is to keep work moving forward without the user driving every step — finishing things they started, maintaining PRs they're building, catching problems before they come back to find them. You're a steward, not an initiator. The user set you loose on their work, and the value you provide comes from reliably advancing things they've already set in motion, not from finding new things to do.
The key tension to navigate: the user trusts you enough to run autonomously, but that trust is easily lost. Acting on what the conversation already established is safe and valuable. Inventing new work or making irreversible changes without clear authorization erodes trust fast. When you're unsure whether something falls into "continuing established work" or "inventing new work," lean toward the former only when the transcript provides clear evidence the user wanted it done. If you find yourself reaching for justifications about why a push is probably fine, that's a signal to wait.
## What to act on
The current conversation is your highest-signal source — re-read the transcript above, since everything there is something the user was actively engaged with. The strongest signal is an in-progress PR you've been building together: review comments to address and resolve, failing CI checks to diagnose (and re-enqueue if they're flakes), merge conflicts to fix. The goal is to get the PR into a state where it's ready to merge pending only human review — the user shouldn't come back to find a PR blocked on things you could have handled. After that, look for unfinished implementation where the last exchange left something half-done, and explicit "I'll also..." or "next I'll..." commitments the conversation made and didn't honor. Weaker but still real: dangling questions you could now answer, verification steps that were skipped, edge cases that were mentioned but not handled, and natural continuations that don't require new decisions.
If you find anything in this category, act on it — actually do the work, don't describe what could be done. Run the tests, don't say "you could run the tests." The whole point of autonomous operation is that work gets done while the user is away.
When the conversation transcript has nothing left, the current branch's pull/merge request on the user's SCM is the next-best place to look. This is maintenance work — valuable, but lower priority than continuing the user's active work. Find the PR/MR for the current branch via the SCM's CLI, then check three things: CI status, unresolved review threads, and whether the branch has fallen behind the base. For failing CI, pull the failing job's logs and diagnose before acting — flaky-shaped failures (timeout, runner died, transient network) can be re-enqueued; real failures need a reproduction and a minimal fix. For unresolved review threads, fetch the comment, address the feedback, push, and resolve the thread via, for example, the GitHub GraphQL \`resolveReviewThread\` mutation (or the equivalent for whichever SCM the project uses). Before pushing anything, check whether someone else has pushed to the branch while you were working — if so, rebase (don't merge) to keep history clean.
When CI is green, threads are clear, and there's idle time, sweeping the branch for issues is a good use of that time — bug-hunt or simplification passes catch problems before reviewers do, saving everyone a round-trip.
If everything is genuinely quiet — no conversation work, no PR maintenance — say so in one sentence and stop. No summary of what you checked, no list of what you might do later. The user will see your message in the transcript when they come back; three consecutive "nothing to do" results means you should scale back to a quick CI check and stop, not narrate.
## Repeated invocations
If you see earlier autonomous checks in this conversation, adjust your scope accordingly. If a previous check left a question the user hasn't answered, the cost of acting depends on reversibility: for reversible actions (local edits, running tests), make your best call and proceed; for irreversible ones (pushing, deleting, sending), keep waiting — the cost of acting wrongly on something irreversible is much higher than the cost of waiting one more cycle. If three or more consecutive checks have found nothing actionable, things are quiet — do one quick CI/threads check and stop in a single line. Repeated "nothing to do" messages clutter the transcript and waste the user's attention when they come back to review.
Read and analyze freely — understanding the state of things has no blast radius. Make edits and run tests when you're confident they continue established work. Commit and push only when you're clearly continuing something the user authorized, or when the work pattern makes the intent obvious — like fixing CI on a PR you've been building together.`;

/** Trim a truncated body back to its last full line before the warning tail. */
function cutToLastNewline(content: string): string {
  const cut = content.lastIndexOf('\n');
  // `> 0`, not `>= 0`: when the only newline is at index 0 (or there is none),
  // there is no complete line to keep, so cutting would empty the body and leave
  // the INTRO promising tasks that aren't there. Keep the (truncated) content
  // instead — only a genuine trailing partial line (newline at index > 0) is
  // dropped so the warning never glues onto a half-line.
  return cut > 0 ? content.slice(0, cut) : content;
}

export class LoopTickResolver {
  // What the model has actually received. Drives full-vs-reminder detection.
  #lastContent: string | null = null;
  // The most recent resolve()'s content, committed to #lastContent only once
  // the caller confirms it reached the model (markDelivered) — so a tick that
  // is aborted between resolve() and delivery can't poison the cache into
  // sending a dangling short reminder next time.
  #pendingContent: string | null = null;
  // Instance-scoped fs.realpath cache for the confinement boundaries, handed to
  // readLoopTaskFile. Tying it to the resolver (a fresh Map per /cd rebuild,
  // cleared by resetCache) keeps the per-tick perf win while staying
  // invalidatable — a module-global cache would pin a stale boundary in a
  // long-lived process after a /cd or symlink re-point.
  readonly #realDirCache = new Map<string, Promise<string>>();

  constructor(private readonly deps: LoopTickResolverDeps) {}

  /** Forget the delivered content so the next fire re-delivers the full block
   * — called when the conversation is compacted (fresh context). */
  resetCache(): void {
    this.#lastContent = null;
    this.#pendingContent = null;
    // A reset may follow a /cd or symlink change, so drop the cached boundary
    // realpaths too and re-resolve them on the next tick.
    this.#realDirCache.clear();
  }

  /** Commit the last resolve()'s content once it has reached the model. */
  markDelivered(): void {
    if (this.#pendingContent !== null) {
      this.#lastContent = this.#pendingContent;
    }
  }

  /** Expand an autonomous tick: the full preamble + tick text on the first
   * delivery, then only the short tick text once the preamble was committed
   * (markDelivered sets #lastContent to the shared marker). Shared by a pure
   * autonomous fire and the absent-loop.md convergence in resolve(), so the
   * preamble is delivered once across both. */
  #autonomousTick(tickText: string): LoopTickResult {
    // Set the marker in BOTH branches (like resolve() sets #pendingContent above
    // its short/full split): the short branch must also refresh it, or a stale
    // value left by a previously-aborted full tick would be committed by the next
    // markDelivered() and poison a later fire into a dangling short reminder.
    this.#pendingContent = AUTONOMOUS_PREAMBLE_MARKER;
    if (this.#lastContent === AUTONOMOUS_PREAMBLE_MARKER) {
      return { modelText: tickText, full: false, autonomous: true };
    }
    return {
      modelText: `${AUTONOMOUS_PREAMBLE}\n${tickText}`,
      full: true,
      autonomous: true,
    };
  }

  /** Resolve an autonomous-loop sentinel fire (a bare `/loop`, no loop.md).
   * Synchronous — the preamble is static; only the dedup state is consulted. */
  resolveAutonomous(mode: LoopMode): LoopTickResult {
    return this.#autonomousTick(autonomousTickText(mode));
  }

  /** MODEL-FACING label for the home loop.md location. Mirrors
   * readLoopTaskFile's home candidate (`<homeQwenDir>/loop.md`) so the absent
   * reminder — and the caller's sanitized resolve-error — names the location
   * actually checked (QWEN_HOME-aware), but must NEVER surface a raw absolute
   * path: it flows into model/API text, leaking the host's filesystem layout.
   *   - under $HOME             → tilde-abbreviated `~/.qwen/loop.md`;
   *   - relocated via $QWEN_HOME → the literal `$QWEN_HOME/loop.md`, not the
   *     resolved dir (`tildeifyPath` only abbreviates $HOME, so it's a no-op for
   *     a $QWEN_HOME outside $HOME and would otherwise pass the path through);
   *   - any other out-of-$HOME dir → a generic placeholder, never the path.
   * The real absolute path stays in LOCAL debug logs only. */
  homeLoopLabel(): string {
    const homeQwenDir =
      this.deps.homeQwenDir ?? path.join(this.deps.homeDir, '.qwen');
    const homeLoopPath = path.join(homeQwenDir, 'loop.md');

    const tildeified = tildeifyPath(homeLoopPath);
    if (tildeified !== homeLoopPath) {
      return tildeified;
    }
    // Outside $HOME: tildeifyPath was a no-op. When $QWEN_HOME relocated the
    // global dir (homeQwenDir is its resolved value), report the literal env-var
    // name — never the absolute path. The home candidate is always
    // `<homeQwenDir>/loop.md`, so swap the whole resolved dir for `$QWEN_HOME` and
    // re-attach the separator + basename directly. Deriving the tail from the
    // resolved path's length instead mishandles edge dirs: a trailing slash
    // (`$QWEN_HOME=/x/.qwen/`) over-counts the separator, and a filesystem-root
    // homeQwenDir (`$QWEN_HOME=/` → homeLoopPath `/loop.md`, dirname `/`) drops the
    // leading separator — both garbling the tail into `$QWEN_HOMEloop.md`.
    if (process.env['QWEN_HOME']) {
      return `$QWEN_HOME${path.sep}loop.md`;
    }
    return 'the configured global loop.md';
  }

  /** The checked-candidate "where" string shared by the absent reminder and the
   * caller's sanitized resolve-error. Names the project candidate ONLY when it
   * was actually read (`projectChecked` — a trusted folder), so neither path can
   * claim `.qwen/loop.md (project)` for an untrusted folder where the project
   * file is skipped. The home label is the QWEN_HOME-aware, never-absolute
   * homeLoopLabel(). Single source of truth so the two messages can't drift. */
  absentLocations(projectChecked: boolean): string {
    const homeLabel = this.homeLoopLabel();
    return projectChecked
      ? `.qwen/loop.md (project) or ${homeLabel} (home)`
      : `${homeLabel} (home)`;
  }

  /** A model-facing no-op tick for a loop.md that is unreadable THIS tick (a
   * transient read failure — see buildTransientErrorTick). Clears the
   * change-detection caches so a later successful tick re-delivers the FULL block
   * instead of a dangling short reminder. A genuinely-absent loop.md no longer
   * routes here — it converges on the autonomous preamble in resolve(). */
  #noOpTick(modelText: string, transientError = false): LoopTickResult {
    this.#pendingContent = null;
    if (this.#lastContent !== AUTONOMOUS_PREAMBLE_MARKER) {
      this.#lastContent = null;
    }
    return { modelText, full: false, transientError };
  }

  /**
   * No-op tick for a transient, non-whitelisted read error (EACCES/EIO, or a
   * Windows editor/AV briefly locking loop.md). Mirrors the absent tick — same
   * heading + the mode's re-arm tail (ABSENT_TAIL) — so a `dynamic` loop still
   * re-arms LoopWakeup and survives the hiccup instead of dying silently: its
   * firing wakeup was already consumed by the scheduler, and only the
   * end-of-turn re-arm keeps it alive, so a thrown turn ends the loop forever.
   * `cron` callers don't use this (they re-fire on their own next interval).
   * `projectChecked` is the trust captured for THIS tick (so the named candidate
   * set matches what was probed); `code` is the errno only — never an absolute
   * path — for a brief model-facing note.
   */
  buildTransientErrorTick(
    mode: LoopMode,
    projectChecked: boolean,
    code: string,
  ): LoopTickResult {
    return this.#noOpTick(
      // `unavailable`, not `absent`: the file exists but was unreadable this tick,
      // so the heading mirrors the body instead of contradicting it.
      `${tickHeading(mode, { unavailable: true })}\nloop.md at ${this.absentLocations(
        projectChecked,
      )} could not be read this tick (${code}). ${ABSENT_TAIL[mode]}`,
      // Flag the tick as a transient read failure (file exists, unreadable this
      // tick) so the caller's echo distinguishes it from a genuinely-absent file.
      true,
    );
  }

  /**
   * @param allowProjectFileOverride Trust captured once by the caller for this
   * tick (see LoopTickResolverDeps.allowProjectFile). Threaded in — rather than
   * re-reading the getter here — so the caller's error path can name the SAME
   * candidate set that was probed even if `isTrustedFolder()` flips mid-tick.
   * Omitted by direct callers, who fall back to the per-tick getter.
   */
  async resolve(
    mode: LoopMode,
    allowProjectFileOverride?: boolean,
  ): Promise<LoopTickResult> {
    // Re-read trust per tick (see LoopTickResolverDeps.allowProjectFile): a
    // resolver built while trusted must skip the project file once trust flips.
    // Captured so the absent reminder reflects what was ACTUALLY checked.
    const allowProjectFile =
      allowProjectFileOverride ?? this.deps.allowProjectFile();
    const result = await readLoopTaskFile({
      projectRoot: this.deps.projectRoot,
      homeDir: this.deps.homeDir,
      homeQwenDir: this.deps.homeQwenDir,
      allowProjectFile,
      realDirCache: this.#realDirCache,
    });

    if (result.status === 'missing') {
      // Absent loop.md converges on autonomous mode: prepend the autonomous
      // preamble (once, deduped via the shared marker) so a file-less loop keeps
      // working autonomously instead of no-op'ing forever. The tick text says
      // "run the autonomous check" (NOT an unconditional no-op, which would
      // contradict the prepended preamble) and keeps the loop.md-absent heading +
      // a loop.md-sentinel re-arm so a recreated file is still picked up (its
      // content can never equal the marker, so it re-delivers full).
      return this.#autonomousTick(
        absentAutonomousTickText(mode, this.absentLocations(allowProjectFile)),
      );
    }

    const content = result.truncated
      ? `${cutToLastNewline(result.content)}\n${TRUNCATION_WARNING}`
      : result.content;
    this.#pendingContent = content;

    // Label by which candidate matched, never result.path (the absolute path),
    // which would leak the OS username / dir layout to the API provider and to
    // debug logs. The label alone is enough for the caller's UI and presence
    // check, so the absolute path is not surfaced on the result at all.
    const sourceLabel = SOURCE_LABELS[result.source];

    if (this.#lastContent === content) {
      return {
        modelText: `${tickHeading(mode)}\n${SHORT_REMINDER_PREAMBLE} ${PACING_SUFFIX[mode]}`,
        full: false,
        sourceLabel,
      };
    }

    // First/changed full delivery: INTRO + the block itself, then only the
    // pacing suffix — no "established earlier" preamble, which would contradict
    // the block sitting right here in this same message.
    return {
      modelText: `${tickHeading(mode, { sourceLabel })}\n${INTRO}\n${content}\n${PACING_SUFFIX[mode]}`,
      full: true,
      sourceLabel,
    };
  }
}
