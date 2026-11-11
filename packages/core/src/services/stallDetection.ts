/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stall detection for background shell commands.
 *
 * Monitors output file growth
 * and fires a one-shot `<task-notification>` (priority: 'next') when the output
 * stops growing for STALL_THRESHOLD_MS and the tail looks like an interactive
 * prompt the model can act on.
 *
 * Key differences from completion notifications:
 * - Priority 'next' (more urgent than completion's 'later')
 * - NO <status> tag in the XML (prevents SDK emitter from treating it as terminal)
 * - Appends last output + remediation hint after the XML block
 */

import { stat } from 'node:fs/promises';
import { tailFile } from '../utils/fsOperations.js';
import { BACKGROUND_BASH_SUMMARY_PREFIX } from '../constants/xmlTags.js';
import { enqueuePendingNotification } from './messageQueueManager.js';
import { buildTaskNotificationXml } from './taskNotification.js';

// ============================================================================
// Constants
// ============================================================================

/** How often (ms) to check whether output has stalled. */
export const STALL_CHECK_INTERVAL_MS = 5_000;

/** How long (ms) output must be stagnant before we inspect the tail. */
export const STALL_THRESHOLD_MS = 45_000;

/** Number of bytes to read from the end of the output file for prompt detection. */
export const STALL_TAIL_BYTES = 1024;

// ============================================================================
// Prompt detection
// ============================================================================

/**
 * Last-line patterns that suggest a command is blocked waiting for keyboard
 * input. We stay silent on commands that are merely slow (git log -S, long
 * builds) and only notify when the tail looks like an interactive prompt the
 * model can act on.
 */
const PROMPT_PATTERNS = [
  /\(y\/n\)/i, // (Y/n), (y/N)
  /\[y\/n\]/i, // [Y/n], [y/N]
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i, // directed questions
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
];

/**
 * Returns true if the last non-empty line of `tail` matches one of the known
 * interactive-prompt patterns.
 */
export function looksLikePrompt(tail: string): boolean {
  const lastLine = tail.trimEnd().split('\n').pop() ?? '';
  return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

// ============================================================================
// Stall watchdog
// ============================================================================

/**
 * Start a periodic watchdog that monitors a background command's output file.
 *
 * If output stops growing for {@link STALL_THRESHOLD_MS} and the tail looks
 * like an interactive prompt, a one-shot `<task-notification>` is enqueued
 * with `priority: 'next'`.
 *
 * @param options - Public task identity, output path, description, and queue routing.
 * @returns A cancel function that stops the watchdog immediately.
 */
export interface StallWatchdogOptions {
  taskId: string | number;
  outputPath: string;
  description: string;
  toolUseId?: string;
  targetAgentId?: string;
  sessionId?: string;
  customContext?: Readonly<Record<string, string>>;
}

export function startStallWatchdog({
  taskId,
  outputPath,
  description,
  toolUseId,
  targetAgentId,
  sessionId,
  customContext,
}: StallWatchdogOptions): () => void {
  let lastSize = 0;
  let lastGrowth = Date.now();
  let cancelled = false;

  const timer = setInterval(() => {
    void stat(outputPath).then(
      (s) => {
        if (cancelled) return;

        if (s.size > lastSize) {
          lastSize = s.size;
          lastGrowth = Date.now();
          return;
        }

        if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) return;

        void tailFile(outputPath, STALL_TAIL_BYTES).then(
          ({ content }) => {
            if (cancelled) return;

            if (!looksLikePrompt(content)) {
              // Not a prompt — keep watching. Reset so the next check is
              // STALL_THRESHOLD_MS out instead of re-reading the tail on every tick.
              lastGrowth = Date.now();
              return;
            }

            // Latch before the async-boundary-visible side effects so an
            // overlapping tick's callback sees cancelled=true and bails.
            cancelled = true;
            clearInterval(timer);

            const summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" appears to be waiting for interactive input`;

            // No status field — statusless notifications are treated as
            // progress pings, not terminal signals.
            const xmlBlock = buildTaskNotificationXml({
              taskId,
              outputPath,
              summary,
              toolUseId,
            });

            const message = `${xmlBlock}
Last output:
${content.trimEnd()}

The command is likely blocked on an interactive prompt. Kill this task and re-run with piped input (e.g., \`echo y | command\`) or a non-interactive flag if one exists.`;

            enqueuePendingNotification({
              prompt: message,
              commandMode: 'task-notification',
              priority: 'next',
              targetAgentId,
              sessionId,
              ...(customContext !== undefined ? { customContext } : {}),
            });
          },
          () => {}, // tailFile failed — file may have been removed
        );
      },
      () => {}, // stat failed — file may not exist yet
    );
  }, STALL_CHECK_INTERVAL_MS);

  // Allow the Node.js process to exit even if the timer is still running
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }

  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}
