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
}

export interface LoopTickResult {
  /** Text to deliver to the model in place of the sentinel prompt. */
  modelText: string;
  /** True when the full task block was delivered (vs a short reminder). */
  full: boolean;
  /** Resolved loop.md path, when present — for a clean user-facing label. */
  sourcePath?: string;
}

const TRUNCATION_WARNING = `> WARNING: loop.md was truncated to ${LOOP_TASK_FILE_MAX_BYTES} bytes. Keep the task list concise.`;

const INTRO =
  'The user configured a loop-tasks file. Work through the tasks defined below; these are the instructions for this tick and every subsequent tick (the reminder on later fires refers back to this message).';

// Body of the unchanged-tick reminder — the H1 is supplied by tickHeading() so
// the full block and the short reminder share exactly one heading style.
const SHORT_REMINDER_BODY: Record<LoopMode, string> = {
  cron: 'Work the tasks from the loop.md contents established earlier in this conversation. If you cannot find them, treat this as a no-op tick. The recurring cron fires the next tick automatically — do not call LoopWakeup from this tick.',
  dynamic:
    'Work the tasks from the loop.md contents established earlier in this conversation. If you cannot find them, treat this as a no-op tick. You scheduled this tick via LoopWakeup (not a recurring cron). To keep the loop alive, call LoopWakeup again at the end of this turn with prompt set to the literal sentinel `<<loop.md-dynamic>>` — otherwise the loop ends after this tick.',
};

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

  constructor(private readonly deps: LoopTickResolverDeps) {}

  /** Forget the delivered content so the next fire re-delivers the full block
   * — called when the conversation is compacted (fresh context). */
  resetCache(): void {
    this.#lastContent = null;
    this.#pendingContent = null;
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

    if (this.#lastContent === content) {
      return {
        modelText: `${tickHeading(mode)}\n${SHORT_REMINDER_BODY[mode]}`,
        full: false,
        sourcePath: result.path,
      };
    }

    // Label by which candidate matched, not result.path (the absolute path) —
    // the absolute path would leak the OS username / dir layout to the API
    // provider. It still reaches the caller via sourcePath for local UI use.
    const sourceLabel = SOURCE_LABELS[result.source];
    return {
      modelText: `${tickHeading(mode, { sourceLabel })}\n${INTRO}\n${content}\n${SHORT_REMINDER_BODY[mode]}`,
      full: true,
      sourcePath: result.path,
    };
  }
}
