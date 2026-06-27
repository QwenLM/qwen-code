/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

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
  homeDir: string;
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
}

const TRUNCATION_WARNING = `> WARNING: loop.md was truncated to ${LOOP_TASK_FILE_MAX_BYTES} bytes. Keep the task list concise.`;

const INTRO =
  'The user configured a loop-tasks file. Work through the tasks defined below; these are the instructions for this tick and every subsequent tick (the reminder on later fires refers back to this message).';

// Mode-specific pacing guidance. Appended to BOTH the full block and the short
// reminder — the no-op/re-arm instruction applies on every tick.
const PACING_SUFFIX: Record<LoopMode, string> = {
  cron: 'The recurring cron fires the next tick automatically — do not call LoopWakeup from this tick.',
  dynamic:
    'You scheduled this tick via LoopWakeup (not a recurring cron). To keep the loop alive, call LoopWakeup again at the end of this turn with prompt set to the literal sentinel `<<loop.md-dynamic>>` — otherwise the loop ends after this tick.',
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
  opts: { sourceLabel?: string; absent?: boolean } = {},
): string {
  const subject = opts.absent
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

// Body of the absent reminder — the H1 is supplied by tickHeading() so the
// absent tick shares the same heading style as the full block and reminder.
const SHORT_ABSENT_BODY: Record<LoopMode, string> = {
  cron: 'loop.md is not currently present at .qwen/loop.md (project) or ~/.qwen/loop.md (home). Treat this as a no-op tick; the recurring cron fires the next tick automatically.',
  dynamic:
    'loop.md is not currently present at .qwen/loop.md (project) or ~/.qwen/loop.md (home). Treat this as a no-op tick. To pick it up if it is recreated, call LoopWakeup again with prompt set to the literal sentinel `<<loop.md-dynamic>>` — otherwise the loop ends after this tick.',
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

  async resolve(mode: LoopMode): Promise<LoopTickResult> {
    const result = await readLoopTaskFile({
      projectRoot: this.deps.projectRoot,
      homeDir: this.deps.homeDir,
      // Re-read trust per tick (see LoopTickResolverDeps.allowProjectFile): a
      // resolver built while trusted must skip the project file once trust flips.
      allowProjectFile: this.deps.allowProjectFile(),
      realDirCache: this.#realDirCache,
    });

    if (result.status === 'missing') {
      // Absence is itself a state change: clear both caches so a later recreate
      // — even with byte-identical content — re-expands the full block rather
      // than sending a dangling short reminder that points at a block no longer
      // guaranteed to be in context.
      this.#pendingContent = null;
      this.#lastContent = null;
      return {
        modelText: `${tickHeading(mode, { absent: true })}\n${SHORT_ABSENT_BODY[mode]}`,
        full: false,
      };
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
