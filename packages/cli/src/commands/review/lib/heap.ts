/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** V8's heap-limit flag, in the spellings V8 accepts. */
export const MAX_OLD_SPACE_FLAG = '--max[-_]old[-_]space[-_]size';

/**
 * The line V8 prints when a Node process dies of heap exhaustion — `FATAL
 * ERROR: Reached heap limit Allocation failed - JavaScript heap out of
 * memory` and its variants. Anchored on `FATAL ERROR:` so a command that only
 * mentions the phrase is not taken for one that died of it.
 */
const HEAP_BANNER_RE = /FATAL ERROR: [^\n]*JavaScript heap out of memory/;

/** Whether a command's raw output carries V8's heap-exhaustion banner. */
export function heapBannerIn(raw: string): boolean {
  return HEAP_BANNER_RE.test(raw);
}

/**
 * Whether a failed command died of heap exhaustion. Read from
 * `heapExhausted`, which `run()` measures off the UNTRIMMED output — the
 * trimmed `output` can lose the banner to its middle cut when more than its
 * kept tail follows it. Absent means no measurement (an injected result), and
 * the trimmed output is read instead.
 */
export function ranOutOfHeap(r: {
  exitCode: number | null;
  output: string;
  heapExhausted?: boolean;
}): boolean {
  return r.exitCode !== 0 && (r.heapExhausted ?? heapBannerIn(r.output));
}

/**
 * Whether a command was SIGKILLed by something other than its deadline:
 * exit 137 (128 + 9, which npm passes through from the script it ran), or no
 * status at all when the shell around it was the process killed. Most often
 * the kernel's OOM killer or a container's memory cap — the death that
 * prints no heap banner.
 */
export function killedFromOutside(r: {
  exitCode: number | null;
  timedOut: boolean;
}): boolean {
  return !r.timedOut && (r.exitCode === 137 || r.exitCode === null);
}
